/**
 * api.js — Supabase-compatibele adapter voor de eigen REST/MySQL backend.
 *
 * Gebruik: vervang de Supabase CDN-tag in de HTML door:
 *   <script src="api.js"></script>
 *
 * De variabele `sb` is daarna beschikbaar en gedraagt zich als de Supabase JS-client.
 * API_BASE_URL wordt geladen vanuit config.js (moet vóór dit script staan).
 */

// ── Module-level token — één centrale plek, geen closure-problemen ────────────
let _huidigToken = localStorage.getItem('wplaats_token') || null;

function _getToken() { return _huidigToken; }
function _setToken(t) {
  _huidigToken = t || null;
  if (t) localStorage.setItem('wplaats_token', t);
  else   localStorage.removeItem('wplaats_token');
}

// MySQL geeft integer-IDs; de app vergelijkt met strings (onclick="fn('${r.id}')").
// Converteer alle `id` en `*_id` velden naar string zodat === overal werkt.
function _normaliseerIds(v) {
  if (Array.isArray(v)) return v.map(_normaliseerIds);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = (k === 'id' || k.endsWith('_id')) && typeof val === 'number'
        ? String(val)
        : _normaliseerIds(val);
    }
    return out;
  }
  return v;
}

// ── QueryBuilder ─────────────────────────────────────────────────────────────
class QueryBuilder {
  constructor(baseUrl, tabel) {
    this._base       = baseUrl;
    this._tabel      = tabel;
    this._params     = {};
    this._method     = 'GET';
    this._body       = null;
    this._single     = false;
    this._maybeSingle = false;
    this._upsert     = false;
  }

  // Selecteer kolommen
  select(cols = '*') {
    this._params.select = cols;
    return this;
  }

  // Filters
  eq(col, val)    { this._params[`eq_${col}`]    = val;                         return this; }
  neq(col, val)   { this._params[`neq_${col}`]   = val;                         return this; }
  gte(col, val)   { this._params[`gte_${col}`]   = val;                         return this; }
  lte(col, val)   { this._params[`lte_${col}`]   = val;                         return this; }
  ilike(col, val) { this._params[`ilike_${col}`] = val.replace(/%/g, '');       return this; }

  is(col, val) {
    this._params[`is_${col}`] = val === null ? 'null' : val;
    return this;
  }

  not(col, op, val) {
    if (op === 'is' && val === null) {
      this._params[`not_null_${col}`] = '1';
    } else {
      this._params[`neq_${col}`] = val;
    }
    return this;
  }

  in(col, vals) {
    if (!vals || vals.length === 0) return this;
    this._params[`in_${col}`] = vals.join(',');
    return this;
  }

  order(col, opts = {}) {
    this._params.order = col;
    this._params.asc   = opts.ascending === false ? '0' : '1';
    return this;
  }

  limit(n)  { this._params.limit  = n; return this; }
  offset(n) { this._params.offset = n; return this; }

  // Paginering: range(van, tot) → limit + offset
  range(van, tot) {
    this._params.limit  = tot - van + 1;
    this._params.offset = van;
    return this;
  }

  single()      { this._single      = true; return this; }
  maybeSingle() { this._maybeSingle = true; return this; }

  // Mutaties
  insert(data) { this._method = 'POST';   this._body = data;                              return this; }
  update(data) { this._method = 'PATCH';  this._body = data;                              return this; }
  upsert(data) { this._method = 'POST';   this._upsert = true; this._body = Array.isArray(data) ? data : [data]; return this; }
  delete()     { this._method = 'DELETE';                                                 return this; }

  // Thenable: await sb.from('...').select('*')
  then(resolve, reject) {
    return this._uitvoeren().then(resolve, reject);
  }

  async _uitvoeren() {
    const token = _getToken();
    const headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    };

    if (this._single)      this._params.single = '1';
    if (this._maybeSingle) this._params.single = '1';

    let pad = `${this._base}/${this._tabel}`;
    if (this._upsert) pad += '/upsert';

    const qs      = new URLSearchParams(this._params).toString();
    const fullUrl = qs ? `${pad}?${qs}` : pad;

    const opties = { method: this._method, headers };
    if (this._body !== null) opties.body = JSON.stringify(this._body);

    try {
      const res  = await fetch(fullUrl, opties);

      // Token ongeldig/verlopen — backend geeft dan altijd 401 (zie
      // middleware/auth.js). Centraal hier afvangen i.p.v. per aanroepplek:
      // token lokaal wissen en de gebruiker terugsturen naar het
      // inlogscherm, anders blijft de app hangen op een lege/kapotte
      // databalk zonder duidelijke reden. wplaatsSessieVerlopen() wordt
      // gedefinieerd in app.js (plain global script, geen modules, dus pas
      // nodig tegen de tijd dat dit daadwerkelijk aangeroepen wordt).
      if (res.status === 401) {
        _setToken(null);
        localStorage.removeItem('wplaats_monteur');
        if (typeof window.wplaatsSessieVerlopen === 'function') window.wplaatsSessieVerlopen();
      }

      // maybeSingle: geen rij gevonden is geen fout
      if (this._maybeSingle && res.status === 406) {
        return { data: null, error: null };
      }

      const json = await res.json();
      // MySQL geeft integer-IDs terug; de app vergelijkt altijd als string
      // (onclick="fn('${r.id}')"). Normaliseer hier zodat === overal werkt.
      if (json.data != null) json.data = _normaliseerIds(json.data);
      return json;
    } catch (err) {
      return { data: null, error: err.message };
    }
  }
}

// ── ChannelBuilder (SSE-realtime) ────────────────────────────────────────────
class ChannelBuilder {
  constructor(baseUrl, kanaal) {
    this._base    = baseUrl;
    this._kanaal  = kanaal;
    this._luisteraars = [];
    this._sse     = null;
  }

  on(event, filter, callback) {
    this._luisteraars.push({ event, filter, callback });
    return this;
  }

  subscribe(statusCallback) {
    const url = `${this._base}/realtime/subscribe/${encodeURIComponent(this._kanaal)}`;

    const verbind = () => {
      const tok = _getToken();
      this._sse = new EventSource(`${url}?token=${encodeURIComponent(tok)}`);

      this._sse.onopen = () => {
        if (statusCallback) statusCallback('SUBSCRIBED');
      };

      this._sse.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          this._luisteraars.forEach(({ callback }) => callback(payload));
        } catch { /* ping of ongeldig bericht */ }
      };

      this._sse.onerror = () => {
        this._sse.close();
        setTimeout(verbind, 3000);
      };
    };

    // Pas verbinden als token beschikbaar is
    if (_getToken()) {
      verbind();
    } else {
      const wacht = setInterval(() => {
        if (_getToken()) { clearInterval(wacht); verbind(); }
      }, 500);
    }
    return this;
  }

  unsubscribe() {
    if (this._sse) {
      this._sse.close();
      this._sse = null;
    }
  }
}

// ── ApiClient (vervangt `createClient` van Supabase) ────────────────────────
class ApiClient {
  constructor(baseUrl) {
    this._base = baseUrl;

    this.auth = {
      // Inloggen: POST /api/auth/login
      signInWithPassword: async ({ email, password }) => {
        try {
          const res  = await fetch(`${this._base}/auth/login`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email, password }),
          });
          const json = await res.json();

          if (json.token) {
            _setToken(json.token);
            // MySQL geeft integer-ids terug; net als bij .from()-resultaten
            // normaliseren naar strings zodat === overal klopt (bv.
            // r.monteur_id === state.monteur.id in app.js).
            const monteur = _normaliseerIds(json.monteur);
            localStorage.setItem('wplaats_monteur', JSON.stringify(monteur));
            return { data: { user: monteur }, error: null };
          }
          return { data: null, error: { message: json.error } };
        } catch (err) {
          return { data: null, error: { message: err.message } };
        }
      },

      // Sessie controleren (vanuit localStorage)
      getSession: () => {
        const token   = localStorage.getItem('wplaats_token');
        const monteur = _normaliseerIds(JSON.parse(localStorage.getItem('wplaats_monteur') || 'null'));
        if (token && monteur) {
          _setToken(token);
          if (!monteur.auth_user_id) monteur.auth_user_id = monteur.id;
          return { data: { session: { user: monteur } } };
        }
        return { data: { session: null } };
      },

      // Huidige ingelogde gebruiker
      getUser: () => {
        const monteur = _normaliseerIds(JSON.parse(localStorage.getItem('wplaats_monteur') || 'null'));
        if (!monteur || !_getToken()) return { data: { user: null } };
        if (!monteur.auth_user_id) monteur.auth_user_id = monteur.id;
        return { data: { user: monteur } };
      },

      // Uitloggen
      signOut: async () => {
        _setToken(null);
        localStorage.removeItem('wplaats_monteur');
        return { error: null };
      },
    };
  }

  from(tabel) {
    return new QueryBuilder(this._base, tabel);
  }

  channel(naam) {
    return new ChannelBuilder(this._base, naam);
  }

  // Supabase Storage vervangen door eigen upload-endpoint
  get storage() {
    const base = this._base;
    return {
      from: (bucket) => ({
        upload: async (pad, bestand) => {
          const form = new FormData();
          form.append('file', bestand, pad);
          const res  = await fetch(`${base}/upload/${bucket}`, {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${_getToken()}` },
            body:    form,
          });
          return res.json();
        },
        getPublicUrl: (pad) => ({
          data: { publicUrl: `${base.replace('/api', '')}/uploads/${bucket}/${pad}` },
        }),
      }),
    };
  }
}

// ── Initialiseer de client ────────────────────────────────────────────────────
// API_BASE_URL wordt gezet in config.js (bijv. 'http://localhost:3000/api')
const sb = new ApiClient(typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '/api');
