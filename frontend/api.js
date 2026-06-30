/**
 * api.js — Supabase-compatibele adapter voor de eigen REST/MySQL backend.
 *
 * Gebruik: vervang de Supabase CDN-tag in de HTML door:
 *   <script src="api.js"></script>
 *
 * De variabele `sb` is daarna beschikbaar en gedraagt zich als de Supabase JS-client.
 * API_BASE_URL wordt geladen vanuit config.js (moet vóór dit script staan).
 */

// ── QueryBuilder ─────────────────────────────────────────────────────────────
class QueryBuilder {
  constructor(baseUrl, tabel, getToken) {
    this._base     = baseUrl;
    this._tabel    = tabel;
    this._token    = getToken;
    this._params   = {};
    this._method   = 'GET';
    this._body     = null;
    this._single   = false;
    this._upsert   = false;
  }

  // Selecteer kolommen
  select(cols = '*') {
    if (this._method === 'GET') this._params.select = cols;
    else this._params.select = cols; // voor insert(...).select()
    return this;
  }

  // Filter: WHERE kolom = waarde
  eq(col, val)              { this._params[`eq_${col}`]   = val;          return this; }
  neq(col, val)             { this._params[`neq_${col}`]  = val;          return this; }
  gte(col, val)             { this._params[`gte_${col}`]  = val;          return this; }
  lte(col, val)             { this._params[`lte_${col}`]  = val;          return this; }
  ilike(col, val)           { this._params[`ilike_${col}`] = val.replace(/%/g, ''); return this; }

  is(col, val) {
    this._params[`is_${col}`] = val === null ? 'null' : val;
    return this;
  }

  not(col, op, val) {
    // Supabase: .not('artikelcode', 'is', null) → IS NOT NULL
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
  single()  { this._single = true;     return this; }

  // Mutaties
  insert(data) {
    this._method = 'POST';
    this._body   = data;
    return this;
  }

  update(data) {
    this._method = 'PATCH';
    this._body   = data;
    return this;
  }

  upsert(data) {
    this._method = 'POST';
    this._upsert = true;
    this._body   = Array.isArray(data) ? data : [data];
    return this;
  }

  delete() {
    this._method = 'DELETE';
    return this;
  }

  // Thenable: await sb.from('...').select('*')
  then(resolve, reject) {
    return this._uitvoeren().then(resolve, reject);
  }

  async _uitvoeren() {
    const headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${this._token()}`,
    };

    if (this._single) this._params.single = '1';

    let pad = `${this._base}/${this._tabel}`;
    if (this._upsert) pad += '/upsert';

    const qs      = new URLSearchParams(this._params).toString();
    const fullUrl = qs ? `${pad}?${qs}` : pad;

    const opties = { method: this._method, headers };
    if (this._body !== null) opties.body = JSON.stringify(this._body);

    try {
      const res  = await fetch(fullUrl, opties);
      const json = await res.json();
      return json;
    } catch (err) {
      return { data: null, error: err.message };
    }
  }
}

// ── ChannelBuilder (SSE-realtime) ────────────────────────────────────────────
class ChannelBuilder {
  constructor(baseUrl, kanaal, getToken) {
    this._base    = baseUrl;
    this._kanaal  = kanaal;
    this._token   = getToken;
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
      this._sse = new EventSource(`${url}?token=${encodeURIComponent(this._token())}`);

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
        // Herverbind na 3 seconden
        setTimeout(verbind, 3000);
      };
    };

    verbind();
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
    this._base  = baseUrl;
    this._token = null;

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
            this._token = json.token;
            localStorage.setItem('wplaats_token',   json.token);
            localStorage.setItem('wplaats_monteur', JSON.stringify(json.monteur));
            return { data: { user: json.monteur }, error: null };
          }
          return { data: null, error: { message: json.error } };
        } catch (err) {
          return { data: null, error: { message: err.message } };
        }
      },

      // Sessie controleren (vanuit localStorage)
      getSession: () => {
        const token   = localStorage.getItem('wplaats_token');
        const monteur = JSON.parse(localStorage.getItem('wplaats_monteur') || 'null');
        if (token && monteur) {
          this._token = token;
          // Zorg dat auth_user_id gelijk is aan id zodat verwerkSessie werkt
          if (!monteur.auth_user_id) monteur.auth_user_id = monteur.id;
          return { data: { session: { user: monteur } } };
        }
        return { data: { session: null } };
      },

      // Uitloggen
      signOut: async () => {
        this._token = null;
        localStorage.removeItem('wplaats_token');
        localStorage.removeItem('wplaats_monteur');
        return { error: null };
      },
    };
  }

  from(tabel) {
    return new QueryBuilder(this._base, tabel, () => this._token);
  }

  channel(naam) {
    return new ChannelBuilder(this._base, naam, () => this._token);
  }

  // Supabase Storage vervangen door eigen upload-endpoint
  get storage() {
    const base  = this._base;
    const token = () => this._token;
    return {
      from: (bucket) => ({
        upload: async (pad, bestand) => {
          const form = new FormData();
          form.append('file', bestand, pad);
          const res  = await fetch(`${base}/upload/${bucket}`, {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${token()}` },
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

// Herstel token uit vorige sessie
const _opgeslagenToken = localStorage.getItem('wplaats_token');
if (_opgeslagenToken) sb._token = _opgeslagenToken;
