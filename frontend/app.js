// ── PDF.JS WORKER ─────────────────────────────────────────────
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

// ── API CLIENT ────────────────────────────────────────────────
// `sb` wordt geïnitialiseerd in api.js (Supabase-compatibele adapter)
// API_BASE_URL wordt geladen vanuit config.js

// ── STATE ─────────────────────────────────────────────────────
const state = {
  monteur: null,
  reparaties: [],
  afgerondLogs: [],
  activeMod: null,
  demoMode: false,
  onderdelenKleuren: {}, // opdrachtnr → 'oranje'|'rood'|'groen'
  witgoedApparaten: [],  // actieve witgoed claims
  prepApparaten:    [],  // voorraad panel (actief + afgerond vandaag)
};

// ── SUPABASE HELPERS ──────────────────────────────────────────

// Cache zodat dezelfde postcode+landcode niet meerdere keren opgezocht wordt
const _latLngCache = new Map();

// NL-postcodes zijn 4 cijfers + 2 letters (bijv. 1234AB) — GeoNames heeft alleen de 4 cijfers.
// Andere landen (DE=5 cijfers, BE/DK=4 cijfers) worden ongewijzigd opgezocht.
function _normaliseerPostcode(postcode, landcode) {
  const lc = landcode.trim().toUpperCase();
  const rawPc = postcode.trim().toUpperCase();
  const pc = lc === 'NL' ? rawPc.slice(0, 4) : rawPc;
  return { pc, lc, sleutel: `${pc}|${lc}` };
}

async function haalLatLng(postcode, landcode) {
  if (!postcode || !landcode) return null;
  const { pc, sleutel } = _normaliseerPostcode(postcode, landcode);
  if (_latLngCache.has(sleutel)) return _latLngCache.get(sleutel);

  const { data, error } = await sb
    .from('postcodes')
    .select('lat, lng')
    .eq('postcode', pc)
    .maybeSingle();

  const resultaat = (!error && data) ? { lat: +data.lat, lng: +data.lng } : null;
  _latLngCache.set(sleutel, resultaat);
  return resultaat;
}

// Haalt lat/lng op voor meerdere postcode+landcode-paren in zo min mogelijk
// requests (één query per land, via .in('postcode', [...])) i.p.v. één
// losse request per postcode — bij honderden unieke postcodes op een
// pagina-load scheelt dat honderden requests (zie ook de rate-limiter).
async function prefetchLatLng(paren) {
  const perLand = new Map(); // landcode -> Set(genormaliseerde postcode)
  for (const { postcode, landcode } of paren) {
    if (!postcode || !landcode) continue;
    const { pc, lc, sleutel } = _normaliseerPostcode(postcode, landcode);
    if (_latLngCache.has(sleutel)) continue;
    if (!perLand.has(lc)) perLand.set(lc, new Set());
    perLand.get(lc).add(pc);
  }
  if (perLand.size === 0) return;

  await Promise.all([...perLand.entries()].map(async ([lc, pcSet]) => {
    const pcs = [...pcSet];
    const { data } = await sb.from('postcodes').select('postcode, lat, lng').in('postcode', pcs);
    const gevonden = new Set();
    for (const row of data || []) {
      gevonden.add(row.postcode);
      _latLngCache.set(`${row.postcode}|${lc}`, { lat: +row.lat, lng: +row.lng });
    }
    // Ontbrekende postcodes ook cachen (als 'niet gevonden') zodat haalLatLng
    // ze niet alsnog los gaat opvragen.
    for (const pc of pcs) {
      if (!gevonden.has(pc)) _latLngCache.set(`${pc}|${lc}`, null);
    }
  }));
}

// Haversine-formule: afstand in km tussen twee coördinaten
function berekenAfstand(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Geeft afstand in km van klant-postcode tot werkplaats, of null als postcode onbekend is
async function afstandTotWerkplaats(postcode, landcode) {
  const coords = await haalLatLng(postcode, landcode);
  if (!coords) return null;
  return berekenAfstand(coords.lat, coords.lng, WERKPLAATS_LAT, WERKPLAATS_LNG);
}

// Haalt lat/lng op voor alle unieke postcode+landcode combinaties in state.reparaties
// en slaat de afstand (km) op als r.afstand_km op elk reparatie-object.
async function berekenAlleAfstanden() {
  const uniek = new Map();
  for (const r of state.reparaties) {
    if (!r.postcode || !r.landcode) continue;
    const sleutel = `${r.postcode.trim().toUpperCase()}|${r.landcode.trim().toUpperCase()}`;
    if (!uniek.has(sleutel)) uniek.set(sleutel, { postcode: r.postcode, landcode: r.landcode });
  }

  // Alle unieke combinaties in zo min mogelijk requests ophalen (vult de cache)
  await prefetchLatLng([...uniek.values()]);

  // Afstand toewijzen vanuit cache — geen extra DB-calls meer
  for (const r of state.reparaties) {
    const coords = await haalLatLng(r.postcode, r.landcode);
    r.afstand_km = coords ? berekenAfstand(coords.lat, coords.lng, WERKPLAATS_LAT, WERKPLAATS_LNG) : null;
  }
}

// LET OP: deze select-lijst wordt door de backend letterlijk gevolgd — een
// kolom die hier niet in staat, bestaat simpelweg niet op de objecten in
// state.reparaties. Dat gaat stil mis bij insertLog(): een veld met waarde
// `undefined` wordt door JSON.stringify uit de body gegooid, dus de kolom
// belandt niet eens in de INSERT en blijft NULL — zonder foutmelding. Zo
// stond `regelnummer` lange tijd leeg in reparatie_logs (en werd het als
// `1` naar AMF gestuurd via de `?? 1`-fallback in sync.js). Voeg elk veld
// dat ergens gelogd of doorgestuurd wordt hier dus ook echt toe.
async function fetchReparaties() {
  const BATCH = 1000;
  let alles = [];
  let offset = 0;

  while (true) {
    const { data, error } = await sb
      .from('reparaties')
      .select('id, opdrachtnr, regelnummer, opdrachtcode, abonneecode, handeling, klant_naam, klant_nummer, betalercode, artikelcode, artikelomschrijving, merk, model, serienummer, tagnummer, memogeschiedenis, klacht, prioriteit, status, opdrachtstatus, soort, aantal, doorsluizenjn, tagnrscannenjn, werkplaats, productgroep, magazijnlocatie, landcode, organisatie, monteur_id, toegewezen_door, uiterste_datum_afdeling, reden_datum, aangemaakt_op, in_behandeling_op, afgerond_op, postcode, monteurs(naam, initialen)')
      .order('aangemaakt_op', { ascending: false })
      .range(offset, offset + BATCH - 1);

    if (error) throw error;
    alles = alles.concat(data);
    if (data.length < BATCH) break;
    offset += BATCH;
  }

  return alles;
}

async function fetchMonteurs() {
  const { data, error } = await sb
    .from('monteurs')
    .select('*')
    .eq('actief', true)
    .order('naam', { ascending: true });
  if (error) throw error;
  return data;
}

async function updateReparatieStatus(id, data) {
  const { error } = await sb.from('reparaties').update(data).eq('id', id);
  if (error) throw error;
}

// LET OP bij `opdrachtstatus`/`nieuwe_opdrachtstatus` op insertLog()-aanroepen:
// `reparaties` heeft twee statusvelden. `status` (445/465/470/480/500/519/370)
// is onze eigen claim/afrond-workflow — wordt hier meteen bijgewerkt, geen
// sync nodig. `opdrachtstatus` is het losse ERP-veld, alleen ververst door de
// periodieke MSSQL-sync (elke ~20 min in productie) — dus altijd achter de
// feiten aan. `opdrachtstatus`/`nieuwe_opdrachtstatus` in reparatie_logs
// horen daarom bewust bij `r.status` te lezen (vóór/ná-waarde van onze eigen
// status), niet bij `r.opdrachtstatus` — anders loopt de logging tot wel 20
// minuten achter op wat er in de app al gebeurd is.
async function insertLog(data) {
  const { data: row, error } = await sb.from('reparatie_logs').insert(data).select().single();
  if (error) throw error;
  return row;
}

// ── REALTIME ──────────────────────────────────────────────────
let realtimeChannel = null;

let _realtimeHerlaadTimer = null;

function setupRealtime() {
  if (realtimeChannel) realtimeChannel.unsubscribe();

  // Luister naar ALLE wijzigingen in de reparaties tabel (inclusief vanuit Google Cloud sync)
  realtimeChannel = sb.channel('werkplaats-sync')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'reparaties',
    }, () => {
      // Debounce: niet elke rij apart herladen bij bulk-imports vanuit Google Cloud
      clearTimeout(_realtimeHerlaadTimer);
      _realtimeHerlaadTimer = setTimeout(() => laadReparaties(), 400);
    })
    .subscribe();
}

// ── DEMO DATA ─────────────────────────────────────────────────
function getDemoReparaties() {
  const now = Date.now();
  return [
    { id: 'r1', opdrachtnr: '300001', klant_naam: 'Bakkerij De Korst', klant_nummer: 'K-1042', artikelomschrijving: 'Vaatwasser', merk: 'Miele', model: 'G7310', serienummer: 'MG-7310-0041', klacht: 'Wast niet meer af, pomp draait maar water blijft staan.', prioriteit: 'hoog', status: '445', monteur_id: null, monteurs: null, aangemaakt_op: new Date(now - 2*86400000).toISOString() },
    { id: 'r2', opdrachtnr: '300002', klant_naam: 'Fam. Jansen', klant_nummer: 'K-0821', artikelomschrijving: 'Wasmachine', merk: 'Bosch', model: 'Series 6 WAU28P', serienummer: 'BS-WAU-0042', klacht: 'Draait niet meer op centrifuge, trilt extreem.', prioriteit: 'normaal', status: '445', monteur_id: null, monteurs: null, aangemaakt_op: new Date(now - 86400000).toISOString() },
    { id: 'r3', opdrachtnr: '300003', klant_naam: 'Hotel De Waal', klant_nummer: 'K-2201', artikelomschrijving: 'Droger', merk: 'Siemens', model: 'WT47XKH0', serienummer: 'SI-WT47-0043', klacht: 'Droogt slecht, duurt veel te lang.', prioriteit: 'spoed', status: '445', monteur_id: null, monteurs: null, aangemaakt_op: new Date(now - 4*3600000).toISOString() },
    { id: 'r4', opdrachtnr: '300004', klant_naam: 'Fam. El Hajj', klant_nummer: 'K-0554', artikelomschrijving: 'Koelkast', merk: 'Samsung', model: 'RF65A977', serienummer: 'SA-RF65-0044', klacht: 'Vriezer vriest niet meer, koelkast nog wel.', prioriteit: 'hoog', status: '445', monteur_id: null, monteurs: null, aangemaakt_op: new Date(now - 3*86400000).toISOString() },
    { id: 'r5', opdrachtnr: '300005', klant_naam: 'Huisartsenpraktijk Veldhuis', klant_nummer: 'K-3301', artikelomschrijving: 'Magnetron', merk: 'Whirlpool', model: 'W7MW461', serienummer: 'WP-W7MW-0045', klacht: 'Draait helemaal niet meer aan.', prioriteit: 'normaal', status: '445', monteur_id: null, monteurs: null, aangemaakt_op: new Date(now - 86400000).toISOString() },
    { id: 'r6', opdrachtnr: '299998', klant_naam: 'Fam. Peters', klant_nummer: 'K-0711', artikelomschrijving: 'Wasmachine', merk: 'LG', model: 'F4WV508S0', serienummer: 'LG-F4WV-0038', klacht: 'Lekt water via de deur.', prioriteit: 'normaal', status: '465', monteur_id: 'm1', monteurs: { naam: 'Jan de Vries', initialen: 'JV' }, aangemaakt_op: new Date(now - 3*86400000).toISOString(), in_behandeling_op: new Date(now - 2*3600000).toISOString() },
    { id: 'r7', opdrachtnr: '299995', klant_naam: 'Fam. Hoekstra', klant_nummer: 'K-0229', artikelomschrijving: 'Droger', merk: 'Miele', model: 'TCE630WP', serienummer: 'MI-TCE630-0035', klacht: 'Filterlamp knippert, droger stopt halverwege.', prioriteit: 'normaal', status: '519', monteur_id: 'm2', monteurs: { naam: 'Marco Hendriks', initialen: 'MH' }, aangemaakt_op: new Date(now - 7*86400000).toISOString(), afgerond_op: new Date(now - 5*86400000).toISOString() },
    { id: 'r8', opdrachtnr: '299990', klant_naam: 'Fam. Bakker', klant_nummer: 'K-0555', artikelomschrijving: 'Koelkast', merk: 'Samsung', model: 'RS68A8820S9', serienummer: 'SA-RS68-0077', artikelcode: 'DA97-13718B', klacht: 'Koelt niet meer goed, verdamper bevroren.', prioriteit: 'hoog', status: '480', doorsluizenjn: 'J', opdrachtcode: 'REP', monteur_id: 'm1', monteurs: { naam: 'Jan de Vries', initialen: 'JV' }, aangemaakt_op: new Date(now - 2*86400000).toISOString() },
  ];
}

function getDemoMonteurs() {
  return [
    { id: 'm1', naam: 'Jan de Vries',   initialen: 'JV', is_onderdelenbeheerder: true },
    { id: 'm2', naam: 'Marco Hendriks', initialen: 'MH' },
    { id: 'm3', naam: 'Monteur 3', initialen: 'M3' },
    { id: 'm4', naam: 'Monteur 4', initialen: 'M4' },
  ];
}

// ── INIT ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('header-datum').textContent =
    new Date().toLocaleDateString('nl-NL', { weekday:'long', day:'numeric', month:'long' });

  // Bestaande sessie controleren
  const { data: { session } } = await sb.auth.getSession();
  if (session) await verwerkSessie(session.user);
});


async function signIn() {
  const email = document.getElementById('login-email').value.trim();
  const ww    = document.getElementById('login-ww').value;
  const fout  = document.getElementById('login-fout');
  const btn   = document.getElementById('login-btn');

  if (!email || !ww) { fout.textContent = 'Vul e-mail en wachtwoord in'; return; }
  fout.textContent = '';
  btn.textContent  = 'Bezig...';
  btn.disabled     = true;

  const { data, error } = await sb.auth.signInWithPassword({ email, password: ww });

  btn.textContent = 'Inloggen';
  btn.disabled    = false;

  if (error) { fout.textContent = 'Onjuist e-mailadres of wachtwoord'; return; }
  await verwerkSessie(data.user);
}

async function verwerkSessie(user) {
  // `user` is al het volledige monteur-record (komt rechtstreeks terug uit
  // POST /api/auth/login resp. de gecachete sessie) — geen aparte opzoekactie
  // op auth_user_id meer nodig, dat was een restant uit de oude Supabase-opzet.
  if (!user) {
    document.getElementById('login-fout').textContent = 'Account niet gekoppeld. Neem contact op met beheer.';
    await sb.auth.signOut();
    return;
  }
  kiesMontreur(user);
}

function kiesMontreur(m) {
  state.monteur = m;
  document.getElementById('chip-initialen').textContent = m.initialen;
  document.getElementById('chip-naam').textContent = m.naam.split(' ')[0];
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.add('visible');
  if (m.is_admin) document.getElementById('admin-sectie').style.display = '';

  // Werkplaats (open orders)
  if (m.werkplaats_toegang) {
    document.getElementById('tab-open').style.display = '';
  }

  // Witgoed werkplaats
  if (m.witgoed_toegang) {
    document.getElementById('tab-witgoed').style.display = '';
    laadWitgoedApparaten();
  }

  // Onderdelen
  if (m.is_onderdelenbeheerder) {
    document.getElementById('tab-onderdelen').style.display = '';
  }

  // N.o.v.
  if (m.witgoed_voorraadbeheer) {
    document.getElementById('tab-nov').style.display = '';
    laadWitgoedApparaten();
  }

  // Locatie aanpassen
  if (m.locatie_aanpassen) {
    document.getElementById('tab-locatie').style.display = '';
  }

  // Werkvoorbereider
  if (m.werkvoorbereider) {
    document.getElementById('tab-prep').style.display = '';
  }

  // Standaard-tab: eerste zichtbare tab bepalen
  const tabVolgorde = ['open','witgoed','behandeling','afgerond','onderdelen','nov','locatie','prep','config'];
  const eersteTab   = tabVolgorde.find(t => {
    const el = document.getElementById('tab-' + t);
    return el && el.style.display !== 'none';
  }) || 'behandeling';
  switchTab(eersteTab);
  setupRealtime();
  sfHaalOpVanServer().then(() => { updateSfBadge(); renderLists && renderLists(); });
  laadTaalVoorkeur();
  laadOnderdelenKleuren();
  laadReparaties();
  laadOnderdelen();
  laadArtikelVoorraad();
  laadVragensets();
  laadOorzaakcodes();
}

async function laadReparaties() {
  showLoadingInLists();
  let data;
  if (state.demoMode) {
    data = getDemoReparaties();
  } else {
    try {
      data = await fetchReparaties();
      if (!Array.isArray(data)) throw new Error(JSON.stringify(data));
    } catch(e) {
      toast('Fout bij laden: ' + e.message);
      data = [];
    }
  }
  state.reparaties = data;
  await berekenAlleAfstanden();
  await laadAfgerondLogs();
  const { data: hlData } = await sb.from('reparatie_logs').select('reparatie_id').eq('actie', 'regel_toegevoegd');
  handmatigAangemaakteIds = new Set((hlData || []).map(r => r.reparatie_id));
  renderLists();
}

function initAfgerondPeriode() {
  const vandaag = new Date().toISOString().slice(0, 10);
  const van = document.getElementById('afgerond-van');
  const tm  = document.getElementById('afgerond-tm');
  if (van && !van.value) van.value = vandaag;
  if (tm  && !tm.value)  tm.value  = vandaag;
}

function resetAfgerondPeriode() {
  const vandaag = new Date().toISOString().slice(0, 10);
  document.getElementById('afgerond-van').value = vandaag;
  document.getElementById('afgerond-tm').value  = vandaag;
  herlaadAfgerond();
}

async function herlaadAfgerond() {
  await laadAfgerondLogs();
  renderLists();
}

async function laadAfgerondLogs() {
  if (state.demoMode || !state.monteur) return;
  initAfgerondPeriode();
  const vanWaarde = document.getElementById('afgerond-van')?.value;
  const tmWaarde  = document.getElementById('afgerond-tm')?.value;
  const vanDatum  = vanWaarde ? new Date(vanWaarde + 'T00:00:00') : (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
  const tmDatum   = tmWaarde  ? new Date(tmWaarde  + 'T23:59:59') : (() => { const d = new Date(); d.setHours(23,59,59,999); return d; })();
  const { data } = await sb.from('reparatie_logs')
    .select('id, opdrachtnr, opdrachtcode, artikelcode, artikelomschrijving, aantal, monteur_id, monteur_naam, aangemaakt_op, notitie, bestede_tijd_minuten')
    .eq('actie', 'afgerond')
    .eq('monteur_id', state.monteur.id)
    .gte('aangemaakt_op', vanDatum.toISOString())
    .lte('aangemaakt_op', tmDatum.toISOString())
    .order('aangemaakt_op', { ascending: false });
  state.afgerondLogs = data || [];
}

async function refreshApp() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  btn.disabled = true;
  await laadReparaties();
  btn.classList.remove('spinning');
  btn.disabled = false;
  toast('Bijgewerkt');
}

function showLoadingInLists() {
  ['open','behandeling','afgerond'].forEach(t => {
    document.getElementById('list-'+t).innerHTML = '<div class="loader"><div class="spinner"></div>Laden...</div>';
  });
}

// ── RENDER ────────────────────────────────────────────────────
const PRIO_ORDER = { spoed: 0, hoog: 1, normaal: 2, laag: 3 };

// ── Multi-select filter helpers ───────────────────────────────

// Portal-init: verplaats alle panels naar <body> zodat iOS sticky-stacking ze nooit blokkeert
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.ms-panel[data-wrap]').forEach(p => document.body.appendChild(p));
});

function getMsPanel(wrapId) {
  return document.querySelector(`.ms-panel[data-wrap="${wrapId}"]`);
}

function toggleMs(wrapId) {
  const wrap  = document.getElementById(wrapId);
  if (!wrap) return;
  const panel = getMsPanel(wrapId);
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  document.querySelectorAll('.ms-panel.open').forEach(p => p.classList.remove('open'));
  if (!isOpen) {
    const rect = wrap.querySelector('.ms-btn').getBoundingClientRect();
    panel.style.top  = (rect.bottom + 4) + 'px';
    panel.style.left = rect.left + 'px';
    panel.classList.add('open');
  }
}

// Sluit panelen bij klik buiten
document.addEventListener('click', e => {
  if (!e.target.closest('.ms-wrap') && !e.target.closest('.ms-panel')) {
    document.querySelectorAll('.ms-panel.open').forEach(p => p.classList.remove('open'));
  }
});

function maakMultiSelect(wrapId, opties) {
  const huidig = leesMultiSelect(wrapId);
  const panel  = getMsPanel(wrapId);
  if (!panel) return;
  panel.innerHTML = opties.length
    ? opties.map(o => {
        return `<label class="ms-item"><input type="checkbox" value="${esc(o)}" ${huidig.has(o) ? 'checked' : ''} onchange="renderLists()"> ${esc(o)}</label>`;
      }).join('')
    : '<div style="padding:8px 12px;color:var(--muted);font-size:12px">Geen opties</div>';
  updateMsBtn(wrapId);
}

function leesMultiSelect(wrapId) {
  const panel = getMsPanel(wrapId);
  if (!panel) return new Set();
  return new Set([...panel.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value));
}

function updateMsBtn(wrapId) {
  const wrap  = document.getElementById(wrapId);
  const panel = getMsPanel(wrapId);
  if (!wrap || !panel) return;
  const count = panel.querySelectorAll('input[type=checkbox]:checked').length;
  const btn   = wrap.querySelector('.ms-btn');
  if (!btn) return;
  const label = btn.dataset.label;
  btn.textContent = count ? `${label} (${count})` : label;
  btn.dataset.label = label; // herstel na textContent-reset
  btn.classList.toggle('actief', count > 0);
}

function resetAppFilter(prefix) {
  const zoek = document.getElementById(`af-${prefix}-zoek`);
  if (zoek) zoek.value = '';
  ['opdrachtcode','handeling','werkplaats','organisatie','landcode','opdrachtstatus','reden-datum'].forEach(f => {
    const panel = getMsPanel(`ms-${prefix}-${f}`);
    if (!panel) return;
    panel.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = false);
    updateMsBtn(`ms-${prefix}-${f}`);
  });
  renderLists();
}

// Globale naam-lookup: monteur_id → naam, gevuld vanuit state + joins
let _monteurNamen = {};
function bouwMonteurNamen() {
  _monteurNamen = {};
  if (state.monteur?.id) _monteurNamen[state.monteur.id] = state.monteur.naam;
  state.reparaties.forEach(r => {
    if (r.monteur_id && r.monteurs?.naam) _monteurNamen[r.monteur_id] = r.monteurs.naam;
  });
}
function monteurNaamVoor(monteurId, isMijn) {
  if (!monteurId) return '';
  return _monteurNamen[monteurId] || (isMijn ? state.monteur?.naam || 'Jou' : 'Collega');
}

function renderLists() {
  clearSelectie();
  bouwMonteurNamen();
  const mijnId = state.monteur?.id;

  // Behandeling: eigen regels individueel tonen
  const behandeling = state.reparaties.filter(r =>
    !isRegelAfgerond(r) && r.monteur_id === mijnId &&
    r.status !== '480' &&
    (r.status === statusInBehandeling(r) || (r.doorsluizenjn || '').toUpperCase() === 'J')
  );

  // Afgerond: op basis van reparatie_logs (blijft staan ook als status wordt gereset)
  const afgerondLogs = state.afgerondLogs || [];

  // Orders zonder minimaal 1 J-regel worden nergens getoond
  const geldigeOpdrachten = new Set(
    state.reparaties
      .filter(r => (r.doorsluizenjn || '').toUpperCase() === 'J' && !isInstructieRegel(r))
      .map(r => r.opdrachtnr)
  );

  // Open werkplaats: groepeer per opdrachtnr
  // Claimbaar = doorsluizenjn = 'J', niet instructieregel
  const claimbare = new Set(
    state.reparaties
      .filter(r => {
        if (isRegelAfgerond(r))  return false;
        if (isInstructieRegel(r)) return false;
        if (r.status === '480') return false; // Wacht op onderdelen — niet claimbaar
        if (r.monteur_id && r.monteur_id !== mijnId) return false; // geclaimd door iemand anders
        // Standaard claimbaar via status (445/450 = open reparatie, 500 = open levering)
        if ((r.status === statusOpen(r) || r.status === '450') && (r.doorsluizenjn || '').toUpperCase() === 'J') return true;
        // J-regels zonder artikelcode zijn ook claimbaar ongeacht de ERP-status,
        // zolang ze vrij zijn (geen monteur) en niet afgerond.
        if ((r.doorsluizenjn || '').toUpperCase() === 'J' && !r.monteur_id) return true;
        return false;
      })
      .map(r => r.opdrachtnr)
  );

  // Geclaimd door anderen: status in behandeling, monteur is iemand anders
  const geclaimdDoorAnderenNrs = new Set(
    state.reparaties
      .filter(r => r.status === statusInBehandeling(r) && r.monteur_id && r.monteur_id !== mijnId && !isInstructieRegel(r) && geldigeOpdrachten.has(r.opdrachtnr))
      .map(r => r.opdrachtnr)
      .filter(nr => !claimbare.has(nr)) // niet tonen als er nog vrije regels zijn
  );
  const geclaimdGroepen = {};
  state.reparaties
    .filter(r => geclaimdDoorAnderenNrs.has(r.opdrachtnr) && !isInstructieRegel(r))
    .forEach(r => {
      if (!geclaimdGroepen[r.opdrachtnr]) geclaimdGroepen[r.opdrachtnr] = [];
      geclaimdGroepen[r.opdrachtnr].push(r);
    });

  // Verzamel alle werkregels (J én N) van die orders voor weergave
  const groepen = {};
  state.reparaties
    .filter(r => claimbare.has(r.opdrachtnr) && !isInstructieRegel(r))
    .forEach(r => {
      if (!groepen[r.opdrachtnr]) groepen[r.opdrachtnr] = [];
      groepen[r.opdrachtnr].push(r);
    });

  const alleGroepen = Object.values(groepen).sort((a, b) => {
    // Gedeeltelijk geclaimd (alle J-regels bezet) naar onder
    const aGeclaimd = a.filter(r => (r.doorsluizenjn||'').toUpperCase()==='J').every(r => r.monteur_id && r.monteur_id !== mijnId);
    const bGeclaimd = b.filter(r => (r.doorsluizenjn||'').toUpperCase()==='J').every(r => r.monteur_id && r.monteur_id !== mijnId);
    if (aGeclaimd !== bGeclaimd) return aGeclaimd ? 1 : -1;
    // Sorteer op uiterste_datum_afdeling oplopend, nulls onderaan
    const da = a[0].uiterste_datum_afdeling;
    const db = b[0].uiterste_datum_afdeling;
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return new Date(da) - new Date(db);
  });

  // Behandeling groeperen per opdrachtnr (geen instructieregels, alleen geldige orders)
  const behandelingGroepen = {};
  behandeling.filter(r => r.soort !== 'voorraad' && !isInstructieRegel(r) && geldigeOpdrachten.has(r.opdrachtnr)).forEach(r => {
    if (!behandelingGroepen[r.opdrachtnr]) behandelingGroepen[r.opdrachtnr] = [];
    behandelingGroepen[r.opdrachtnr].push(r);
  });
  const behandelingVoorraad = behandeling.filter(r => r.soort === 'voorraad');
  const alleBehandelingGroepen = Object.values(behandelingGroepen).sort((a, b) => {
    const da = a[0].uiterste_datum_afdeling;
    const db = b[0].uiterste_datum_afdeling;
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return new Date(da) - new Date(db);
  });

  // ── Multi-selects vullen (unieke waarden uit data) ──
  const uniek = (groepen, veld) => [...new Set(groepen.flatMap(g => g.map(r => r[veld])).filter(Boolean))].sort();
  // Handeling-waarden splitsen op '+' zodat samengestelde waarden individueel filtreerbaar zijn
  const uniekSplit = (groepen, veld) => [...new Set(
    groepen.flatMap(g => g.flatMap(r => (r[veld] || '').split('+').map(s => s.trim()).filter(Boolean)))
  )].sort();
  // Witgoed: claimbare orders gefilterd op werkplaats === 'witgoed'
  const witgoedGroepen = alleGroepen.filter(g => g.some(r => (r.werkplaats||'').toLowerCase() === 'witgoed'));

  maakMultiSelect('ms-open-opdrachtcode',  uniek(alleGroepen, 'opdrachtcode'));
  maakMultiSelect('ms-open-handeling',     uniekSplit(alleGroepen, 'handeling'));
  maakMultiSelect('ms-open-werkplaats',    uniek(alleGroepen, 'werkplaats'));
  maakMultiSelect('ms-open-organisatie',   uniek(alleGroepen, 'organisatie'));
  maakMultiSelect('ms-open-landcode',      uniek(alleGroepen, 'landcode'));
  maakMultiSelect('ms-open-opdrachtstatus',uniek(alleGroepen, 'opdrachtstatus'));
  maakMultiSelect('ms-open-reden-datum',   uniek(alleGroepen, 'reden_datum'));

  maakMultiSelect('ms-wg-opdrachtcode',   uniek(witgoedGroepen, 'opdrachtcode'));
  maakMultiSelect('ms-wg-handeling',      uniekSplit(witgoedGroepen, 'handeling'));
  maakMultiSelect('ms-wg-organisatie',    uniek(witgoedGroepen, 'organisatie'));
  maakMultiSelect('ms-wg-landcode',       uniek(witgoedGroepen, 'landcode'));
  maakMultiSelect('ms-wg-opdrachtstatus', uniek(witgoedGroepen, 'opdrachtstatus'));
  maakMultiSelect('ms-wg-reden-datum',    uniek(witgoedGroepen, 'reden_datum'));
  maakPrepFilters();
  maakMultiSelect('ms-beh-opdrachtcode',   uniek(alleBehandelingGroepen, 'opdrachtcode'));
  maakMultiSelect('ms-beh-handeling',      uniekSplit(alleBehandelingGroepen, 'handeling'));
  maakMultiSelect('ms-beh-werkplaats',     uniek(alleBehandelingGroepen, 'werkplaats'));
  maakMultiSelect('ms-beh-organisatie',    uniek(alleBehandelingGroepen, 'organisatie'));
  maakMultiSelect('ms-beh-landcode',       uniek(alleBehandelingGroepen, 'landcode'));
  maakMultiSelect('ms-beh-opdrachtstatus', uniek(alleBehandelingGroepen, 'opdrachtstatus'));
  maakMultiSelect('ms-beh-reden-datum',    uniek(alleBehandelingGroepen, 'reden_datum'));

  // Afgerond: bouw groepen alvast voor multi-select opties
  const afGroepen = Object.values((() => {
    const g = {};
    state.reparaties.filter(r => r.monteur_id === mijnId && isRegelAfgerond(r) && !isInstructieRegel(r))
      .forEach(r => { if (!g[r.opdrachtnr]) g[r.opdrachtnr] = []; g[r.opdrachtnr].push(r); });
    return g;
  })());
  maakMultiSelect('ms-af-opdrachtcode',  uniek(afGroepen, 'opdrachtcode'));
  maakMultiSelect('ms-af-handeling',     uniekSplit(afGroepen, 'handeling'));
  maakMultiSelect('ms-af-werkplaats',    uniek(afGroepen, 'werkplaats'));
  maakMultiSelect('ms-af-organisatie',   uniek(afGroepen, 'organisatie'));
  maakMultiSelect('ms-af-landcode',      uniek(afGroepen, 'landcode'));
  maakMultiSelect('ms-af-opdrachtstatus',uniek(afGroepen, 'opdrachtstatus'));
  maakMultiSelect('ms-af-reden-datum',   uniek(afGroepen, 'reden_datum'));

  // ── Filters lezen ──
  const fOpenZoek = (document.getElementById('af-open-zoek')?.value || '').trim().toLowerCase();
  const fBehZoek  = (document.getElementById('af-beh-zoek')?.value  || '').trim().toLowerCase();
  const fAfZoek   = (document.getElementById('af-af-zoek')?.value   || '').trim().toLowerCase();
  const fWgZoek   = (document.getElementById('af-wg-zoek')?.value   || '').trim().toLowerCase();

  const msOpen = {
    opdrachtcode:  leesMultiSelect('ms-open-opdrachtcode'),
    handeling:     leesMultiSelect('ms-open-handeling'),
    werkplaats:    leesMultiSelect('ms-open-werkplaats'),
    organisatie:   leesMultiSelect('ms-open-organisatie'),
    landcode:      leesMultiSelect('ms-open-landcode'),
    opdrachtstatus:leesMultiSelect('ms-open-opdrachtstatus'),
    reden_datum:   leesMultiSelect('ms-open-reden-datum'),
  };
  const msBeh = {
    opdrachtcode:  leesMultiSelect('ms-beh-opdrachtcode'),
    handeling:     leesMultiSelect('ms-beh-handeling'),
    werkplaats:    leesMultiSelect('ms-beh-werkplaats'),
    organisatie:   leesMultiSelect('ms-beh-organisatie'),
    landcode:      leesMultiSelect('ms-beh-landcode'),
    opdrachtstatus:leesMultiSelect('ms-beh-opdrachtstatus'),
    reden_datum:   leesMultiSelect('ms-beh-reden-datum'),
  };
  const msAf = {
    opdrachtcode:  leesMultiSelect('ms-af-opdrachtcode'),
    handeling:     leesMultiSelect('ms-af-handeling'),
    werkplaats:    leesMultiSelect('ms-af-werkplaats'),
    organisatie:   leesMultiSelect('ms-af-organisatie'),
    landcode:      leesMultiSelect('ms-af-landcode'),
    opdrachtstatus:leesMultiSelect('ms-af-opdrachtstatus'),
    reden_datum:   leesMultiSelect('ms-af-reden-datum'),
  };
  const msWg = {
    opdrachtcode:  leesMultiSelect('ms-wg-opdrachtcode'),
    handeling:     leesMultiSelect('ms-wg-handeling'),
    werkplaats:    new Set(),
    organisatie:   leesMultiSelect('ms-wg-organisatie'),
    landcode:      leesMultiSelect('ms-wg-landcode'),
    opdrachtstatus:leesMultiSelect('ms-wg-opdrachtstatus'),
    reden_datum:   leesMultiSelect('ms-wg-reden-datum'),
  };

  const heeftOpenFilter = !!(fOpenZoek || Object.values(msOpen).some(s => s.size > 0));
  const heeftBehFilter  = !!(fBehZoek  || Object.values(msBeh).some(s => s.size > 0));
  const heeftAfFilter   = !!(fAfZoek   || Object.values(msAf).some(s => s.size > 0));
  const heeftWgFilter   = !!(fWgZoek   || Object.values(msWg).some(s => s.size > 0));
  document.getElementById('af-open-reset')?.classList.toggle('actief', heeftOpenFilter);
  document.getElementById('af-beh-reset')?.classList.toggle('actief', heeftBehFilter);
  document.getElementById('af-af-reset')?.classList.toggle('actief', heeftAfFilter);
  document.getElementById('af-wg-reset')?.classList.toggle('actief', heeftWgFilter);

  function groepMatchFilter(groep, zoek, ms) {
    const h = groep[0];
    if (zoek && ![ h.opdrachtnr, h.opdrachtcode, h.artikelcode, h.klant_naam ]
      .some(v => v?.toLowerCase().includes(zoek))) return false;
    if (ms.opdrachtcode.size  && !groep.some(r => ms.opdrachtcode.has(r.opdrachtcode)))   return false;
    if (ms.handeling.size     && !groep.some(r =>
      (r.handeling || '').split('+').map(s => s.trim()).some(d => ms.handeling.has(d)))) return false;
    if (ms.werkplaats.size    && !groep.some(r => ms.werkplaats.has(r.werkplaats)))         return false;
    if (ms.organisatie.size   && !groep.some(r => ms.organisatie.has(r.organisatie)))       return false;
    if (ms.landcode.size      && !groep.some(r => ms.landcode.has(r.landcode)))             return false;
    if (ms.opdrachtstatus.size && !groep.some(r => ms.opdrachtstatus.has(r.opdrachtstatus))) return false;
    if (ms.reden_datum.size   && !groep.some(r => ms.reden_datum.has(r.reden_datum)))      return false;
    return true;
  }

  const gesorteerdGroepen     = pasStandaardFilterToe(alleGroepen).filter(g => groepMatchFilter(g, fOpenZoek, msOpen));
  const behandelingGesorteerd = alleBehandelingGroepen.filter(g => groepMatchFilter(g, fBehZoek, msBeh));

  document.getElementById('count-open').textContent        = gesorteerdGroepen.length;
  document.getElementById('count-behandeling').textContent = Object.keys(behandelingGroepen).length + behandelingVoorraad.length;
  document.getElementById('count-afgerond').textContent    = afgerondLogs.length;

  // Onderdelen count + render
  const onderdelenNrs = new Set(state.reparaties.filter(r => r.status === '480').map(r => r.opdrachtnr));
  const telOndEl = document.getElementById('count-onderdelen');
  if (telOndEl) telOndEl.textContent = onderdelenNrs.size;
  renderOnderdelen();

  const geclaimdLijst = Object.values(geclaimdGroepen).sort((a, b) =>
    (a[0].opdrachtnr > b[0].opdrachtnr ? 1 : -1)
  );
  const geclaimdHTML = geclaimdLijst.length ? `
    <div style="margin-top:16px;padding-top:4px">
      <div style="font-size:11px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:0 4px 8px">
        Geclaimd door collega's (${geclaimdLijst.length})
      </div>
      ${geclaimdLijst.map(regels => {
        const h = regels[0];
        const monteurs = [...new Set(regels.filter(r => r.monteurs?.naam).map(r => r.monteurs.naam))].join(', ');
        const werkRegels = regels.filter(r => (r.doorsluizenjn||'').toUpperCase() === 'J');
        const extraWerk  = regels.filter(r => isInstructieRegel(r));
        return `<div style="background:#fff;border:1px solid var(--border);border-left:3px solid var(--muted);border-radius:var(--r);margin-bottom:8px;padding:10px 14px;opacity:.75">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-family:var(--mono);font-size:12px;font-weight:600">${esc(h.opdrachtnr)}</span>
            <span style="font-size:11px;color:var(--muted)">${esc(h.opdrachtcode) || ''}</span>
          </div>
          ${werkRegels.map(r => `<div style="font-size:12px;color:var(--muted);display:flex;gap:8px;align-items:baseline">
            ${r.artikelcode ? `<span style="font-family:var(--mono);font-weight:600;color:var(--text);font-size:11px">${esc(r.artikelcode)}</span>` : ''}
            ${r.artikelomschrijving ? `<span>${esc(r.artikelomschrijving)}</span>` : ''}
            ${r.aantal != null ? `<span style="font-family:var(--mono);font-size:10px">×${r.aantal}</span>` : ''}
          </div>`).join('')}
          ${extraWerk.length ? `<div style="font-size:11px;color:var(--info);margin-top:3px">${extraWerk.map(r => esc(r.artikelomschrijving || r.klacht || '')).join(', ')}</div>` : ''}
          <div style="font-size:11px;color:var(--muted);margin-top:6px;display:flex;align-items:center;gap:4px">
            <span style="width:16px;height:16px;border-radius:50%;background:var(--bg3);border:1px solid var(--border);display:inline-flex;align-items:center;justify-content:center;font-size:9px">${esc(regels.find(r=>r.monteurs?.initialen)?.monteurs?.initialen||'?')}</span>
            ${esc(monteurs) || 'Collega'}
          </div>
        </div>`;
      }).join('')}
    </div>` : '';

  const filterWp = (regels, wpSet) => wpSet.size ? regels.filter(r => wpSet.has(r.werkplaats)) : regels;

  const openHTML = gesorteerdGroepen.length
    ? gesorteerdGroepen.map(regels => groepCardHTML(filterWp(regels, msOpen.werkplaats), mijnId, 'open')).join('') + geclaimdHTML
    : emptyHTML(heeftOpenFilter ? 'Geen resultaten voor dit filter' : 'Geen opdrachten in werkplaats') + geclaimdHTML;

  document.getElementById('list-open').innerHTML = openHTML;

  // ── Witgoed tab ──
  if (heeftWitgoedToegang()) {
    const alle = state.witgoedApparaten || [];
    const witgoedGesorteerd = pasStandaardFilterToe(witgoedGroepen)
      .filter(regels => {
        const wRegels = regels.filter(r => (r.doorsluizenjn||'').toUpperCase() === 'J' && !isInstructieRegel(r));
        return wRegels.some(r => {
          const totaal    = parseInt(r.aantal) || 1;
          const actiefCnt = alle.filter(a => a.reparatie_id === r.id && a.status === 'actief').length;
          const afgrndCnt = alle.filter(a => a.reparatie_id === r.id && a.status === 'afgerond').length;
          const nvpCnt    = alle.filter(a => a.reparatie_id === r.id && a.status === 'niet_op_voorraad').length;
          return Math.max(0, totaal - actiefCnt - afgrndCnt - nvpCnt) > 0;
        });
      })
      .filter(g => groepMatchFilter(g, fWgZoek, msWg));
    const wgTelEl = document.getElementById('count-witgoed');
    if (wgTelEl) wgTelEl.textContent = witgoedGesorteerd.length;
    const witgoedGeclaimdLijst = geclaimdLijst.filter(regels => regels.some(r => (r.werkplaats||'').toLowerCase() === 'witgoed'));
    const wgGeclaimdHTML = witgoedGeclaimdLijst.length ? `
      <div style="margin-top:16px;padding-top:4px">
        <div style="font-size:11px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:0 4px 8px">
          Geclaimd door collega's (${witgoedGeclaimdLijst.length})
        </div>
        ${witgoedGeclaimdLijst.map(regels => {
          const h = regels[0];
          const monteurs = [...new Set(regels.filter(r => r.monteurs?.naam).map(r => r.monteurs.naam))].join(', ');
          const werkRegels = regels.filter(r => (r.doorsluizenjn||'').toUpperCase() === 'J');
          return `<div style="background:#fff;border:1px solid var(--border);border-left:3px solid var(--muted);border-radius:var(--r);margin-bottom:8px;padding:10px 14px;opacity:.75">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
              <span style="font-family:var(--mono);font-size:12px;font-weight:600">${esc(h.opdrachtnr)}</span>
              <span style="font-size:11px;color:var(--muted)">${esc(h.opdrachtcode)||''}</span>
            </div>
            ${werkRegels.map(r => `<div style="font-size:12px;color:var(--muted);display:flex;gap:8px;align-items:baseline">
              ${r.artikelcode ? `<span style="font-family:var(--mono);font-weight:600;color:var(--text);font-size:11px">${esc(r.artikelcode)}</span>` : ''}
              ${r.artikelomschrijving ? `<span>${esc(r.artikelomschrijving)}</span>` : ''}
              ${r.aantal != null ? `<span style="font-family:var(--mono);font-size:10px">×${r.aantal}</span>` : ''}
            </div>`).join('')}
            <div style="font-size:11px;color:var(--muted);margin-top:6px;display:flex;align-items:center;gap:4px">
              <span style="width:16px;height:16px;border-radius:50%;background:var(--bg3);border:1px solid var(--border);display:inline-flex;align-items:center;justify-content:center;font-size:9px">${esc(regels.find(r=>r.monteurs?.initialen)?.monteurs?.initialen||'?')}</span>
              ${esc(monteurs)||'Collega'}
            </div>
          </div>`;
        }).join('')}
      </div>` : '';
    const wgListEl = document.getElementById('list-witgoed');
    if (wgListEl) {
      wgListEl.innerHTML = witgoedGesorteerd.length
        ? witgoedGesorteerd.map(regels => witgoedGroepCardHTML(regels, mijnId)).join('') + wgGeclaimdHTML
        : emptyHTML(heeftWgFilter ? 'Geen resultaten voor dit filter' : 'Geen witgoed opdrachten') + wgGeclaimdHTML;
    }
  }

  let behandelingHTML = '';
  if (behandelingGesorteerd.length) behandelingHTML += behandelingGesorteerd.map(regels => groepCardHTML(filterWp(regels, msBeh.werkplaats), mijnId, 'behandeling')).join('');
  if (behandelingVoorraad.length && !heeftBehFilter) {
    if (behandelingGesorteerd.length) behandelingHTML += `
      <div class="sectie-scheiding">
        <hr class="sectie-scheiding-lijn">
        <span class="sectie-scheiding-label">Voorraad reparaties</span>
        <hr class="sectie-scheiding-lijn">
      </div>`;
    behandelingHTML += behandelingVoorraad.map(r => cardHTML(r, 'behandeling')).join('');
  }
  document.getElementById('list-behandeling').innerHTML = behandelingHTML || emptyHTML(heeftBehFilter ? 'Geen resultaten voor dit filter' : 'Niets in behandeling');
  renderWitgoedBehandeling();
  renderNovTab();
  // Afgerond: groepeer logs per opdrachtnr, zoek bijbehorende reparaties op (of toon log-kaart)
  const afgerondGroepen = {};
  afgerondLogs.forEach(l => {
    if (!afgerondGroepen[l.opdrachtnr]) afgerondGroepen[l.opdrachtnr] = { logs: [], regels: [] };
    afgerondGroepen[l.opdrachtnr].logs.push(l);
  });
  // Koppel reparatie-regels aan opdrachtnr (status kan al gereset zijn — daarom via logs)
  state.reparaties.filter(r => afgerondGroepen[r.opdrachtnr] && !isInstructieRegel(r)).forEach(r => {
    afgerondGroepen[r.opdrachtnr].regels.push(r);
  });
  const afgerondGesorteerd = Object.values(afgerondGroepen)
    .sort((a, b) => new Date(b.logs[0].aangemaakt_op) - new Date(a.logs[0].aangemaakt_op))
    .filter(({ logs, regels }) => {
      const groep = regels.length ? regels : logs;
      const nr = groep[0].opdrachtnr || '';
      if (fAfZoek && !nr.toLowerCase().includes(fAfZoek)) return false;
      if (msAf.opdrachtcode.size  && !groep.some(r => msAf.opdrachtcode.has(r.opdrachtcode)))   return false;
      if (msAf.opdrachtstatus.size && !groep.some(r => msAf.opdrachtstatus.has(r.opdrachtstatus))) return false;
      if (msAf.landcode.size      && !groep.some(r => msAf.landcode.has(r.landcode)))             return false;
      if (msAf.handeling.size     && !groep.some(r =>
        (r.handeling || '').split('+').map(s => s.trim()).some(d => msAf.handeling.has(d))))      return false;
      if (msAf.organisatie.size   && !groep.some(r => msAf.organisatie.has(r.organisatie)))       return false;
      if (msAf.werkplaats.size    && !groep.some(r => msAf.werkplaats.has(r.werkplaats)))         return false;
      if (msAf.reden_datum.size   && !groep.some(r => msAf.reden_datum.has(r.reden_datum)))       return false;
      return true;
    });
  document.getElementById('list-afgerond').innerHTML = afgerondGesorteerd.length
    ? afgerondGesorteerd.map(({ logs, regels }) => {
        if (regels.length) return groepCardHTML(filterWp(regels, msAf.werkplaats), mijnId, 'afgerond', logs);
        // Fallback: reparaties niet meer in state — gebruik afgerondKaartHTML
        return afgerondKaartHTML(logs, regels);
      }).join('')
    : emptyHTML('Geen afgeronde opdrachten in deze periode');

  startLijstTimerUpdate();

  // Prep-module live bijwerken als die actief is
  if (document.getElementById('view-prep')?.classList.contains('active')) {
    prepLaadApparaten();
    prepRenderOrders();
  }
}

function afgerondKaartHTML(logs, regels) {
  const l = logs[0];
  const opdrachtnr = l.opdrachtnr;
  const logDatum = new Date(l.aangemaakt_op);
  const tijdStr  = logDatum.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const datumStr = logDatum.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  const artikelcodes = [...new Set(logs.map(x => x.artikelcode).filter(Boolean))];
  const notities = [...new Set(logs.map(x => x.notitie).filter(Boolean))];
  const totalMin = logs.reduce((s, x) => s + (x.bestede_tijd_minuten || 0), 0);
  const tijdBesteed = totalMin > 0 ? `⏱ ${Math.floor(totalMin/60)}u ${String(totalMin%60).padStart(2,'0')}m` : '';

  return `
    <div class="opdracht-groep" style="border-left:3px solid var(--ok)">
      <div class="groep-header" style="cursor:default">
        <div class="groep-header-links">
          <span class="card-nummer">${esc(opdrachtnr)}</span>
          ${l.opdrachtcode ? `<span class="groep-code">${esc(l.opdrachtcode)}</span>` : ''}
          <span style="font-size:11px;color:var(--ok);font-family:var(--mono)">✓ afgerond</span>
        </div>
        <span style="font-size:11px;color:var(--muted)">${datumStr} ${tijdStr}</span>
      </div>
      ${notities.length || tijdBesteed ? `
        <div class="groep-extra-sectie" style="border-top:1px solid var(--border)">
          ${notities.map(n => `<div style="font-size:12px;color:var(--text);white-space:pre-line;line-height:1.6;margin-bottom:4px">${esc(n)}</div>`).join('')}
          ${tijdBesteed ? `<div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:4px">${tijdBesteed}</div>` : ''}
        </div>` : ''}
      <div class="groep-meta" style="flex-direction:column;align-items:flex-start;gap:3px;padding-bottom:8px">
        ${artikelcodes.map(a => `<span style="font-family:var(--mono);font-size:12px;color:var(--text);font-weight:600">${esc(a)}</span>`).join('')}
      </div>
    </div>`;
}

function emptyHTML(msg) {
  return `<div class="empty"><div class="empty-icon">📋</div>${msg}</div>`;
}

function deadlineBadgeHTML(r) {
  if (!r.uiterste_datum_afdeling) return '';
  const nu       = new Date();
  const vandaag  = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate());
  const deadline = new Date(r.uiterste_datum_afdeling);
  const dlDag    = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
  const dagenRest = Math.round((dlDag - vandaag) / 86400000);
  const datumStr  = deadline.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  const kleur = dagenRest < 0 ? 'var(--danger)' : dagenRest === 0 ? 'var(--danger)' : dagenRest <= 2 ? 'var(--hoog)' : dagenRest <= 7 ? 'var(--info)' : 'var(--muted)';
  const label = dagenRest < 0 ? 'Verlopen' : dagenRest === 0 ? 'Vandaag' : dagenRest === 1 ? 'Morgen' : `${dagenRest} dagen`;
  return `<div class="card-deadline" style="color:${kleur};border-color:${kleur}">⏱ ${label} · ${datumStr}</div>`;
}

function toewijzingsBorderstijl(r) {
  if (!r.monteur_id) return '';
  if (r.toegewezen_door === 'manager') return 'border-left:3px solid var(--accent)';
  if (r.toegewezen_door === 'monteur') return 'border-left:3px solid var(--danger)';
  return '';
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function groepCardHTML(regels, mijnId, modus, logs) {
  // modus = 'open' | 'behandeling'
  regels.sort((a, b) => (a.regelnummer ?? 0) - (b.regelnummer ?? 0));
  const hoofd        = regels[0];
  const totaal       = regels.length;
  const geclaimd     = regels.filter(r => r.monteur_id).length;
  const vrijeRegels  = regels.filter(r => !r.monteur_id);
  const gedeeltelijk = geclaimd > 0 && geclaimd < totaal;
  const groepId      = `groep-${modus}-${hoofd.opdrachtnr}`;

  const statusBadge = gedeeltelijk
    ? `<span class="badge-gedeeltelijk">${geclaimd}/${totaal} ingenomen</span>`
    : totaal > 1
    ? `<span class="badge-regels">${totaal} regel${totaal !== 1 ? 's' : ''}</span>`
    : '';

  // In behandeling: alle regels tonen met Details-knop, J/N scheiding alleen in open-modus
  const jRegels       = regels.filter(r => (r.doorsluizenjn || '').toUpperCase() === 'J');
  const nRegels       = regels.filter(r => (r.doorsluizenjn || '').toUpperCase() === 'N');
  const ondNietJ      = regels.filter(r => !['J','N'].includes((r.doorsluizenjn || '').toUpperCase()));
  const werkRegels      = modus === 'onderdelen' ? regels : [...jRegels, ...ondNietJ];
  const onderdeelRegels = modus === 'onderdelen' ? [] : nRegels;

  // Voorraad border op basis van J-regels artikelcodes
  let borderStijl = '';
  if (modus === 'behandeling') {
    if (hoofd.toegewezen_door === 'manager') borderStijl = 'border-left:3px solid var(--accent)';
    else if (hoofd.toegewezen_door === 'monteur') borderStijl = 'border-left:3px solid var(--danger)';
  } else if (modus === 'onderdelen') {
    const kleurMap = { oranje: '#f5a623', rood: '#e85d3a', groen: '#2ab66d' };
    const ondKleurBorder = state.onderdelenKleuren[hoofd.opdrachtnr] || 'oranje';
    borderStijl = `border-left:3px solid ${kleurMap[ondKleurBorder] || '#f5a623'}`;
  } else if (gedeeltelijk) {
    borderStijl = 'border-left:3px solid var(--accent)';
  } else {
    // Controleer voorraad van alle J-regel artikelcodes
    const jMetCode = jRegels.filter(r => r.artikelcode && artikelVoorraad[r.artikelcode]);
    if (jMetCode.length > 0) {
      const heeftTekort = jMetCode.some(r => {
        const v = artikelVoorraad[r.artikelcode];
        return v.min_aantal != null && v.aantal <= v.min_aantal;
      });
      borderStijl = heeftTekort
        ? 'border-left:3px solid #f59e0b'   // oranje = onvoldoende
        : 'border-left:3px solid var(--ok)'; // groen = voldoende
    }
  }

  function regelRijHTML(r, forceerInzien) {
    const isMijn     = r.monteur_id === mijnId;
    const isAnder    = !!(r.monteur_id && r.monteur_id !== mijnId);
    const isAfgerond = isRegelAfgerond(r);
    const monteurNaam = monteurNaamVoor(r.monteur_id, isMijn);

    const rijKlasse = isAfgerond
      ? 'regel-rij gedaan'
      : isAnder ? 'regel-rij bezet'
      : isMijn  ? 'regel-rij eigen'
      : 'regel-rij';

    let actieHTML;
    if (forceerInzien) {
      actieHTML = `<span style="font-size:10px;color:var(--muted);font-family:var(--mono)">onderdeel</span>`;
    } else if (modus === 'behandeling') {
      const historieKnop = r.artikelcode
        ? `<button class="claim-btn" onclick="event.stopPropagation();toonHistorieVoorId('${r.id}')" style="background:none;color:var(--info);border:1px solid var(--border)" title="Reparatiehistorie">📋</button>`
        : '';
      const vrijgeefOfVerwijder = r.soort === 'voorraad'
        ? `<button class="claim-btn" onclick="event.stopPropagation();verwijderVoorraadReparatie('${r.id}')" style="background:none;color:var(--danger);border:1px solid var(--danger)" title="Verwijderen">🗑</button>`
        : `<button class="claim-btn" onclick="event.stopPropagation();vrijgeefRegel('${r.id}')" style="background:none;color:var(--danger);border:1px solid var(--danger)" title="Vrijgeven">✕</button>`;
      const wachtOnderdelenKnop = isRepCode(r)
        ? `<button class="claim-btn" onclick="event.stopPropagation();zetWachtOpOnderdelenRegel('${r.id}')" style="background:none;color:#f5a623;border:1px solid #f5a623" title="Wacht op onderdelen">📦</button>`
        : '';
      actieHTML = `<div style="display:flex;gap:6px;align-items:center">
        ${historieKnop}
        ${vrijgeefOfVerwijder}
        ${wachtOnderdelenKnop}
        <button class="claim-btn" onclick="event.stopPropagation();openAfrond('${r.id}')" style="background:var(--bg3);color:var(--text);border:1px solid var(--border)">Afronden</button>
      </div>`;
    } else if (modus === 'onderdelen') {
      actieHTML = `<span style="font-size:11px;color:#f5a623;font-family:var(--mono)">📦 wacht</span>`;
    } else if (modus === 'afgerond') {
      if (isAfgerond) {
        const bewerkBtn = isMijn
          ? `<button class="claim-btn" onclick="event.stopPropagation();_openAfrondDirect('${r.id}',true)"
               style="background:none;color:var(--info);border:1px solid var(--border);padding:3px 8px;line-height:1" title="Aanpassen">
               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
             </button>`
          : '';
        actieHTML = `<div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:11px;color:var(--ok);font-family:var(--mono)">✓ afgerond</span>
          ${bewerkBtn}
        </div>`;
      } else if (isAnder || isMijn) {
        actieHTML = `<span style="font-size:11px;color:var(--muted)">Geclaimd · ${esc(monteurNaam)}</span>`;
      } else {
        actieHTML = `<span style="font-size:11px;color:var(--muted)">Open</span>`;
      }
    } else {
      // open modus
      if (isAfgerond) {
        actieHTML = `<span style="font-size:11px;color:var(--muted)">Afgerond · ${esc(monteurNaam)}</span>`;
      } else if (isAnder) {
        actieHTML = `<span style="font-size:11px;color:var(--muted)">Geclaimd · ${esc(monteurNaam)}</span>`;
      } else if (isMijn) {
        actieHTML = `<div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--muted)">${esc(monteurNaam)}</span>
          <button class="claim-btn" onclick="event.stopPropagation();vrijgeefRegel('${r.id}')" style="background:none;color:var(--danger);border:1px solid var(--danger)">Vrijgeven</button>
        </div>`;
      } else {
        actieHTML = `<button class="claim-btn" onclick="claimRegel('${r.id}',event)">Claimen</button>`;
      }
    }

    const vrd = r.artikelcode && (r.doorsluizenjn||'').toUpperCase()==='J' ? artikelVoorraad[r.artikelcode] : null;
    const vrdBadge = vrd != null
      ? (() => {
          const tekort = vrd.min_aantal != null && vrd.aantal <= vrd.min_aantal;
          const kleur  = vrd.aantal === 0
            ? 'color:var(--danger)'
            : tekort ? 'color:#b45309' : 'color:var(--ok)';
          return `<span style="font-family:var(--mono);font-size:10px;${kleur}">▐ ${vrd.aantal} st</span>`;
        })()
      : '';

    const toonCheckbox = !forceerInzien && !isAfgerond && (
      (modus === 'open'  && !r.monteur_id) ||
      (modus === 'behandeling' && r.monteur_id === mijnId)
    );
    const checkboxHTML = toonCheckbox
      ? `<div class="regel-checkbox" id="chk-${r.id}" onclick="event.stopPropagation();toggleSelectie('${r.id}','${modus}')"></div>`
      : '';

    const verwijderBtn = handmatigAangemaakteIds.has(r.id) && !isAfgerond
      ? `<button class="claim-btn" onclick="event.stopPropagation();verwijderHandmatigeRegel('${r.id}')"
           style="background:none;color:var(--danger);border:1px solid var(--danger);padding:3px 7px" title="Verwijder handmatige regel">🗑</button>`
      : '';

    return `
      <div class="${rijKlasse}">
        ${checkboxHTML}
        <div class="regel-info">
          <span class="regel-handeling">${[r.artikelcode, r.artikelomschrijving].filter(Boolean).map(esc).join(' · ') || esc(r.handeling) || '—'}</span>
          <div style="display:flex;gap:8px;align-items:center">
          ${r.aantal != null ? `<span class="regel-artikel">Aantal: ${r.aantal}</span>` : ''}
          ${vrdBadge}
          </div>
          ${r.regelnummer != null ? `<span class="regel-nr">#${r.regelnummer}</span>` : ''}
        </div>
        <div class="regel-actie" style="display:flex;gap:6px;align-items:center">${actieHTML}${verwijderBtn}</div>
      </div>`;
  }

  const werkRegelsHTML     = werkRegels.map(r => regelRijHTML(r, false)).join('');
  const onderdeelGroepId   = `ond-${groepId}`;
  const onderdeelSectieHTML = onderdeelRegels.length ? `
    <div style="border-top:1px solid var(--border)">
      <div onclick="toggleGroep('${onderdeelGroepId}')" style="padding:8px 14px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:11px;color:var(--muted);">
        <span style="font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em">Onderdelen (${onderdeelRegels.length})</span>
        <span class="groep-chevron" id="chevron-${onderdeelGroepId}">▸</span>
      </div>
      <div id="${onderdeelGroepId}" style="display:none;flex-direction:column">
        ${onderdeelRegels.map(r => regelRijHTML(r, true)).join('')}
      </div>
    </div>` : '';

  const regelsHTML = werkRegelsHTML + onderdeelSectieHTML;

  // "Alles claimen" — alleen vrije J-regels
  const vrijeClaim = werkRegels.filter(r => !r.monteur_id);
  const allesClaimen = modus === 'open' && vrijeClaim.length >= 1 && geclaimd === 0
    ? `<div style="padding:8px 14px;border-top:1px solid var(--border)">
        <button class="claim-btn" style="width:100%" onclick="claimAlles(${JSON.stringify(vrijeClaim.map(r => r.id)).replace(/"/g,'&quot;')},event)">
          Hele opdracht claimen (${vrijeClaim.length} regel${vrijeClaim.length !== 1 ? 's' : ''})
        </button>
       </div>`
    : '';

  // "Alles afronden" + "Alles vrijgeven" — eigen regels in behandeling
  const mijneRegels = werkRegels.filter(r => r.monteur_id === mijnId);
  // Controleer alleen de regels die de monteur zelf wil afronden
  const blokkeerRegels = mijneRegels.filter(r => r.status !== statusInBehandeling(r));
  const kanBulkAfronden = modus === 'behandeling' && mijneRegels.length > 1 && blokkeerRegels.length === 0;
  const allesAfronden = modus === 'behandeling' && mijneRegels.length > 1
    ? `<div style="padding:8px 14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:6px">
        ${blokkeerRegels.length
          ? `<div style="font-size:11px;color:var(--danger);background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.25);border-radius:5px;padding:6px 10px;line-height:1.4">
              ⚠ ${blokkeerRegels.length} van jouw regel${blokkeerRegels.length !== 1 ? 's hebben' : ' heeft'} niet de juiste status (465).
             </div>`
          : ''}
        <div style="display:flex;gap:8px">
          <button class="claim-btn" style="flex:1;background:${kanBulkAfronden ? '#184381' : '#6b7280'};color:#fff;border-color:${kanBulkAfronden ? '#004582' : '#6b7280'};${kanBulkAfronden ? '' : 'opacity:.6;cursor:not-allowed'}"
            onclick="openBulkAfrond(${JSON.stringify(mijneRegels.map(r => r.id)).replace(/"/g,'&quot;')}, '${hoofd.opdrachtnr}', event)"
            ${kanBulkAfronden ? '' : 'disabled'}>
            Hele opdracht afronden
          </button>
          <button class="claim-btn" style="background:none;color:var(--danger);border:1px solid var(--danger)"
            onclick="vrijgeefAlles(${JSON.stringify(mijneRegels.map(r => r.id)).replace(/"/g,'&quot;')}, '${hoofd.opdrachtnr}', event)">
            Vrijgeven
          </button>
        </div>
       </div>`
    : '';

  const ondKleur = state.onderdelenKleuren[hoofd.opdrachtnr] || 'oranje';
  const kleurKnoppen = ['oranje','rood','groen'].map(k =>
    `<button class="ond-kleur-knop${ondKleur===k?' actief':''}" data-kleur="${k}" title="${k.charAt(0).toUpperCase()+k.slice(1)}" onclick="event.stopPropagation();zetOnderdelenKleur('${hoofd.opdrachtnr}','${k}',this)"></button>`
  ).join('');
  const voorraadFooter = modus === 'onderdelen'
    ? `<div style="padding:8px 14px;border-top:1px solid var(--border)">
        <div class="ond-kleur-kiezer" style="margin-bottom:8px">
          <span class="ond-kleur-label">Status:</span>
          ${kleurKnoppen}
        </div>
        <button class="claim-btn" style="width:100%" onclick="event.stopPropagation();zetVoorraadBeschikbaar('${hoofd.opdrachtnr}')">
          Voorraad beschikbaar
        </button>
      </div>`
    : '';

  // Bouw secties voor klacht (toggle) en 99-werkplaats taken (altijd zichtbaar)
  const extraWerk = state.reparaties.filter(r => r.opdrachtnr === hoofd.opdrachtnr && isInstructieRegel(r))
    .sort((a,b) => (a.regelnummer ?? 0) - (b.regelnummer ?? 0));
  const werkplaatsTaken = extraWerk.map(r => r.artikelomschrijving || r.handeling).filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
  const heeftKlacht = !!(hoofd.klacht);

  // 99-werkplaats taken: altijd zichtbaar onder de header
  const wpSectieHTML = werkplaatsTaken.length ? `
    <div class="groep-extra-sectie" style="border-top:1px solid var(--border)">
      <div class="groep-extra-label">Extra werkzaamheden (99-Werkplaats)</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${werkplaatsTaken.map(t => `<span style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:12px">${esc(t)}</span>`).join('')}
      </div>
    </div>` : '';

  const mijnRegelId = (werkRegels.find(r => r.monteur_id === mijnId) || {}).id;
  const opmSectieHTML = (heeftKlacht || modus === 'behandeling') ? `
    <div class="groep-extra-sectie" id="opm-sectie-${groepId}" style="display:none">
      ${heeftKlacht ? `<div class="groep-extra-label">Opmerking / klacht</div><div>${esc(hoofd.klacht)}</div>` : ''}
      ${modus === 'behandeling' ? `<div id="opm-lijst-${groepId}" style="margin-top:${heeftKlacht ? '10px' : '0'};display:flex;flex-direction:column;gap:6px"></div>` : ''}
    </div>` : '';

  const isRepOpdracht = (hoofd.opdrachtnr || '').toUpperCase().startsWith('REP') || (hoofd.opdrachtcode || '').toUpperCase().startsWith('REP');
  const tagnummerHTML = isRepOpdracht
    ? `<div style="padding:7px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
        <span style="font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Tagnummer</span>
        <span style="font-family:var(--mono);font-size:12px;font-weight:600;color:${hoofd.tagnummer ? 'var(--text)' : 'var(--muted)'}">${esc(hoofd.tagnummer) || 'Tagnummer onbekend'}</span>
       </div>`
    : '';

  return `
    <div class="opdracht-groep ${gedeeltelijk ? 'gedeeltelijk' : ''}" style="${borderStijl}">
      <div class="groep-header" onclick="toggleGroep('${groepId}')">
        <div class="groep-header-links">
          <span class="card-nummer">${esc(hoofd.opdrachtnr)}</span>
          ${hoofd.opdrachtcode ? `<span class="groep-code">${esc(hoofd.opdrachtcode)}</span>` : ''}
          ${hoofd.abonneecode  ? `<span class="groep-code">${esc(hoofd.abonneecode)}</span>`  : ''}
          ${statusBadge}
          ${hoofd.opdrachtstatus ? `<span style="font-size:10px;font-family:var(--mono);background:var(--bg3);color:var(--muted);border:1px solid var(--border);border-radius:3px;padding:1px 5px;white-space:nowrap">${esc(hoofd.opdrachtstatus)}</span>` : ''}
          ${hoofd.organisatie ? `<span style="font-size:10px;font-family:var(--mono);background:#f0f8ec;color:#2d6a2d;border:1px solid #b6d9b6;border-radius:3px;padding:1px 5px;white-space:nowrap">${esc(hoofd.organisatie)}</span>` : ''}
          ${modus === 'afgerond' && hoofd.afgerond_op ? `<span style="font-size:10px;font-family:var(--mono);background:rgba(34,197,94,.1);color:var(--ok);border:1px solid rgba(34,197,94,.3);border-radius:3px;padding:1px 5px;white-space:nowrap">✓ ${new Date(hoofd.afgerond_op).toLocaleDateString('nl-NL',{day:'numeric',month:'short'})}</span>` : ''}
          ${(modus === 'open' || modus === 'behandeling') && hoofd.magazijnlocatie ? `<span style="font-size:10px;font-family:var(--mono);background:#e8f4ff;color:var(--info);border:1px solid #b8d4f0;border-radius:3px;padding:1px 5px;white-space:nowrap">📦 ${esc(hoofd.magazijnlocatie)}</span>` : ''}
          ${(modus === 'open' || modus === 'behandeling') && hoofd.landcode ? `<span style="font-size:10px;font-family:var(--mono);background:var(--bg3);color:var(--muted);border:1px solid var(--border);border-radius:3px;padding:1px 5px;white-space:nowrap">${esc(hoofd.landcode)}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
          ${(heeftKlacht || modus === 'behandeling') ? `<button class="groep-icon-btn" id="opm-btn-${groepId}" title="Opmerking / klacht" onclick="event.stopPropagation();toggleGroepSectie('opm-sectie-${groepId}','opm-btn-${groepId}');${modus === 'behandeling' ? `laadOpmerkingenInline('${groepId}','${mijnRegelId}')` : ''}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>` : ''}
          ${modus === 'behandeling' ? maakTimerKnopHeader(werkRegels.find(r => r.monteur_id === mijnId)) : ''}
          ${modus === 'behandeling' ? `<button class="groep-icon-btn" title="Opmerking toevoegen" onclick="event.stopPropagation();openDetail('${mijnRegelId}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>` : ''}
          <span class="groep-chevron" id="chevron-${groepId}">▸</span>
        </div>
      </div>
      ${wpSectieHTML}
      ${opmSectieHTML}
      ${(() => {
        if (modus !== 'afgerond') return '';
        const bronLogs = logs || (state.afgerondLogs || []).filter(l => l.opdrachtnr === hoofd.opdrachtnr);
        const notities = [...new Set(bronLogs.map(l => l.notitie).filter(Boolean))];
        const totalMin = bronLogs.reduce((s, l) => s + (l.bestede_tijd_minuten || 0), 0);
        const tijdStr  = totalMin > 0 ? `⏱ ${Math.floor(totalMin/60)}u ${String(totalMin%60).padStart(2,'0')}m` : '';
        if (!notities.length && !tijdStr) return '';
        return `<div class="groep-extra-sectie" style="border-top:1px solid var(--border)">
          ${notities.map(n => `<div style="font-size:12px;color:var(--text);white-space:pre-line;line-height:1.6;margin-bottom:4px">${esc(n)}</div>`).join('')}
          ${tijdStr ? `<div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:4px">${tijdStr}</div>` : ''}
        </div>`;
      })()}
      <div class="groep-meta" style="flex-direction:column;align-items:flex-start;gap:3px;padding-bottom:8px">
        ${werkRegels.map(r => {
          const label = r.artikelcode || r.artikelomschrijving || r.handeling || r.klacht || '';
          if (!label && r.aantal == null) return '';
          return `<div style="display:flex;gap:10px;align-items:baseline">
            ${r.artikelcode  ? `<span style="font-family:var(--mono);font-size:12px;color:var(--text);font-weight:600">${esc(r.artikelcode)}</span>` : ''}
            ${r.artikelomschrijving ? `<span style="font-size:12px;color:var(--muted)">${esc(r.artikelomschrijving)}</span>` : ''}
            ${!r.artikelcode && !r.artikelomschrijving && (r.handeling || r.klacht) ? `<span style="font-size:12px;color:var(--muted)">${esc(r.handeling || r.klacht)}</span>` : ''}
            ${r.aantal != null ? `<span style="font-family:var(--mono);font-size:11px;color:var(--muted)">×${r.aantal}</span>` : ''}
          </div>`;
        }).join('')}
        ${(() => {
          const handeling = hoofd.handeling;
          if (!handeling) return '';
          return `<span style="font-size:11px;color:var(--muted);font-family:var(--mono)">${esc(handeling)}</span>`;
        })()}
        ${deadlineBadgeHTML(hoofd)}
      </div>
      <div class="groep-regels" id="${groepId}" style="display:none">
        ${tagnummerHTML}
        ${modus === 'afgerond' ? `<div id="werklog-${groepId}" data-opdrachtnr="${hoofd.opdrachtnr}" style="padding:0"></div>` : ''}
        ${regelsHTML}
        ${allesClaimen}
        ${allesAfronden}
        ${voorraadFooter}
        ${(modus !== 'afgerond' && modus !== 'onderdelen') ? `
        <div style="padding:6px 14px 10px;border-top:1px solid var(--border)">
          <button onclick="event.stopPropagation();openRegelModal('${hoofd.opdrachtnr}')"
            style="width:100%;background:none;border:1px dashed var(--border);border-radius:var(--r);
                   color:var(--muted);font-size:12px;padding:7px;cursor:pointer;font-family:var(--font)">
            + Regel toevoegen
          </button>
        </div>` : ''}
      </div>
    </div>`;
}

function toggleGroepSectie(sectieId, btnId) {
  const el  = document.getElementById(sectieId);
  const btn = document.getElementById(btnId);
  if (!el) return;
  const open = el.style.display === 'none' || el.style.display === '';
  el.style.display = open ? 'block' : 'none';
  btn?.classList.toggle('actief', open);
}

function toggleGroep(groepId) {
  const el      = document.getElementById(groepId);
  const chevron = document.getElementById('chevron-' + groepId);
  const opening = el.style.display === 'none';
  el.style.display = opening ? 'flex' : 'none';
  el.style.flexDirection = 'column';
  chevron.classList.toggle('open', opening);

  // Laad werklog de eerste keer dat een afgerond-kaart wordt geopend
  if (opening) {
    const logEl = document.getElementById('werklog-' + groepId);
    if (logEl && !logEl.dataset.geladen) {
      logEl.dataset.geladen = '1';
      laadWerklog(logEl.dataset.opdrachtnr, logEl);
    }
  }
}

async function laadWerklog(opdrachtnr, container) {
  container.innerHTML = `<div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px"><div class="spinner" style="width:14px;height:14px;margin:0"></div>Werkzaamheden laden...</div>`;

  if (state.demoMode) {
    container.innerHTML = `<div style="padding:12px 14px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px">Wat is er gedaan</div>
      <div style="font-size:13px;color:var(--text)">Demo — geen log beschikbaar</div>
    </div>`;
    return;
  }

  try {
    const { data, error } = await sb.from('reparatie_logs')
      .select('reparatie_id, actie, notitie, gebruikte_onderdelen, bestede_tijd_minuten, monteur_naam, aangemaakt_op')
      .eq('opdrachtnr', opdrachtnr)
      .eq('actie', 'afgerond')
      .order('aangemaakt_op', { ascending: false });

    if (error) throw error;
    const logs = data || [];

    if (!logs.length) {
      container.innerHTML = `<div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)">Geen notitie vastgelegd bij afronden.</div>`;
      return;
    }

    container.innerHTML = logs.map(l => {
      const tijdstip = new Date(l.aangemaakt_op).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' });
      const tijdLabel = l.bestede_tijd_minuten
        ? `${Math.floor(l.bestede_tijd_minuten/60) ? Math.floor(l.bestede_tijd_minuten/60)+'u ' : ''}${l.bestede_tijd_minuten%60}min`
        : null;
      return `<div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <span style="font-size:11px;font-weight:600;color:var(--ok)">✓ Afgerond${l.monteur_naam ? ' door ' + esc(l.monteur_naam) : ''}</span>
          <span style="font-size:11px;font-family:var(--mono);color:var(--muted)">${tijdstip}${tijdLabel ? ' · ' + tijdLabel : ''}</span>
        </div>
        ${(() => {
          if (!l.notitie) return '';
          const diagMatch = l.notitie.match(/^(?:\[[A-Z]+\] )?Diagnose: ([\s\S]*?)(?:\n\nWerkzaamheden: ([\s\S]*))?$/);
          if (diagMatch) {
            const diag = diagMatch[1]?.trim();
            const werk = diagMatch[2]?.trim();
            return [
              diag ? `<div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.05em">Diagnose</div><div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:6px">${esc(diag)}</div>` : '',
              werk ? `<div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.05em">Werkzaamheden</div><div style="font-size:13px;color:var(--text);line-height:1.5">${esc(werk)}</div>` : '',
            ].filter(Boolean).join('');
          }
          return `<div style="font-size:13px;color:var(--text);line-height:1.5">${esc(l.notitie)}</div>`;
        })()}
        ${l.gebruikte_onderdelen ? `<div style="font-size:11px;color:var(--muted);font-family:var(--mono)">Onderdelen: ${esc(l.gebruikte_onderdelen)}</div>` : ''}
      </div>`;
    }).join('');
  } catch(e) {
    container.innerHTML = `<div style="padding:10px 14px;font-size:12px;color:var(--danger)">Fout: ${e.message}</div>`;
  }
}

// ── MULTI-SELECTIE ────────────────────────────────────────────
const geselecteerdeRegels = new Map(); // id → modus

function toggleSelectie(id, modus) {
  if (geselecteerdeRegels.has(id)) {
    geselecteerdeRegels.delete(id);
  } else {
    geselecteerdeRegels.set(id, modus);
  }
  const chk = document.getElementById('chk-' + id);
  if (chk) chk.classList.toggle('geselecteerd', geselecteerdeRegels.has(id));
  updateSelectieBalk();
}

function updateSelectieBalk() {
  const balk   = document.getElementById('selectie-balk');
  const tekst  = document.getElementById('sb-tekst');
  const acties = document.getElementById('sb-acties');
  const n = geselecteerdeRegels.size;

  // Verberg "Hele opdracht claimen" knop wanneer er regels geselecteerd zijn
  const claimAllesBtn = document.getElementById('mcp-bevestig-btn');
  if (claimAllesBtn) {
    claimAllesBtn.disabled = n > 0;
    claimAllesBtn.title = n > 0 ? 'Deselecteer alle regels om de hele opdracht te claimen' : '';
  }

  if (n === 0) {
    balk.classList.remove('zichtbaar');
    return;
  }

  balk.classList.add('zichtbaar');
  tekst.textContent = n + ' geselecteerd';

  // Bepaal welke modi er geselecteerd zijn
  const modi = new Set(geselecteerdeRegels.values());
  const ids  = [...geselecteerdeRegels.keys()];

  let html = '';
  if (modi.has('open') && !modi.has('behandeling')) {
    html = `<button class="sb-btn primair" onclick="claimSelectie()">Geselecteerde regels claimen</button>`;
  } else if (modi.has('behandeling') && !modi.has('open')) {
    html = `<button class="sb-btn" onclick="vrijgeefSelectie()">Vrijgeven</button>
            <button class="sb-btn primair" onclick="afrondSelectie()">Afronden</button>`;
  } else {
    html = `<span style="font-size:11px;opacity:.7">Mix — kies één type</span>`;
  }
  acties.innerHTML = html;
}

function clearSelectie() {
  geselecteerdeRegels.forEach((_, id) => {
    const chk = document.getElementById('chk-' + id);
    if (chk) chk.classList.remove('geselecteerd');
  });
  geselecteerdeRegels.clear();
  updateSelectieBalk();
}

function claimSelectie() {
  const ids = [...geselecteerdeRegels.keys()];
  clearSelectie();
  if (ids.length === 1) {
    const r = state.reparaties.find(x => x.id === ids[0]);
    if (r) openStart(ids[0]);
    return;
  }
  const fakeEvent = { stopPropagation: () => {} };
  claimAlles(ids, fakeEvent, true);
}

async function vrijgeefSelectie() {
  const ids = [...geselecteerdeRegels.keys()];
  clearSelectie();
  const fakeEvent = { stopPropagation: () => {} };
  const opdrachtnr = state.reparaties.find(r => r.id === ids[0])?.opdrachtnr || '';
  vrijgeefAlles(ids, opdrachtnr, fakeEvent);
}

function afrondSelectie() {
  const ids = [...geselecteerdeRegels.keys()];
  clearSelectie();
  if (ids.length === 1) {
    openAfrond(ids[0]);
    return;
  }
  const fakeEvent = { stopPropagation: () => {} };
  const opdrachtnr = state.reparaties.find(r => r.id === ids[0])?.opdrachtnr || '';
  openBulkAfrond(ids, opdrachtnr, fakeEvent);
}
// ─────────────────────────────────────────────────────────────

function claimRegel(id, event) {
  event.stopPropagation();
  openStart(id);
}

async function verwijderHandmatigeRegel(id) {
  if (!confirm('Handmatig toegevoegde regel definitief verwijderen?')) return;
  try {
    await sb.from('reparatie_logs').delete().eq('reparatie_id', id);
    const { error } = await sb.from('reparaties').delete().eq('id', id);
    if (error) throw error;
    handmatigAangemaakteIds.delete(id);
    state.reparaties = state.reparaties.filter(r => r.id !== id);
    renderLists();
    toast('Regel verwijderd');
  } catch(e) {
    toast('Fout bij verwijderen: ' + e.message);
  }
}

async function verwijderVoorraadReparatie(id) {
  const r = state.reparaties.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`Voorraad opdracht ${r.opdrachtnr} definitief verwijderen?`)) return;
  try {
    await sb.from('tagnr_scans').delete().eq('reparatie_id', id);
    await sb.from('reparatie_logs').delete().eq('reparatie_id', id);
    const { error } = await sb.from('reparaties').delete().eq('id', id);
    if (error) throw error;
    state.reparaties = state.reparaties.filter(r => r.id !== id);
    closeModal('modal-detail');
    renderLists();
    toast('Voorraad opdracht verwijderd');
  } catch(e) {
    toast('Fout bij verwijderen: ' + e.message);
  }
}

async function vrijgeefRegel(id) {
  const r = state.reparaties.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`Regel ${r.opdrachtnr} vrijgeven?`)) return;

  // Onderdelen (N-regels) van dezelfde opdracht die ook door mij geclaimd zijn
  // moeten mee vrijgegeven worden — anders blijft de opdracht met alleen
  // onderdelen achter in 'in behandeling'.
  const nRegels = state.reparaties.filter(x =>
    x.opdrachtnr === r.opdrachtnr &&
    x.id !== id &&
    (x.doorsluizenjn || '').toUpperCase() === 'N' &&
    x.monteur_id === state.monteur?.id &&
    !isRegelAfgerond(x)
  );

  if (state.demoMode) {
    [r, ...nRegels].forEach(x => {
      x.status = statusOpen(x);
      x.monteur_id = null;
      x.monteurs = null;
      x.in_behandeling_op = null;
    });
    renderLists();
    return;
  }

  try {
    const nieuweStatus = statusOpen(r);
    const vrijgeefData = { status: nieuweStatus, monteur_id: null, toegewezen_door: null, in_behandeling_op: null };
    await updateReparatieStatus(id, vrijgeefData);
    await insertLog({
      reparatie_id: id,
      monteur_id: state.monteur.id,
      monteur_naam: state.monteur.naam,
      actie: 'vrijgegeven',
      opdrachtnr: r.opdrachtnr,
      regelnummer: r.regelnummer,
      opdrachtcode: r.opdrachtcode || null,
      artikelcode: r.artikelcode,
      artikelomschrijving: r.artikelomschrijving,
      notitie: `Regel vrijgegeven door ${state.monteur.naam}`,
      opdrachtstatus: r.status || null,
      nieuwe_opdrachtstatus: nieuweStatus,
    });
    for (const n of nRegels) {
      await updateReparatieStatus(n.id, { ...vrijgeefData, status: statusOpen(n) });
    }
    [r, ...nRegels].forEach(x => {
      x.status = statusOpen(x);
      x.monteur_id = null;
      x.monteurs = null;
      x.in_behandeling_op = null;
    });
    renderLists();
  } catch(e) {
    alert('Vrijgeven mislukt: ' + e.message);
  }
}

async function vrijgeefAlles(ids, opdrachtnr, event) {
  event.stopPropagation();
  if (!confirm(`Alle regels van opdracht ${opdrachtnr} vrijgeven?`)) return;

  // Inclusief N-regels (onderdelen) die mee zijn geclaimd
  const nRegels = state.reparaties.filter(r =>
    r.opdrachtnr === opdrachtnr &&
    (r.doorsluizenjn || '').toUpperCase() === 'N' &&
    r.monteur_id
  );
  const alleIds = [...new Set([...ids, ...nRegels.map(r => r.id)])];

  for (const id of alleIds) {
    const r = state.reparaties.find(x => x.id === id);
    if (!r) continue;

    const nieuweStatus = statusOpen(r);
    if (state.demoMode) {
      r.status = nieuweStatus;
      r.monteur_id = null;
      r.monteurs = null;
      r.in_behandeling_op = null;
    } else {
      try {
        await updateReparatieStatus(id, {
          status: nieuweStatus,
          monteur_id: null,
          toegewezen_door: null,
          in_behandeling_op: null,
        });
        await insertLog({
          reparatie_id: id,
          monteur_id: state.monteur.id,
          monteur_naam: state.monteur.naam,
          actie: 'vrijgegeven',
          opdrachtnr: r.opdrachtnr,
          regelnummer: r.regelnummer,
          opdrachtcode: r.opdrachtcode || null,
          artikelcode: r.artikelcode,
          artikelomschrijving: r.artikelomschrijving,
          notitie: `Hele opdracht vrijgegeven door ${state.monteur.naam}`,
          opdrachtstatus: r.status || null,
          nieuwe_opdrachtstatus: nieuweStatus,
        });
        r.status = nieuweStatus;
        r.monteur_id = null;
        r.monteurs = null;
        r.in_behandeling_op = null;
      } catch(e) {
        toast('Fout bij vrijgeven regel ' + (r.regelnummer ?? r.id) + ': ' + e.message);
      }
    }
  }

  renderLists();
  toast('✓ Opdracht vrijgegeven');
}

function isInstructieRegel(r) {
  return (r.artikelcode || '').toLowerCase() === '99-werkplaats';
}

// Een regel is afgerond als status=519 OF als afgerond_op gevuld is.
// Dit voorkomt dat externe syncs die status terugzetten naar 445 afgeronde
// opdrachten opnieuw laten verschijnen.
function isRegelAfgerond(r) {
  return String(r.status) === '519' || !!r.afgerond_op;
}

function renderInstructies(opdrachtnr, doelId) {
  const instructieRegels = state.reparaties.filter(r =>
    r.opdrachtnr === opdrachtnr && isInstructieRegel(r)
  ).sort((a, b) => (a.regelnummer ?? 0) - (b.regelnummer ?? 0));

  const el = document.getElementById(doelId);
  if (!instructieRegels.length) { el.style.display = 'none'; el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="instructie-blok">
      <div class="instructie-label">🔧 Extra werkzaamheden</div>
      ${instructieRegels.map(r => `
        <div class="instructie-regel">
          ${r.regelnummer != null ? `<div class="instructie-regel-nr">#${r.regelnummer}</div>` : ''}
          <div>
            ${r.artikelomschrijving ? `<span style="font-weight:600">${r.artikelomschrijving}</span>` : ''}
            ${r.artikelomschrijving && (r.klacht || r.handeling) ? ' — ' : ''}
            ${r.klacht || r.handeling || (!r.artikelomschrijving ? '—' : '')}
          </div>
        </div>`).join('')}
    </div>`;
  el.style.display = '';
}

let _claimAllesIds = [];

function claimAlles(ids, event, vanuitSelectie) {
  event.stopPropagation();
  if (!vanuitSelectie) clearSelectie(); // 'volledige opdracht claimen' negeert een eventuele losse selectie elders
  _claimAllesIds = ids;
  const eerste = state.reparaties.find(r => r.id === ids[0]);
  if (!eerste) return;

  const titel = vanuitSelectie
    ? `${ids.length} geselecteerde regel${ids.length !== 1 ? 's' : ''} claimen`
    : `Opdracht ${eerste.opdrachtnr} claimen`;
  document.getElementById('mcp-title').textContent = titel;
  document.getElementById('mcp-bevestig-btn').textContent = vanuitSelectie
    ? `Geselecteerde regels claimen`
    : `Hele opdracht claimen`;
  document.getElementById('mcp-sub').textContent   = eerste.klant_naam || '';
  document.getElementById('mcp-klacht').textContent = eerste.klacht || '—';

  const regelsEl = document.getElementById('mcp-regels');
  regelsEl.innerHTML = ids.map(id => {
    const r = state.reparaties.find(x => x.id === id);
    if (!r) return '';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <div>
        ${r.artikelcode ? `<span style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text)">${r.artikelcode}</span> ` : ''}
        ${r.artikelomschrijving ? `<span style="font-size:12px;color:var(--muted)">${r.artikelomschrijving}</span>` : ''}
        ${r.aantal != null ? `<span style="font-family:var(--mono);font-size:11px;color:var(--muted)"> ×${r.aantal}</span>` : ''}
      </div>
      ${r.artikelcode ? `<button onclick="state.activeMod=state.reparaties.find(x=>x.id==='${r.id}');toonApparaatGeschiedenis()" style="background:none;border:1px solid var(--border);border-radius:var(--r);padding:2px 8px;font-size:11px;color:var(--info);cursor:pointer">📋 Historie</button>` : ''}
    </div>`;
  }).join('');

  // Zorg dat knop direct de juiste staat heeft op basis van huidige selectie
  const claimAllesBtn = document.getElementById('mcp-bevestig-btn');
  if (claimAllesBtn) {
    const heeftSelectie = geselecteerdeRegels.size > 0;
    claimAllesBtn.disabled = heeftSelectie;
    claimAllesBtn.title = heeftSelectie ? 'Deselecteer alle regels om de hele opdracht te claimen' : '';
  }

  openModal('modal-claim-preview');
}

async function bevestigClaimAlles() {
  closeModal('modal-claim-preview');
  const ids = _claimAllesIds;
  const mijnId = state.monteur.id;
  const eersteRep = state.reparaties.find(x => x.id === ids[0]);
  const opdrachtnr = eersteRep?.opdrachtnr;
  const now = new Date().toISOString();

  // Auto-include N-regels als alle J-regels van een opdracht worden geclaimd
  const betrokkenOpdrachten = [...new Set(ids.map(id => state.reparaties.find(x => x.id === id)?.opdrachtnr).filter(Boolean))];
  const extraNIds = [];
  for (const opdr of betrokkenOpdrachten) {
    const alleJ = state.reparaties.filter(r => r.opdrachtnr === opdr && (r.doorsluizenjn||'').toUpperCase() === 'J' && !isInstructieRegel(r));
    if (alleJ.every(r => r.monteur_id || ids.includes(r.id))) {
      state.reparaties.filter(r => r.opdrachtnr === opdr && (r.doorsluizenjn||'').toUpperCase() === 'N' && !r.monteur_id)
        .forEach(r => extraNIds.push(r.id));
    }
  }
  const alleTeClaimenIds = [...ids, ...extraNIds];

  for (const id of alleTeClaimenIds) {
    const r = state.reparaties.find(x => x.id === id);
    if (!r) continue;
    const nieuweStatus = statusInBehandeling(r);
    if (state.demoMode) {
      r.status = nieuweStatus;
      r.monteur_id = mijnId;
      r.monteurs   = { naam: state.monteur.naam, initialen: state.monteur.initialen };
      r.in_behandeling_op = now;
    } else {
      try {
        await updateReparatieStatus(r.id, {
          status: nieuweStatus,
          monteur_id: mijnId,
          toegewezen_door: r.toegewezen_door || 'monteur',
          in_behandeling_op: now,
        });
        await insertLog({ reparatie_id: r.id, monteur_id: mijnId, monteur_naam: state.monteur.naam, actie: 'start', opdrachtnr: r.opdrachtnr, regelnummer: r.regelnummer, opdrachtcode: r.opdrachtcode || null, artikelcode: r.artikelcode, aantal: r.aantal, artikelomschrijving: r.artikelomschrijving, serienummer: r.serienummer, tagnummer: r.tagnummer, opdrachtstatus: r.status || null, nieuwe_opdrachtstatus: nieuweStatus });
      } catch(e) {
        toast('Fout bij regel ' + (r.regelnummer ?? r.id) + ': ' + e.message);
      }
    }
  }

  if (!state.demoMode) await laadReparaties();
  else renderLists();

  switchTab('behandeling');
  clearSelectie();
  toast('✓ Hele opdracht geclaimd');
}

function cardHTML(r, type) {
  const datum = new Date(r.aangemaakt_op).toLocaleDateString('nl-NL', { day:'2-digit', month:'2-digit' });
  const monteurRow = r.monteurs ? `
    <div class="card-monteur">
      <div class="monteur-dot-sm">${r.monteurs.initialen}</div>
      <span class="card-monteur-naam">${r.monteurs.naam}</span>
      ${r.toegewezen_door === 'manager' ? '<span style="font-size:10px;color:var(--accent);margin-left:4px">door manager</span>' : r.toegewezen_door === 'monteur' ? '<span style="font-size:10px;color:var(--danger);margin-left:4px">zelf opgepakt</span>' : ''}
    </div>` : '';

  const clickHandler = type === 'behandeling'
    ? `onclick="openDetail('${r.id}')"`
    : type === 'open' || type === 'besteld'
    ? `onclick="openStart('${r.id}')"`
    : '';

  const besteldBadge = type === 'besteld'
    ? `<div class="badge-besteld" style="margin-top:8px;display:inline-block">📦 Onderdelen besteld</div>`
    : '';
  const voorraadBadge = r.soort === 'voorraad'
    ? `<div class="badge-voorraad">📦 VOORRAAD</div>`
    : '';

  return `
    <div class="rep-card-wrap" id="wrap-${r.id}">
      <div class="rep-card-action" id="action-${r.id}" style="background:var(--accent)">
        <span style="font-size:18px">▶</span>
      </div>
      <div class="rep-card" id="card-${r.id}" ${clickHandler} data-id="${r.id}" style="${toewijzingsBorderstijl(r)}">
        <div class="card-top">
          <div class="card-nummer">${r.opdrachtnr}</div>
          <div class="card-prio prio-${r.prioriteit || 'normaal'}">${(r.prioriteit || 'normaal').toUpperCase()}</div>
        </div>
        ${r.opdrachtcode ? `<div class="card-apparaat">${r.opdrachtcode}</div>` : ''}
        ${r.abonneecode  ? `<div class="card-merk">${r.abonneecode}</div>` : ''}
        ${r.handeling    ? `<div class="card-merk" style="color:var(--muted)">${r.handeling}</div>` : ''}
        <div class="card-klacht">${r.klacht || '—'}</div>
        ${deadlineBadgeHTML(r)}
        ${besteldBadge}${voorraadBadge}
        ${type === 'behandeling' ? maakTimerBadge(r) : ''}
        ${monteurRow}
        <div class="card-bottom">
          <div class="card-klant">${r.klant_naam}</div>
          <div class="card-datum">${datum}</div>
        </div>
      </div>
    </div>`;
}


// ── MODALS ────────────────────────────────────────────────────
function openStart(id) {
  const r = state.reparaties.find(x => x.id === id);
  if (!r) return;
  clearSelectie(); // een losse 'Claimen' op een individuele regel negeert een eventuele selectie elders
  state.activeMod = r;
  document.getElementById('ms-title').textContent  = r.opdrachtnr;
  document.getElementById('ms-sub').textContent    = r.opdrachtcode || r.abonneecode || '';
  document.getElementById('ms-klacht').textContent = r.klacht || '—';
  document.getElementById('ms-klant').textContent  = `${r.klant_naam || ''}${r.klant_nummer ? ' ('+r.klant_nummer+')' : ''}`;

  // Artikelcode
  const msArtSectie = document.getElementById('ms-artikelcode-sectie');
  if (r.artikelcode && !isInstructieRegel(r)) {
    document.getElementById('ms-artikelcode').textContent = r.artikelcode;
    const msVoorraad = document.getElementById('ms-voorraad-badge');
    if (msVoorraad) msVoorraad.innerHTML = voorraadBadgeHTML(r.artikelcode);
    msArtSectie.style.display = '';
  } else {
    msArtSectie.style.display = 'none';
  }

  // Apparaat
  const msApparaatSectie = document.getElementById('ms-apparaat-sectie');
  if (r.artikelomschrijving) {
    document.getElementById('ms-apparaat').textContent = [r.artikelomschrijving, r.merk, r.model].filter(Boolean).join(' · ');
    msApparaatSectie.style.display = '';
  } else {
    msApparaatSectie.style.display = 'none';
  }

  // Aantal
  const msAantalSectie = document.getElementById('ms-aantal-sectie');
  if (r.aantal != null) {
    document.getElementById('ms-aantal').textContent = r.aantal;
    msAantalSectie.style.display = '';
  } else {
    msAantalSectie.style.display = 'none';
  }

  // Tagnummer + memogeschiedenis
  const msTagSectie = document.getElementById('ms-tagnummer-sectie');
  const msMemoWrap = document.getElementById('ms-memogeschiedenis-wrap');
  if (r.tagnummer) {
    document.getElementById('ms-tagnummer').textContent = r.tagnummer;
    if (r.memogeschiedenis) {
      document.getElementById('ms-memogeschiedenis').textContent = r.memogeschiedenis;
      msMemoWrap.style.display = '';
    } else {
      msMemoWrap.style.display = 'none';
    }
    msTagSectie.style.display = '';
  } else {
    msTagSectie.style.display = 'none';
  }

  renderInstructies(r.opdrachtnr, 'ms-instructies');
  resetGeluidUI('ms');
  const msGeluidSectie = document.getElementById('ms-geluid-sectie');
  if (msGeluidSectie) msGeluidSectie.style.display = '';
  const msWachtOnderdelenBtn = document.getElementById('ms-wacht-onderdelen-btn');
  if (msWachtOnderdelenBtn) msWachtOnderdelenBtn.style.display = isRepCode(r) ? '' : 'none';
  openModal('modal-start');
}

// Bijhoudt de onderdelen-tags in het afrond-formulier
let afrondOnderdelen = []; // [{ label, id? }]
let _afrondTagnrs    = []; // tagnummers bewerkt in afrond-modal
let _afrondHeropend  = false; // true als modal via potlood-knop is geopend
let _afrondAantal    = 0;  // maximaal aantal tagnummers (= r.aantal)

// Eerst vragen tonen (als die er zijn), daarna pas afrond
// ── WERKZAAMHEDEN CHECKLIST ────────────────────────────────────
let _werkCheckCallback = null;
let _werkCheckGeselecteerd = null;

function openWerkCheck(taken, onConfirm) {
  if (!taken.length) { _werkCheckGeselecteerd = null; onConfirm(); return; }
  _werkCheckCallback = onConfirm;

  const lijst = document.getElementById('wc-lijst');
  lijst.innerHTML = taken.map(t => `
    <label style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--border);cursor:pointer;user-select:none">
      <input type="checkbox" data-taak="${t.replace(/"/g,'&quot;')}" style="width:18px;height:18px;accent-color:var(--ok);cursor:pointer;flex-shrink:0">
      <span style="font-size:14px;color:var(--text)">${t}</span>
    </label>`).join('');

  document.getElementById('wc-doorgaan-btn').disabled = false;
  openModal('modal-werkcheck');
}

function updateWerkCheckBtn() {}

function bevestigWerkCheck() {
  const checkboxes = document.getElementById('wc-lijst').querySelectorAll('input[type=checkbox]');
  _werkCheckGeselecteerd = [...checkboxes].filter(cb => cb.checked).map(cb => cb.dataset.taak);
  closeModal('modal-werkcheck');
  const cb = _werkCheckCallback;
  _werkCheckCallback = null;
  if (cb) cb();
}

function _werkCheckTaken(opdrachtnr) {
  return state.reparaties
    .filter(r => r.opdrachtnr === opdrachtnr && isInstructieRegel(r) && r.artikelomschrijving)
    .map(r => r.artikelomschrijving)
    .filter((v, i, a) => a.indexOf(v) === i);
}

function openAfrond(id) {
  const r = state.reparaties.find(x => x.id === id);
  if (!r) return;
  // Wis eerdere antwoorden zodat ze niet accumuleren bij herhaalde pogingen
  vragenNotities.delete(r.id);
  vragenNotitiesOpdracht.delete(r.opdrachtnr);
  vragenBeantwoord.delete(r.id);
  const taken = _werkCheckTaken(r.opdrachtnr);
  const doAfrond = r.soort === 'voorraad'
    ? () => _openAfrondDirect(id)
    : () => startTagnrScanQueue([id], () => _openAfrondDirect(id));
  openWerkCheck(taken, doAfrond);
}

function vulWerkplaatsTaken(containerEl, opdrachtnr) {
  if (!containerEl) return;
  const taken = state.reparaties
    .filter(r => r.opdrachtnr === opdrachtnr && (r.artikelcode || '').toUpperCase() === '99-WERKPLAATS' && r.artikelomschrijving)
    .map(r => r.artikelomschrijving)
    .filter((v, i, a) => a.indexOf(v) === i);

  if (!taken.length) { containerEl.innerHTML = ''; return; }

  containerEl.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--r);padding:8px 10px;margin-bottom:6px;display:flex;flex-direction:column;gap:4px">
      <span style="font-size:10px;color:var(--muted);font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">Werkplaats werkzaamheden</span>
      ${taken.map(t => {
        const isChecked = _werkCheckGeselecteerd === null || _werkCheckGeselecteerd.includes(t);
        return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text)">
          <input type="checkbox" data-taak="${t.replace(/"/g,'&quot;')}" style="width:15px;height:15px;accent-color:var(--ok);cursor:pointer;flex-shrink:0" ${isChecked ? 'checked' : ''}>
          <span>${t}</span>
        </label>`;
      }).join('')}
    </div>`;
  _werkCheckGeselecteerd = null;
}

function leesWerkplaatsTaken(containerEl) {
  if (!containerEl) return [];
  return Array.from(containerEl.querySelectorAll('input[type=checkbox]:checked'))
    .map(cb => cb.dataset.taak).filter(Boolean);
}

function vulRegelChips(containerId, textareaId, opdrachtnr) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const regels = state.reparaties.filter(r =>
    r.opdrachtnr === opdrachtnr &&
    !isInstructieRegel(r) &&
    (r.doorsluizenjn || '').toUpperCase() === 'J'
  );
  if (!regels.length) { container.innerHTML = ''; return; }
  container.innerHTML = regels.map(r => {
    const label = r.artikelcode || r.handeling || '—';
    const safeLabel = label.replace(/'/g, "\\'");
    return `<button type="button" onclick="voegRegelTekstIn('${textareaId}','${safeLabel}')"
      style="font-size:11px;font-family:var(--mono);padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg3);color:var(--text);cursor:pointer;white-space:nowrap"
      title="Klik om in te voegen">${label}</button>`;
  }).join('');
}

function voegRegelTekstIn(textareaId, tekst) {
  const el = document.getElementById(textareaId);
  if (!el) return;
  const start = el.selectionStart ?? el.value.length;
  const end   = el.selectionEnd   ?? el.value.length;
  const voor  = el.value.substring(0, start);
  const na    = el.value.substring(end);
  const sep   = voor && !voor.endsWith(' ') && !voor.endsWith('\n') ? ' ' : '';
  el.value = voor + sep + tekst + na;
  el.selectionStart = el.selectionEnd = start + sep.length + tekst.length;
  el.focus();
}

async function _openAfrondDirect(id, heropend = false) {
  const r = state.reparaties.find(x => x.id === id);
  if (!r) return;
  state.activeMod = r;
  document.getElementById('ma-title').textContent = 'Afronden: ' + r.opdrachtnr;
  document.getElementById('ma-sub').textContent   = [r.artikelomschrijving, r.merk, r.klant_naam].filter(Boolean).join(' · ') || r.klacht || r.opdrachtnr;
  const taalBadge = document.getElementById('ma-taal-badge');
  if (taalBadge) taalBadge.textContent = TAAL_LABELS[_taalVoorkeur] || _taalVoorkeur;
  document.getElementById('ma-diagnose').value        = '';
  document.getElementById('ma-notitie').value         = '';
  document.getElementById('ma-onderdeel-extra').value = '';
  const maDiagnoseSectie = document.getElementById('ma-diagnose-sectie');
  if (maDiagnoseSectie) maDiagnoseSectie.style.display = isRepCode(r) ? '' : 'none';
  vulRegelChips('ma-regel-chips',    'ma-diagnose', r.opdrachtnr);
  vulRegelChips('ma-notitie-chips',  'ma-notitie',  r.opdrachtnr);

  // Klok: vul gemeten tijd in als advies (monteur kan aanpassen)
  const totaalMs  = getTotaalKlokMs(r.id);
  const totaalMin = Math.floor(totaalMs / 60000);
  if (totaalMin > 0) {
    document.getElementById('ma-uren').value    = Math.floor(totaalMin / 60) || '';
    document.getElementById('ma-minuten').value = totaalMin % 60 || '';
  } else {
    document.getElementById('ma-uren').value    = '';
    document.getElementById('ma-minuten').value = '';
  }

  // Heropend via potlood: herstel eerder opgeslagen diagnose, werkzaamheden en notitie
  if (heropend && !state.demoMode) {
    try {
      const { data: logs } = await sb.from('reparatie_logs')
        .select('notitie, bestede_tijd_minuten')
        .eq('reparatie_id', r.id)
        .eq('actie', 'afgerond')
        .order('aangemaakt_op', { ascending: false })
        .limit(1);
      const log = logs?.[0];
      if (log) {
        const tekst = (log.notitie || '').replace(/^\[[A-Z]+\]\s*/, '');
        const secties = tekst.split('\n\n');
        const bekendeTaken = state.reparaties
          .filter(x => x.opdrachtnr === r.opdrachtnr && (x.artikelcode || '').toUpperCase() === '99-WERKPLAATS' && x.artikelomschrijving)
          .map(x => x.artikelomschrijving)
          .filter((v, i, a) => a.indexOf(v) === i);
        for (const sectie of secties) {
          if (sectie.startsWith('Diagnose: ')) {
            document.getElementById('ma-diagnose').value = sectie.slice('Diagnose: '.length);
          } else if (sectie.startsWith('Werkzaamheden: ')) {
            const rest = sectie.slice('Werkzaamheden: '.length);
            const regels = rest.split('\n');
            const items = (regels[0] || '').split(', ').map(t => t.trim()).filter(Boolean);
            if (bekendeTaken.length && items.length && items.every(t => bekendeTaken.includes(t))) {
              _werkCheckGeselecteerd = items;
              document.getElementById('ma-notitie').value = regels.slice(1).join('\n').trim();
            } else {
              document.getElementById('ma-notitie').value = rest;
            }
          }
        }
        if (!totaalMin && log.bestede_tijd_minuten) {
          document.getElementById('ma-uren').value    = Math.floor(log.bestede_tijd_minuten / 60) || '';
          document.getElementById('ma-minuten').value = log.bestede_tijd_minuten % 60 || '';
        }
      }
    } catch { /* stil falen */ }
  }

  afrondOnderdelen = [];

  renderAfrondTags();
  vulWerkplaatsTaken(document.getElementById('ma-werkplaats-taken'), r.opdrachtnr);

  // Toon opgeslagen vragenlijst-antwoorden (meenemen_in_afrond)
  const vragenItems = [
    ...(vragenNotities.get(r.id) || []),
    ...(vragenNotitiesOpdracht.get(r.opdrachtnr) || []),
  ];
  const vragenEl  = document.getElementById('ma-vragen-antwoorden');
  const vragenTxt = document.getElementById('ma-vragen-tekst');
  if (vragenEl && vragenTxt) {
    if (vragenItems.length) {
      vragenTxt.textContent = vragenItems.join('\n');
      vragenEl.style.display = '';
    } else {
      vragenEl.style.display = 'none';
    }
  }

  // Tagnummers: uit queue (vers) of uit database (heropend via potlood)
  _afrondAantal = Number(r.aantal) || 1;
  const tagnrSectie = document.getElementById('ma-tagnr-sectie');
  document.getElementById('ma-tagnr-reeks-paneel').style.display = 'none';
  const uitQueue = _tagnrGescand.get(r.id) || [];
  _afrondHeropend = heropend || uitQueue.length === 0;
  if (uitQueue.length) {
    _afrondTagnrs = [...uitQueue];
    tagnrSectie.style.display = '';
    renderAfrondTagnrLijst();
  } else if (heropend) {
    _afrondTagnrs = [];
    tagnrSectie.style.display = vereistTagnummer(r) ? '' : 'none';
    renderAfrondTagnrLijst();
    if (!state.demoMode) {
      sb.from('tagnr_scans').select('tagnr').eq('reparatie_id', r.id)
        .then(({ data }) => {
          _afrondTagnrs = (data || []).map(x => x.tagnr);
          if (_afrondTagnrs.length) tagnrSectie.style.display = '';
          renderAfrondTagnrLijst();
        });
    }
  } else {
    tagnrSectie.style.display = 'none';
    _afrondTagnrs = [];
  }

  openModal('modal-afrond');
}

function renderAfrondTags() {
  const container = document.getElementById('ma-onderdelen-tags');
  const leeg      = document.getElementById('ma-tags-leeg');
  // Verwijder bestaande tags (niet het leeg-label)
  Array.from(container.children).forEach(c => { if (c.id !== 'ma-tags-leeg') c.remove(); });

  if (!afrondOnderdelen.length) {
    leeg.style.display = '';
    return;
  }
  leeg.style.display = 'none';
  afrondOnderdelen.forEach((o, i) => {
    const tag = document.createElement('div');
    tag.className = 'onderdeel-tag';
    tag.innerHTML = `${o.label}<button class="onderdeel-tag-remove" onclick="verwijderAfrondOnderdeel(${i})">×</button>`;
    container.appendChild(tag);
  });
}

function verwijderAfrondOnderdeel(i) {
  afrondOnderdelen.splice(i, 1);
  renderAfrondTags();
}

function voegExtraOnderdeelToe() {
  const input = document.getElementById('ma-onderdeel-extra');
  const val   = input.value.trim();
  if (!val) return;
  afrondOnderdelen.push({ label: val });
  input.value = '';
  renderAfrondTags();
}

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'modal-start' || id === 'modal-detail') stopGeluid();
  const card = state.activeMod ? document.getElementById('card-'+state.activeMod.id) : null;
  if (card) { card.style.transform = ''; const a = document.getElementById('action-'+state.activeMod.id); if(a) a.style.opacity=0; }
}

function showLogout() {
  document.getElementById('ml-naam').textContent = state.monteur.naam;
  openModal('modal-logout');
}

// Verbergt de app en toont het inlogscherm — gedeeld door het handmatige
// 'Afmelden' (logout()) en door een automatische sessie-verlopen-redirect
// (wplaatsSessieVerlopen() hieronder, aangeroepen vanuit api.js bij een 401
// op een API-aanroep).
function toonInlogscherm() {
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').classList.remove('hidden');
  state.monteur = null;
}

async function logout() {
  closeModal('modal-logout');
  await sb.auth.signOut(); // wist token/monteur uit localStorage
  toonInlogscherm();
}

// Aangeroepen vanuit api.js zodra een API-aanroep een 401 teruggeeft
// (token ongeldig/verlopen) — stuurt de gebruiker terug naar het
// inlogscherm i.p.v. de app te laten hangen op een lege/kapotte databalk.
// api.js heeft de token al lokaal gewist vóórdat dit aangeroepen wordt.
window.wplaatsSessieVerlopen = function() {
  toonInlogscherm();
  const fout = document.getElementById('login-fout');
  if (fout) fout.textContent = 'Sessie verlopen — log opnieuw in.';
};

// ── ACTIES ────────────────────────────────────────────────────
async function startReparatie() {
  const r = state.activeMod;
  if (!r) return;
  closeModal('modal-start');
  const mijnId = state.monteur.id;
  const opdrachtnr = r.opdrachtnr;

  const now = new Date().toISOString();
  if (state.demoMode) {
    r.status = statusInBehandeling(r);
    r.monteur_id = mijnId;
    r.monteurs   = { naam: state.monteur.naam, initialen: state.monteur.initialen };
    r.in_behandeling_op = now;
    // Auto-claim N-regels als alle J-regels van de opdracht nu geclaimd zijn
    const alleJ = state.reparaties.filter(r2 => r2.opdrachtnr === opdrachtnr && (r2.doorsluizenjn||'').toUpperCase() === 'J' && !isInstructieRegel(r2));
    if (alleJ.every(r2 => r2.monteur_id)) {
      state.reparaties.filter(r2 => r2.opdrachtnr === opdrachtnr && (r2.doorsluizenjn||'').toUpperCase() === 'N' && !r2.monteur_id)
        .forEach(n => { n.status = statusInBehandeling(n); n.monteur_id = mijnId; n.monteurs = { naam: state.monteur.naam, initialen: state.monteur.initialen }; n.in_behandeling_op = now; });
    }
    renderLists();
    switchTab('behandeling');
    clearSelectie();
    toast('✓ ' + opdrachtnr + ' opgepakt');
    return;
  }

  try {
    const nieuweStatus = statusInBehandeling(r);
    await updateReparatieStatus(r.id, {
      status: nieuweStatus,
      monteur_id: mijnId,
      toegewezen_door: r.toegewezen_door || 'monteur',
      in_behandeling_op: now,
    });
    await insertLog({ reparatie_id: r.id, monteur_id: mijnId, monteur_naam: state.monteur.naam, actie: 'start', opdrachtnr, regelnummer: r.regelnummer, opdrachtcode: r.opdrachtcode || null, artikelcode: r.artikelcode, aantal: r.aantal, artikelomschrijving: r.artikelomschrijving, serienummer: r.serienummer, tagnummer: r.tagnummer, opdrachtstatus: r.status || null, nieuwe_opdrachtstatus: nieuweStatus });
    // Auto-claim N-regels als alle J-regels van de opdracht nu geclaimd zijn
    const alleJ = state.reparaties.filter(r2 => r2.opdrachtnr === opdrachtnr && (r2.doorsluizenjn||'').toUpperCase() === 'J' && !isInstructieRegel(r2));
    const alleJGeclaimd = alleJ.every(r2 => r2.monteur_id || r2.id === r.id);
    if (alleJGeclaimd) {
      const nRegels = state.reparaties.filter(r2 => r2.opdrachtnr === opdrachtnr && (r2.doorsluizenjn||'').toUpperCase() === 'N' && !r2.monteur_id);
      for (const n of nRegels) {
        await updateReparatieStatus(n.id, { status: statusInBehandeling(n), monteur_id: mijnId, toegewezen_door: 'monteur', in_behandeling_op: now });
      }
    }
    await laadReparaties();
    switchTab('behandeling');
    clearSelectie();
    toast('✓ ' + opdrachtnr + ' opgepakt');
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

async function vrijgevenReparatie() {
  const r = state.activeMod;
  if (!r) return;
  closeModal('modal-detail');

  if (state.demoMode) {
    r.status = statusOpen(r);
    r.monteur_id = null;
    r.monteurs   = null;
    renderLists();
    switchTab('open');
    toast('↩ ' + r.opdrachtnr + ' vrijgegeven');
    return;
  }

  try {
    const nieuweStatus = statusOpen(r);
    await updateReparatieStatus(r.id, { status: nieuweStatus, monteur_id: null, in_behandeling_op: null });
    await insertLog({ reparatie_id: r.id, monteur_id: state.monteur.id, monteur_naam: state.monteur.naam, actie: 'vrijgegeven', opdrachtnr: r.opdrachtnr, regelnummer: r.regelnummer, opdrachtcode: r.opdrachtcode || null, artikelcode: r.artikelcode, aantal: r.aantal, artikelomschrijving: r.artikelomschrijving, serienummer: r.serienummer, tagnummer: r.tagnummer, opdrachtstatus: r.status || null, nieuwe_opdrachtstatus: nieuweStatus });
    await laadReparaties();
    switchTab('open');
    toast('↩ ' + r.opdrachtnr + ' vrijgegeven');
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function resetGeluidUI(prefix) {
  const opname = document.getElementById(prefix + '-geluid-opname');
  const speler = document.getElementById(prefix + '-geluid-speler');
  if (opname) opname.style.display = 'none';
  if (speler) speler.style.display = 'none';
}

function stopGeluid() {
  // stub — audio recording niet actief
}

// REP-opdrachten (behalve REPKR/REPPR) — bepaalt zichtbaarheid van het diagnose-veld
// en de 'wacht op onderdelen'-knop; andere opdrachtcodes hebben dit niet nodig.
function isRepCode(r) {
  const code = (r?.opdrachtcode || '').toUpperCase();
  return code.startsWith('REP') && !code.startsWith('REPKR') && !code.startsWith('REPPR');
}

// Statusverloop verschilt per soort regel, bepaald via dezelfde isRepCode()
// als hierboven: reparaties lopen 445 (open) → 465 (in behandeling) → 519
// (afgerond), leveringen 500 (open) → 470 (in behandeling) → 519. Afronden
// komt voor beide op 519 uit, dus daar is geen aparte functie voor nodig.
function statusOpen(r)          { return isRepCode(r) ? '445' : '500'; }
function statusInBehandeling(r) { return isRepCode(r) ? '465' : '470'; }

function isRepUitkomstRegel(r) {
  const code = (r.opdrachtcode || '').toUpperCase();
  return code.startsWith('REP') && !code.startsWith('REPKR') && !code.startsWith('REPPR')
    && (r.doorsluizenjn || '').toUpperCase() === 'J';
}

function afrondOfUitkomst() {
  const r = state.activeMod;
  if (!r) return;
  const notitie = document.getElementById('ma-notitie').value.trim();
  const taken   = leesWerkplaatsTaken(document.getElementById('ma-werkplaats-taken'));
  if (!notitie && !taken.length) { toast('⚠ Vul minimaal in wat je hebt gedaan'); return; }

  if (isRepUitkomstRegel(r)) {
    document.getElementById('mu-sub').textContent =
      `${r.artikelcode} · ${r.artikelomschrijving || ''} · Opdracht ${r.opdrachtnr}`;
    closeModal('modal-afrond');
    openModal('modal-uitkomst');
  } else {
    // Vragenlijst NA het invullen van het formulier, vóór de DB-schrijfactie
    startVragenQueue([r.id], () => afrondReparatie(null));
  }
}

function kiesUitkomst(uitkomst) {
  const r = state.activeMod;
  if (!r) return;
  closeModal('modal-uitkomst');
  startVragenQueue([r.id], () => afrondReparatie(uitkomst));
}

// Ná het afronden van (een deel van) de J-regels van een opdracht: als
// daarmee alle J-regels afgerond zijn, ronden de bijbehorende N-regels
// (onderdelen) automatisch mee af — anders blijven die achter in 'in
// behandeling' terwijl de opdracht zelf al klaar is. Zelfde principe als
// het auto-claimen van N-regels bij claimen, zie startReparatie() en
// bevestigClaimAlles(). Aanroepen ná een laadReparaties()/state-update
// zodat de zojuist afgeronde regel(s) al meetellen in de check.
async function voltooiNRegelsIndienCompleet(opdrachtnr, now) {
  const alleJRegels = state.reparaties.filter(r =>
    r.opdrachtnr === opdrachtnr && (r.doorsluizenjn || '').toUpperCase() === 'J' && !isInstructieRegel(r)
  );
  if (!alleJRegels.length || !alleJRegels.every(isRegelAfgerond)) return;

  const nRegels = state.reparaties.filter(r =>
    r.opdrachtnr === opdrachtnr && (r.doorsluizenjn || '').toUpperCase() === 'N' && !isRegelAfgerond(r)
  );
  if (!nRegels.length) return;

  if (state.demoMode) {
    nRegels.forEach(n => { n.status = '519'; n.afgerond_op = now; });
    return;
  }

  for (const n of nRegels) {
    try {
      await updateReparatieStatus(n.id, { status: '519', afgerond_op: now });
      await insertLog({
        reparatie_id: n.id,
        monteur_id: state.monteur.id,
        monteur_naam: state.monteur.naam,
        actie: 'afgerond',
        opdrachtnr: n.opdrachtnr,
        regelnummer: n.regelnummer,
        opdrachtcode: n.opdrachtcode || null,
        artikelcode: n.artikelcode,
        aantal: n.aantal,
        artikelomschrijving: n.artikelomschrijving,
        serienummer: n.serienummer,
        tagnummer: n.tagnummer,
        notitie: 'Automatisch afgerond — alle regels van de opdracht zijn klaar',
        opdrachtstatus: n.status || null,
        nieuwe_opdrachtstatus: '519',
      });
    } catch (e) {
      toast('Fout bij automatisch afronden onderdeel: ' + e.message);
    }
  }
  await laadReparaties();
}

async function afrondReparatie(uitkomst) {
  const r = state.activeMod;
  if (!r) return;
  closeModal('modal-uitkomst');
  const diagnose   = document.getElementById('ma-diagnose').value.trim();
  const notitieVrij = document.getElementById('ma-notitie').value.trim();
  const taken      = leesWerkplaatsTaken(document.getElementById('ma-werkplaats-taken'));
  const notitie    = [taken.join(', '), notitieVrij].filter(Boolean).join('\n');
  const onderdelen = afrondOnderdelen.map(o => o.label).join(', ');
  const uren       = parseInt(document.getElementById('ma-uren').value) || 0;
  const minuten    = parseInt(document.getElementById('ma-minuten').value) || 0;
  if (uren >= 10 && !confirm(`Let op: je probeert ${uren} uur in te vullen. Klopt dit?`)) return;
  const totalMin   = uren * 60 + minuten;

  const vragenAfrondItems = [
    ...(vragenNotities.get(r.id) || []),
    ...(vragenNotitiesOpdracht.get(r.opdrachtnr) || []),
  ];

  const notitieGecombineerd = [
    diagnose               ? `Diagnose: ${diagnose}`     : '',
    notitie                ? `Werkzaamheden: ${notitie}` : '',
    vragenAfrondItems.length ? vragenAfrondItems.join('\n') : '',
  ].filter(Boolean).join('\n\n');

  const notitieMetUitkomst = uitkomst
    ? `[${uitkomst.toUpperCase()}] ${notitieGecombineerd}`
    : notitieGecombineerd;

  closeModal('modal-afrond');
  const now = new Date().toISOString();
  // Afgekeurd apparaat krijgt een eigen eindstatus (370) i.p.v. de normale
  // afrond-status 519 — alleen bereikbaar via de uitkomst-vraag hierboven
  // (dus alleen bij REP-J-regels, zie isRepUitkomstRegel()).
  const eindStatus = uitkomst === 'afgekeurd' ? '370' : '519';

  if (state.demoMode) {
    r.status = eindStatus;
    r.afgerond_op = now;
    await voltooiNRegelsIndienCompleet(r.opdrachtnr, now);
    renderLists();
    switchTab('afgerond');
    toast('✓ ' + r.opdrachtnr + ' afgerond');
    return;
  }

  try {
    clearKlok(r.id); // klok wissen bij afronden
    stopKlokTick();
    await updateReparatieStatus(r.id, { status: eindStatus, afgerond_op: now });
    const logRij = await insertLog({
      reparatie_id: r.id,
      monteur_id: state.monteur.id,
      monteur_naam: state.monteur.naam,
      actie: 'afgerond',
      opdrachtnr: r.opdrachtnr,
      regelnummer: r.regelnummer,
      opdrachtcode: r.opdrachtcode || null,
      artikelcode: r.artikelcode,
      aantal: r.aantal,
      artikelomschrijving: r.artikelomschrijving,
      serienummer: r.serienummer,
      tagnummer: r.tagnummer,
      notitie: notitieMetUitkomst || null,
      // Los van 'notitie' (die blijft samengeperst t.b.v. weergave in de
      // app) — schone, aparte velden voor data-doeleinden (rapportage/
      // terugkoppeling), zie internal-docs/architectuur-en-audit.md §10.3.
      diagnose: diagnose || null,
      werkzaamheden: notitie || null,
      uitkomst: uitkomst || null,
      opdrachtstatus: r.status || null,       // status vóór afronden
      nieuwe_opdrachtstatus: eindStatus,      // status ná afronden (519, of 370 bij afgekeurd)
      magazijnlocatie: r.magazijnlocatie || null,
      uiterste_datum_afdeling: r.uiterste_datum_afdeling || null,
      gebruikte_onderdelen: onderdelen || null,
      bestede_tijd_minuten: totalMin || null,
      taal: _taalVoorkeur,
    });
    if (_taalVoorkeur !== 'nl' && (diagnose || notitie)) {
      slaVertaalRijOp(logRij?.id, r.opdrachtnr, diagnose, notitie, _taalVoorkeur);
    }
    if (_afrondTagnrs.length) _tagnrGescand.set(r.id, _afrondTagnrs);
    if (_afrondHeropend && _afrondTagnrs.length) {
      await sb.from('tagnr_scans').delete().eq('reparatie_id', r.id);
    }
    await _insertTagnrScans(logRij?.id, r.id, r.opdrachtnr, r.regelnummer, r.artikelcode, state.monteur.id, now);
    await laadReparaties();
    await voltooiNRegelsIndienCompleet(r.opdrachtnr, now);
    switchTab('afgerond');
    toast('✓ ' + r.opdrachtnr + ' afgerond');
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

// ── BULK AFRONDEN ─────────────────────────────────────────────
let bulkAfrondIds   = [];
let _mabGemetenMin  = 0;
let _mabPerRegel    = false; // true als opdrachtcode begint met REP

function herberekeenBulkTijd() {
  const totaal = bulkAfrondIds.reduce((s, id) => {
    const u = parseInt(document.getElementById('mab-uren-' + id)?.value) || 0;
    const m = parseInt(document.getElementById('mab-tijd-' + id)?.value) || 0;
    return s + u * 60 + m;
  }, 0);
  const allocEl    = document.getElementById('mab-totaal-alloc');
  const verschilEl = document.getElementById('mab-verschil-label');
  if (allocEl) {
    const u = Math.floor(totaal / 60), m = totaal % 60;
    allocEl.textContent = u > 0 ? `${u}u ${m}min` : `${m} min`;
  }
  if (!verschilEl) return;
  if (_mabGemetenMin <= 0) { verschilEl.style.display = 'none'; return; }
  const diff = totaal - _mabGemetenMin;
  if (diff === 0) {
    verschilEl.style.display = 'none';
  } else {
    verschilEl.style.display = '';
    verschilEl.style.color   = 'var(--danger)';
    verschilEl.textContent   = diff > 0
      ? `⚠ ${diff} minuten te veel gealloceerd`
      : `⚠ ${Math.abs(diff)} minuten te weinig gealloceerd`;
  }
}

async function openBulkAfrond(ids, opdrachtnr, event) {
  event.stopPropagation();

  // Kritische check rechtstreeks uit DB — niet vertrouwen op lokale state
  const mijnId = state.monteur?.id;
  if (!state.demoMode) {
    try {
      const { data: openRegels, error } = await sb
        .from('reparaties')
        .select('id, status, monteur_id, artikelcode, doorsluizenjn, opdrachtcode')
        .eq('opdrachtnr', opdrachtnr)
        .neq('status', '519')
        .is('afgerond_op', null);
      if (error) throw error;
      const teAfronden = new Set(ids.map(String));
      const blokkeer = (openRegels || []).filter(r =>
        teAfronden.has(String(r.id)) &&
        r.status !== statusInBehandeling(r)
      );
      if (blokkeer.length) {
        toast(`Kan niet afronden — ${blokkeer.length} van jouw regel${blokkeer.length !== 1 ? 's hebben' : ' heeft'} niet de status 'in behandeling'.`);
        await laadReparaties();
        return;
      }
    } catch(e) {
      toast('Fout bij controle: ' + e.message);
      return;
    }
  }

  bulkAfrondIds = ids;
  document.getElementById('mab-title').textContent = 'Afronden: ' + opdrachtnr;
  document.getElementById('mab-sub').textContent   = ids.length + ' regel' + (ids.length !== 1 ? 's' : '') + ' afronden';

  // Bepaal of REP-modus (per-regel diagnose + werkzaamheden)
  const hoofd = state.reparaties.find(r => r.opdrachtnr === opdrachtnr);
  _mabPerRegel = (hoofd?.opdrachtcode || '').toUpperCase().startsWith('REP');

  // Toon of verberg gedeelde velden. Diagnose hoort alleen bij REP-opdrachten
  // (dan per-regel, zie tekstVelden hieronder) — bij niet-REP dus nooit tonen,
  // ook niet als gedeeld veld. 'Wat heb je gedaan?' blijft wel gewoon gedeeld
  // zichtbaar bij niet-REP.
  const gedeeldBlok = document.getElementById('mab-diagnose')?.closest('.form-group');
  const gedeeldBlok2 = document.getElementById('mab-notitie')?.closest('.form-group');
  if (gedeeldBlok)  gedeeldBlok.style.display  = 'none';
  if (gedeeldBlok2) gedeeldBlok2.style.display = _mabPerRegel ? 'none' : '';
  if (!_mabPerRegel) {
    document.getElementById('mab-diagnose').value = '';
    document.getElementById('mab-notitie').value  = '';
    vulRegelChips('mab-regel-chips',   'mab-diagnose', opdrachtnr);
    vulRegelChips('mab-notitie-chips', 'mab-notitie',  opdrachtnr);
  }

  // Gemeten totaaltijd als advies
  _mabGemetenMin = Math.floor(ids.reduce((s, id) => s + getTotaalKlokMs(id), 0) / 60000);
  const gemetenBanner = document.getElementById('mab-gemeten-banner');
  const gemetenLabel  = document.getElementById('mab-gemeten-label');
  if (_mabGemetenMin > 0) {
    const gu = Math.floor(_mabGemetenMin / 60), gm = _mabGemetenMin % 60;
    gemetenLabel.textContent = gu > 0 ? `${gu}u ${String(gm).padStart(2,'0')}m (${_mabGemetenMin} min)` : `${gm} min`;
    gemetenBanner.style.display = '';
  } else {
    gemetenBanner.style.display = 'none';
  }

  // Verdeel gemeten tijd evenredig als startwaarde
  const startPerRegel = ids.length > 0 && _mabGemetenMin > 0
    ? Math.floor(_mabGemetenMin / ids.length) : 0;
  const startUren = Math.floor(startPerRegel / 60);
  const startMin  = startPerRegel % 60;

  // Per-regel rijen renderen (altijd tijd, bij REP ook diagnose + werkzaamheden)
  const container = document.getElementById('mab-regels-container');
  container.innerHTML = ids.map(id => {
    const r = state.reparaties.find(x => x.id === id);
    const label = r ? ([r.artikelcode, r.artikelomschrijving].filter(Boolean).join(' · ') || r.handeling || id) : id;
    const tekstVelden = _mabPerRegel ? `
      <div style="margin-bottom:6px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Diagnose</div>
        <textarea class="form-textarea" id="mab-diagnose-${id}" placeholder="Oorzaak van het defect..." style="margin-bottom:0;font-size:12px"></textarea>
      </div>
      <div style="margin-bottom:8px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Werkzaamheden</div>
        <textarea class="form-textarea" id="mab-notitie-${id}" placeholder="Uitgevoerde werkzaamheden..." style="margin-bottom:0;font-size:12px"></textarea>
      </div>` : '';
    const tijdRij = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      ${_mabPerRegel ? '' : `<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(label)}">${esc(label)}</span>`}
      <input type="number" class="form-input tijd-input" id="mab-uren-${id}"
        style="width:64px;flex-shrink:0" placeholder="0" min="0" max="99"
        value="${startUren || ''}" oninput="herberekeenBulkTijd()">
      <span class="tijd-label-sm" style="flex-shrink:0">uur</span>
      <input type="number" class="form-input tijd-input" id="mab-tijd-${id}"
        style="width:64px;flex-shrink:0" placeholder="0" min="0" max="59"
        value="${startMin || ''}" oninput="herberekeenBulkTijd()">
      <span class="tijd-label-sm" style="flex-shrink:0">min</span>
    </div>`;
    return _mabPerRegel
      ? `<div style="border:1px solid var(--border);border-radius:var(--r);padding:11px;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;font-family:var(--mono);margin-bottom:9px">${esc(label)}</div>
          ${tekstVelden}${tijdRij}
        </div>`
      : tijdRij;
  }).join('');
  herberekeenBulkTijd();

  // Wis eerdere antwoorden zodat ze niet accumuleren bij herhaalde pogingen
  ids.forEach(id => {
    vragenNotities.delete(id);
    vragenBeantwoord.delete(id);
    const rep = state.reparaties.find(x => x.id === id);
    if (rep) vragenNotitiesOpdracht.delete(rep.opdrachtnr);
  });

  // Verberg vragenlijst-sectie (wordt gevuld ná het formulier)
  const mabEl = document.getElementById('mab-vragen-antwoorden');
  if (mabEl) mabEl.style.display = 'none';

  const taken = _werkCheckTaken(opdrachtnr);
  openWerkCheck(taken, () => {
    vulWerkplaatsTaken(document.getElementById('mab-werkplaats-taken'), opdrachtnr);
    startTagnrScanQueue(ids, () => openModal('modal-afrond-bulk'));
  });
}

async function bevestigBulkAfrond() {
  // Laatste check rechtstreeks uit DB — voorkomt dat tussendoor vrijgegeven regels door de mazen glippen
  const mijnId = state.monteur?.id;
  const eersteRep = state.reparaties.find(r => bulkAfrondIds.includes(r.id));
  if (eersteRep && !state.demoMode) {
    try {
      const { data: openRegels, error } = await sb
        .from('reparaties')
        .select('id, status, monteur_id, artikelcode, doorsluizenjn, opdrachtcode')
        .eq('opdrachtnr', eersteRep.opdrachtnr)
        .neq('status', '519')
        .is('afgerond_op', null);
      if (error) throw error;
      const teAfronden2 = new Set(bulkAfrondIds.map(String));
      const blokkeer = (openRegels || []).filter(r =>
        teAfronden2.has(String(r.id)) && r.status !== statusInBehandeling(r)
      );
      if (blokkeer.length) {
        toast(`Kan niet opslaan — ${blokkeer.length} van jouw regel${blokkeer.length !== 1 ? 's hebben' : ' heeft'} niet (meer) de status 'in behandeling'.`);
        closeModal('modal-afrond-bulk');
        await laadReparaties();
        return;
      }
    } catch(e) {
      toast('Fout bij controle: ' + e.message);
      closeModal('modal-afrond-bulk');
      return;
    }
  }

  // Lees formulierdata uit DOM VOOR het sluiten van de modal
  const gedeeldDiagnose    = _mabPerRegel ? '' : document.getElementById('mab-diagnose').value.trim();
  const gedeeldNotitieVrij = _mabPerRegel ? '' : document.getElementById('mab-notitie').value.trim();
  const taken = leesWerkplaatsTaken(document.getElementById('mab-werkplaats-taken'));
  const gedeeldNotitie = [taken.join(', '), gedeeldNotitieVrij].filter(Boolean).join('\n');

  const tijdPerRegel     = {};
  const diagnosePerRegel = {};
  const notitiePerRegel  = {};
  for (const id of bulkAfrondIds) {
    const _u = parseInt(document.getElementById('mab-uren-' + id)?.value) || 0;
    const _m = parseInt(document.getElementById('mab-tijd-' + id)?.value) || 0;
    tijdPerRegel[id] = _u * 60 + _m;
    diagnosePerRegel[id] = _mabPerRegel
      ? (document.getElementById('mab-diagnose-' + id)?.value.trim() || '')
      : gedeeldDiagnose;
    notitiePerRegel[id] = _mabPerRegel
      ? ([taken.join(', '), document.getElementById('mab-notitie-' + id)?.value.trim() || ''].filter(Boolean).join('\n'))
      : gedeeldNotitie;
  }

  closeModal('modal-afrond-bulk');

  if (state.demoMode) {
    const now = new Date().toISOString();
    const demoOpdrachtnr = state.reparaties.find(x => x.id === bulkAfrondIds[0])?.opdrachtnr;
    bulkAfrondIds.forEach(id => {
      const r = state.reparaties.find(x => x.id === id);
      if (r) { r.status = '519'; r.afgerond_op = now; }
    });
    if (demoOpdrachtnr) await voltooiNRegelsIndienCompleet(demoOpdrachtnr, now);
    renderLists(); switchTab('afgerond');
    toast(`✓ ${bulkAfrondIds.length} regels afgerond`);
    return;
  }

  // Vragenlijst NA formulier, VÓÓr DB-schrijfactie
  startVragenQueue(bulkAfrondIds, async () => {
    const now = new Date().toISOString();
    const gezienOpdrachtnrsBulk = new Set();
    let bulkOpdrachtnr = null;
    try {
      for (const id of bulkAfrondIds) {
        const r = state.reparaties.find(x => x.id === id);
        if (!r) continue;
        if (!bulkOpdrachtnr) bulkOpdrachtnr = r.opdrachtnr;
        const vragenItems = [...(vragenNotities.get(id) || [])];
        if (!gezienOpdrachtnrsBulk.has(r.opdrachtnr)) {
          gezienOpdrachtnrsBulk.add(r.opdrachtnr);
          vragenItems.push(...(vragenNotitiesOpdracht.get(r.opdrachtnr) || []));
        }
        const rDiagnose = diagnosePerRegel[id] || '';
        const rNotitie  = notitiePerRegel[id]  || '';
        const notitieGecombineerd = [
          rDiagnose          ? `Diagnose: ${rDiagnose}`     : '',
          rNotitie           ? `Werkzaamheden: ${rNotitie}` : '',
          vragenItems.length ? vragenItems.join('\n')       : '',
        ].filter(Boolean).join('\n\n');

        await updateReparatieStatus(id, { status: '519', afgerond_op: now });
        const logRij = await insertLog({
          reparatie_id: id,
          monteur_id:   state.monteur.id,
          monteur_naam: state.monteur.naam,
          actie:        'afgerond',
          opdrachtnr:   r.opdrachtnr,
          regelnummer:  r.regelnummer,
          opdrachtcode: r.opdrachtcode || null,
          artikelcode:  r.artikelcode,
          aantal:       r.aantal,
          artikelomschrijving: r.artikelomschrijving,
          serienummer:  r.serienummer,
          tagnummer:    r.tagnummer,
          notitie:      notitieGecombineerd || null,
          // Zie afrondReparatie() hierboven — zelfde principe, losse
          // velden naast de samengeperste 'notitie'.
          diagnose:     rDiagnose || null,
          werkzaamheden: rNotitie || null,
          opdrachtstatus: r.status || null,       // status vóór afronden
          nieuwe_opdrachtstatus: '519',           // status ná afronden
          magazijnlocatie: r.magazijnlocatie || null,
          uiterste_datum_afdeling: r.uiterste_datum_afdeling || null,
          bestede_tijd_minuten: tijdPerRegel[id] || null,
        });
        await _insertTagnrScans(logRij?.id, id, r.opdrachtnr, r.regelnummer, r.artikelcode, state.monteur.id, now);
      }
      await laadReparaties();
      if (bulkOpdrachtnr) await voltooiNRegelsIndienCompleet(bulkOpdrachtnr, now);
      switchTab('afgerond');
      toast(`✓ ${bulkAfrondIds.length} regels afgerond`);
    } catch(e) {
      toast('Fout: ' + e.message);
    }
  });
}

// ── ARTIKEL VOORRAAD ──────────────────────────────────────────
let artikelVoorraad = {}; // { artikelcode: { aantal, min_aantal } }

async function laadArtikelVoorraad() {
  if (state.demoMode) return;
  try {
    const { data, error } = await sb.from('artikel_voorraad')
      .select('artikelcode, aantal, min_aantal');
    if (error) throw error;
    artikelVoorraad = {};
    (data || []).forEach(r => { artikelVoorraad[r.artikelcode] = r; });
  } catch { /* stil falen — tabel bestaat nog niet */ }
}

function voorraadBadgeHTML(artikelcode) {
  if (!artikelcode || !artikelVoorraad[artikelcode]) return '';
  const v = artikelVoorraad[artikelcode];
  const laag = v.min_aantal != null && v.aantal <= v.min_aantal;
  const kleur = v.aantal === 0
    ? 'background:rgba(217,48,37,.12);color:var(--danger);border:1px solid rgba(217,48,37,.3)'
    : laag
    ? 'background:rgba(245,158,11,.12);color:#b45309;border:1px solid rgba(245,158,11,.3)'
    : 'background:rgba(26,143,79,.12);color:var(--ok);border:1px solid rgba(26,143,79,.3)';
  const label = v.aantal === 0 ? '✗ Geen voorraad' : `📦 Voorraad: ${v.aantal}`;
  return `<span style="font-size:11px;font-family:var(--mono);padding:2px 8px;border-radius:10px;${kleur}">${label}</span>`;
}

// ── ONDERDELEN ────────────────────────────────────────────────
let alleOnderdelen = [];
let geselecteerdOnderdeel = null;

function getDemoOnderdelen() {
  return [
    { id: 'o1', artikelnr: 'PMP-5040',   naam: 'Afvoerpomp universeel',      voorraad: 3 },
    { id: 'o2', artikelnr: 'LGR-6205',   naam: 'Lager 6205 2RS',             voorraad: 5 },
    { id: 'o3', artikelnr: 'RBR-DEUR',   naam: 'Deurrubbber universeel',      voorraad: 2 },
    { id: 'o4', artikelnr: 'HTR-3000W',  naam: 'Verwarmingselement 3000W',    voorraad: 0 },
    { id: 'o5', artikelnr: 'BSN-MODULE', naam: 'Besturingsmodule Bosch',      voorraad: 0 },
    { id: 'o6', artikelnr: 'BSN-DEUR',   naam: 'Deurslot Bosch/Siemens',     voorraad: 1 },
  ];
}

async function laadOnderdelen() {
  if (state.demoMode) { alleOnderdelen = getDemoOnderdelen(); return; }
  try {
    const { data, error } = await sb.from('onderdelen').select('*').order('naam');
    if (error) throw error;
    alleOnderdelen = data;
  } catch {
    alleOnderdelen = getDemoOnderdelen();
  }
}

// ── DETAIL MODAL ──────────────────────────────────────────────
function openDetail(id) {
  const r = state.reparaties.find(x => x.id === id);
  if (!r) return;
  state.activeMod = r;
  document.getElementById('md-titel').textContent  = r.opdrachtnr;
  document.getElementById('md-sub').textContent    = r.opdrachtcode || r.abonneecode || '';
  document.getElementById('md-klacht').textContent = r.klacht || '—';
  renderInstructies(r.opdrachtnr, 'md-instructies');
  document.getElementById('md-klant').textContent  = `${r.klant_naam || ''}${r.klant_nummer ? ' ('+r.klant_nummer+')' : ''}`;

  // Artikelcode
  const mdArtSectie = document.getElementById('md-artikelcode-sectie');
  if (r.artikelcode && !isInstructieRegel(r)) {
    document.getElementById('md-artikelcode').textContent = r.artikelcode;
    const mdVoorraad = document.getElementById('md-voorraad-badge');
    if (mdVoorraad) mdVoorraad.innerHTML = voorraadBadgeHTML(r.artikelcode);
    mdArtSectie.style.display = '';
  } else {
    mdArtSectie.style.display = 'none';
  }

  // Apparaat
  const mdApparaatSectie = document.getElementById('md-apparaat-sectie');
  if (r.artikelomschrijving) {
    document.getElementById('md-apparaat').textContent = [r.artikelomschrijving, r.merk, r.model].filter(Boolean).join(' · ');
    mdApparaatSectie.style.display = '';
  } else {
    mdApparaatSectie.style.display = 'none';
  }

  // Tagnummer + memogeschiedenis
  const mdTagSectie = document.getElementById('md-tagnummer-sectie');
  const mdMemoWrap = document.getElementById('md-memogeschiedenis-wrap');
  if (r.tagnummer) {
    document.getElementById('md-tagnummer').textContent = r.tagnummer;
    if (r.memogeschiedenis) {
      document.getElementById('md-memogeschiedenis').textContent = r.memogeschiedenis;
      mdMemoWrap.style.display = '';
    } else {
      mdMemoWrap.style.display = 'none';
    }
    mdTagSectie.style.display = '';
  } else {
    mdTagSectie.style.display = 'none';
  }

  // Aantal
  const mdAantalSectie = document.getElementById('md-aantal-sectie');
  if (r.aantal != null) {
    document.getElementById('md-aantal').textContent = r.aantal;
    mdAantalSectie.style.display = '';
  } else {
    mdAantalSectie.style.display = 'none';
  }

  resetGeluidUI('md');
  const mdGeluidSectie = document.getElementById('md-geluid-sectie');
  if (mdGeluidSectie) mdGeluidSectie.style.display = '';
  laadKlokVoorReparatie();
  // Als de order al van de huidige monteur is → direct naar actiesmenu
  if (r.status === statusInBehandeling(r) && String(r.monteur_id) === String(state.monteur?.id)) {
    toonActiesView();
  } else {
    toonKeuzeView();
  }
  openModal('modal-detail');
}

let _tagHistorieLaadt = false;
async function toggleTagHistorie(prefix) {
  prefix = prefix || 'md';
  const el  = document.getElementById(prefix + '-tag-historie');
  const knop = document.getElementById(prefix + '-tag-historie-knop');
  const r   = state.activeMod;
  if (!r?.tagnummer) return;

  if (el.style.display !== 'none') {
    el.style.display = 'none';
    knop.textContent = '📋 Memo';
    return;
  }

  // Al geladen? Gewoon tonen
  if (el.innerHTML) {
    el.style.display = '';
    knop.textContent = '▲ Memo';
    return;
  }

  knop.textContent = '⏳ Laden…';

  let logs = [];
  if (!state.demoMode) {
    try {
      const { data, error } = await sb.from('reparatie_logs')
        .select('opdrachtnr, actie, notitie, gebruikte_onderdelen, bestede_tijd_minuten, monteur_naam, aangemaakt_op')
        .eq('tagnummer', r.tagnummer)
        .neq('actie', 'verwijderd_door_sync')
        .neq('actie', 'start')
        .order('aangemaakt_op', { ascending: false })
        .limit(30);
      if (error) console.error('Tagnummer memo fout:', error);
      logs = data || [];
    } catch(e) { console.error(e); logs = []; }
  }

  if (!logs.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:8px 0">Geen geschiedenis gevonden voor tagnummer ${r.tagnummer}.</div>`;
  } else {
    el.innerHTML = logs.map(l => {
      const datum = new Date(l.aangemaakt_op).toLocaleDateString('nl-NL', { day:'2-digit', month:'short', year:'numeric' });
      const tijd  = new Date(l.aangemaakt_op).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' });
      const actieLabel = { afgerond:'Afgerond', start:'Opgepakt', vrijgegeven:'Vrijgegeven', onderdelen_besteld:'Onderdelen besteld' }[l.actie] || l.actie;
      const notitieHTML = l.notitie
        ? `<div style="margin-top:3px;font-size:12px;color:var(--text)">${l.notitie}</div>` : '';
      const onderdelenHTML = l.gebruikte_onderdelen
        ? `<div style="margin-top:2px;font-size:11px;color:var(--muted)">Onderdelen: ${l.gebruikte_onderdelen}</div>` : '';
      const tijdHTML = l.bestede_tijd_minuten
        ? `<span style="margin-left:6px;font-size:11px;color:var(--muted)">· ${l.bestede_tijd_minuten} min</span>` : '';
      return `
        <div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:12px;font-weight:600;color:var(--primary)">${actieLabel}${tijdHTML}</span>
            <span style="font-size:11px;color:var(--muted)">${datum} ${tijd}</span>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:1px">${l.opdrachtnr || ''}${l.monteur_naam ? ' · ' + l.monteur_naam : ''}</div>
          ${notitieHTML}${onderdelenHTML}
        </div>`;
    }).join('');
  }

  el.style.display = '';
  knop.textContent = '▲ Memo';
}

// ── KLOKTIMER ────────────────────────────────────────────────
let _klokInterval = null;

function klokSleutel(id)        { return 'klok_start_'   + id; }
function klokElapsedSleutel(id) { return 'klok_elapsed_' + id; }

function getKlokStart(id) {
  const v = localStorage.getItem(klokSleutel(id));
  return v ? parseInt(v, 10) : null;
}
function getKlokElapsed(id) {
  const v = localStorage.getItem(klokElapsedSleutel(id));
  return v ? parseInt(v, 10) : 0;
}
// Totale tijd in ms: opgeslagen + huidige sessie indien actief
function getTotaalKlokMs(id) {
  const elapsed = getKlokElapsed(id);
  const start   = getKlokStart(id);
  return elapsed + (start ? Date.now() - start : 0);
}
function setKlokStart(id, ts) { localStorage.setItem(klokSleutel(id), ts); }
// Stop huidige sessie: tel verstreken tijd op bij elapsed, wis start
function pauseKlok(id) {
  const start = getKlokStart(id);
  if (!start) return;
  const elapsed = getKlokElapsed(id);
  localStorage.setItem(klokElapsedSleutel(id), elapsed + (Date.now() - start));
  localStorage.removeItem(klokSleutel(id));
}
// Wis alles (bij afronden)
function clearKlok(id) {
  localStorage.removeItem(klokSleutel(id));
  localStorage.removeItem(klokElapsedSleutel(id));
}

function formatKlokTijd(ms) {
  const tot = Math.floor(ms / 1000);
  const u   = Math.floor(tot / 3600);
  const m   = Math.floor((tot % 3600) / 60);
  const s   = tot % 60;
  return `${String(u).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function updateKlokUI() {
  const r = state.activeMod;
  if (!r) return;
  const start  = getKlokStart(r.id);
  const knop   = document.getElementById('md-klok-btn');
  const tijdEl = document.getElementById('md-klok-tijd');
  const infoEl = document.getElementById('md-klok-info');
  if (!knop) return;

  if (start) {
    const totaal  = getTotaalKlokMs(r.id);
    const startStr = new Date(start).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' });
    knop.textContent = '⏹ Stop opdracht';
    knop.style.background = 'var(--ok)';
    knop.style.color      = '#fff';
    knop.style.borderColor = 'var(--ok)';
    tijdEl.textContent    = formatKlokTijd(totaal);
    tijdEl.style.display  = '';
    infoEl.textContent    = 'Gestart om ' + startStr;
    infoEl.style.display  = '';
  } else {
    knop.textContent = '⏱ Start opdracht';
    knop.style.background  = 'none';
    knop.style.color       = 'var(--primary)';
    knop.style.borderColor = 'var(--primary)';
    tijdEl.style.display   = 'none';
    infoEl.style.display   = 'none';
  }
}

function startKlokTick() {
  if (_klokInterval) clearInterval(_klokInterval);
  _klokInterval = setInterval(updateKlokUI, 1000);
}

function stopKlokTick() {
  if (_klokInterval) { clearInterval(_klokInterval); _klokInterval = null; }
}

// ── TIMER VANUIT DE LIJST ─────────────────────────────────────
// Compacte play/stop knop voor in de groep-header (naast chevron)
function maakTimerKnopHeader(r) {
  if (!r) return '';
  const id = r.id;
  const actief = !!getKlokStart(id);
  return `<button class="klok-play-btn${actief ? ' actief' : ''}" id="klok-btn-${id}"
    onclick="event.stopPropagation();toggleKlokVanuitLijst('${id}')"
    title="${actief ? 'Timer stoppen' : 'Timer starten'}">
    ${actief ? '⏹' : '▶'}
  </button>
  <span class="klok-display" id="klok-display-${id}"${actief ? '' : ' style="display:none"'}>${actief ? formatKlokTijd(Date.now() - getKlokStart(id)) : ''}</span>`;
}

// Versie voor cardHTML (voorraad-kaarten)
function maakTimerBadge(r) {
  if (!r) return '';
  const id = r.id;
  const actief = !!getKlokStart(id);
  return `<div style="display:flex;align-items:center;gap:8px;margin-top:8px">
    <button class="klok-play-btn${actief ? ' actief' : ''}" id="klok-btn-${id}"
      onclick="event.stopPropagation();toggleKlokVanuitLijst('${id}')">
      ${actief ? '⏹&nbsp;Stop' : '▶&nbsp;Start'}
    </button>
    <span class="klok-display" id="klok-display-${id}"${actief ? '' : ' style="display:none"'}>${actief ? formatKlokTijd(Date.now() - getKlokStart(id)) : ''}</span>
  </div>`;
}

let _lijstKlokInterval = null;

function startLijstTimerUpdate() {
  if (_lijstKlokInterval) clearInterval(_lijstKlokInterval);
  _lijstKlokInterval = setInterval(() => {
    document.querySelectorAll('[id^="klok-display-"]').forEach(el => {
      const id = el.id.replace('klok-display-', '');
      const totaal = getTotaalKlokMs(id);
      if (totaal > 0) {
        el.style.display = '';
        el.textContent = formatKlokTijd(totaal);
      }
    });
    document.querySelectorAll('[id^="klok-btn-"]').forEach(btn => {
      const id = btn.id.replace('klok-btn-', '');
      const loopt = !!getKlokStart(id);
      if (loopt && !btn.classList.contains('actief')) {
        btn.classList.add('actief');
        btn.innerHTML = '⏹';
      } else if (!loopt && btn.classList.contains('actief')) {
        btn.classList.remove('actief');
        btn.innerHTML = '▶';
      }
    });
  }, 1000);
}

async function toggleKlokVanuitLijst(id) {
  const r = state.reparaties.find(x => x.id === id);
  if (!r) return;
  const start = getKlokStart(id);

  if (start) {
    const sessieDuur = Date.now() - start;
    pauseKlok(id); // opslaan in elapsed, start wissen
    const totaalMs  = getTotaalKlokMs(id);
    const totaalMin = Math.floor(totaalMs / 60000);
    const btn  = document.getElementById('klok-btn-' + id);
    const disp = document.getElementById('klok-display-' + id);
    if (btn)  { btn.classList.remove('actief'); btn.innerHTML = '▶'; }
    if (disp) { disp.textContent = formatKlokTijd(totaalMs); } // toon opgebouwde tijd
    if (!state.demoMode) {
      const sessiMin = Math.floor(sessieDuur / 60000);
      await insertLog({
        reparatie_id: id, monteur_id: state.monteur.id, monteur_naam: state.monteur.naam,
        actie: 'klok_gestopt', opdrachtnr: r.opdrachtnr, regelnummer: r.regelnummer, opdrachtcode: r.opdrachtcode || null, artikelcode: r.artikelcode,
        artikelomschrijving: r.artikelomschrijving, serienummer: r.serienummer, tagnummer: r.tagnummer,
        notitie: `Timer gepauzeerd — sessie ${sessiMin} min, totaal ${totaalMin} min`,
        bestede_tijd_minuten: totaalMin,
      }).catch(() => {});
    }
    toast(`Timer gepauzeerd — totaal ${totaalMin} min`);
  } else {
    const nu = Date.now();
    setKlokStart(id, nu);
    const totaal = getTotaalKlokMs(id);
    const btn  = document.getElementById('klok-btn-' + id);
    const disp = document.getElementById('klok-display-' + id);
    if (btn)  { btn.classList.add('actief'); btn.innerHTML = '⏹'; }
    if (disp) { disp.style.display = ''; disp.textContent = formatKlokTijd(totaal); }
    if (!state.demoMode) {
      const startStr = new Date(nu).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
      await insertLog({
        reparatie_id: id, monteur_id: state.monteur.id, monteur_naam: state.monteur.naam,
        actie: 'klok_gestart', opdrachtnr: r.opdrachtnr, regelnummer: r.regelnummer, opdrachtcode: r.opdrachtcode || null, artikelcode: r.artikelcode,
        artikelomschrijving: r.artikelomschrijving, serienummer: r.serienummer, tagnummer: r.tagnummer,
        notitie: `Timer gestart om ${startStr}`,
      }).catch(() => {});
    }
    toast('Timer gestart');
  }
}

async function toggleKlok() {
  const r = state.activeMod;
  if (!r) return;
  const start = getKlokStart(r.id);

  if (start) {
    // Pauzeer klok — elapsed ophogen, start wissen
    const sessieDuur = Date.now() - start;
    pauseKlok(r.id);
    stopKlokTick();
    updateKlokUI();
    if (!state.demoMode) {
      const sessiMin  = Math.floor(sessieDuur / 60000);
      const totaalMin = Math.floor(getTotaalKlokMs(r.id) / 60000);
      await insertLog({
        reparatie_id: r.id, monteur_id: r.monteur_id, monteur_naam: state.monteur.naam,
        actie: 'klok_gestopt', opdrachtnr: r.opdrachtnr, regelnummer: r.regelnummer, opdrachtcode: r.opdrachtcode || null, artikelcode: r.artikelcode,
        artikelomschrijving: r.artikelomschrijving, serienummer: r.serienummer, tagnummer: r.tagnummer,
        notitie: `Timer gepauzeerd — sessie ${sessiMin} min, totaal ${totaalMin} min`,
        bestede_tijd_minuten: totaalMin,
      }).catch(() => {});
    }
    toast('Timer gepauzeerd');
  } else {
    // Start klok
    const nu = Date.now();
    setKlokStart(r.id, nu);
    startKlokTick();
    updateKlokUI();
    // Log starten
    if (!state.demoMode) {
      const startStr = new Date(nu).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' });
      await insertLog({
        reparatie_id: r.id, monteur_id: r.monteur_id, monteur_naam: state.monteur.naam,
        actie: 'klok_gestart', opdrachtnr: r.opdrachtnr, regelnummer: r.regelnummer, opdrachtcode: r.opdrachtcode || null, artikelcode: r.artikelcode,
        artikelomschrijving: r.artikelomschrijving, serienummer: r.serienummer, tagnummer: r.tagnummer,
        notitie: `Klok gestart om ${startStr}`,
      }).catch(() => {});
    }
    toast('Klok gestart');
  }
}

// Roep aan vanuit openDetail om klok status te tonen
function laadKlokVoorReparatie() {
  const r = state.activeMod;
  if (!r) return;
  updateKlokUI();
  const start = getKlokStart(r.id);
  if (start) startKlokTick();
}

function toonKeuzeView() {
  document.getElementById('md-keuze').style.display      = '';
  document.getElementById('md-menu').style.display       = 'none';
  document.getElementById('md-onderdelen').style.display = 'none';
}

function toonActiesView() {
  document.getElementById('md-keuze').style.display      = 'none';
  document.getElementById('md-menu').style.display       = '';
  document.getElementById('md-onderdelen').style.display = 'none';
  const isVoorraad = state.activeMod?.soort === 'voorraad';
  const vrijgeefBtn = document.querySelector('#md-keuze button[onclick="vrijgevenReparatie()"]');
  if (vrijgeefBtn) vrijgeefBtn.style.display = isVoorraad ? 'none' : '';
  let verwijderVoorraadBtn = document.getElementById('md-verwijder-voorraad-btn');
  if (isVoorraad && !verwijderVoorraadBtn) {
    verwijderVoorraadBtn = document.createElement('button');
    verwijderVoorraadBtn.id = 'md-verwijder-voorraad-btn';
    verwijderVoorraadBtn.className = 'btn btn-ghost';
    verwijderVoorraadBtn.style.cssText = 'margin-top:8px;color:var(--danger);border-color:var(--danger)';
    verwijderVoorraadBtn.textContent = '🗑 Verwijderen';
    verwijderVoorraadBtn.onclick = () => verwijderVoorraadReparatie(state.activeMod?.id);
    document.getElementById('md-keuze').appendChild(verwijderVoorraadBtn);
  } else if (verwijderVoorraadBtn) {
    verwijderVoorraadBtn.style.display = isVoorraad ? '' : 'none';
  }
  const wachtOnderdelenBtn = document.getElementById('md-wacht-onderdelen-btn');
  if (wachtOnderdelenBtn) wachtOnderdelenBtn.style.display = isRepCode(state.activeMod) ? '' : 'none';
  laadOpmerkingen();
}

function toonMenuView() { toonKeuzeView(); } // backwards compat

// ── OPMERKINGEN (bij regels die in behandeling zijn) ────────────
async function laadOpmerkingen() {
  const r = state.activeMod;
  const lijst = document.getElementById('md-opmerkingen-lijst');
  if (!r || !lijst) return;
  lijst.innerHTML = '<div style="font-size:12px;color:var(--muted)">Laden…</div>';

  if (state.demoMode) {
    renderOpmerkingen(r._opmerkingen || []);
    return;
  }

  try {
    const { data, error } = await sb.from('reparatie_logs')
      .select('id, monteur_naam, notitie, aangemaakt_op')
      .eq('reparatie_id', r.id)
      .eq('actie', 'opmerking')
      .order('aangemaakt_op', { ascending: false });
    if (error) throw error;
    renderOpmerkingen(data || []);
  } catch (e) {
    lijst.innerHTML = '<div style="font-size:12px;color:var(--danger)">Kon opmerkingen niet laden.</div>';
  }
}

// Bouwt de markup voor een lijst opmerkingen — naam + datum staan altijd bovenaan elke opmerking.
function opmerkingLijstHTML(logs) {
  if (!logs.length) {
    return '<div style="font-size:12px;color:var(--muted)">Nog geen opmerkingen.</div>';
  }
  return logs.map(l => {
    const datum = new Date(l.aangemaakt_op).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit' });
    const tijd  = new Date(l.aangemaakt_op).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return `
      <div style="padding:7px 10px;background:rgba(245,166,35,.1);border-left:3px solid #f5a623;border-radius:0 var(--r) var(--r) 0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span style="font-size:12px;font-weight:700;color:#f5a623">${esc(l.monteur_naam || 'Onbekend')}</span>
          <span style="font-size:11px;color:var(--muted);white-space:nowrap">${datum} ${tijd}</span>
        </div>
        <div style="font-size:13px;color:var(--text);margin-top:2px;white-space:pre-wrap">${esc(l.notitie)}</div>
      </div>`;
  }).join('');
}

function renderOpmerkingen(logs) {
  const lijst = document.getElementById('md-opmerkingen-lijst');
  if (!lijst) return;
  lijst.innerHTML = opmerkingLijstHTML(logs);
}

// Toont de opmerkingen direct in de kaart zelf (naast klacht-icoon), zonder de
// detailmodal te hoeven openen. Wordt maar één keer per kaart-weergave opgehaald.
const _opmInlineCache = {};
async function laadOpmerkingenInline(groepId, regelId) {
  const lijst = document.getElementById('opm-lijst-' + groepId);
  if (!lijst || !regelId || regelId === 'undefined') return;

  if (_opmInlineCache[regelId]) {
    lijst.innerHTML = opmerkingLijstHTML(_opmInlineCache[regelId]);
    return;
  }
  lijst.innerHTML = '<div style="font-size:12px;color:var(--muted)">Laden…</div>';

  if (state.demoMode) {
    const r = state.reparaties.find(x => x.id === regelId);
    const logs = r?._opmerkingen || [];
    _opmInlineCache[regelId] = logs;
    lijst.innerHTML = opmerkingLijstHTML(logs);
    return;
  }

  try {
    const { data, error } = await sb.from('reparatie_logs')
      .select('id, monteur_naam, notitie, aangemaakt_op')
      .eq('reparatie_id', regelId)
      .eq('actie', 'opmerking')
      .order('aangemaakt_op', { ascending: false });
    if (error) throw error;
    _opmInlineCache[regelId] = data || [];
    lijst.innerHTML = opmerkingLijstHTML(data || []);
  } catch (e) {
    lijst.innerHTML = '<div style="font-size:12px;color:var(--danger)">Kon opmerkingen niet laden.</div>';
  }
}

async function voegOpmerkingToe() {
  const r    = state.activeMod;
  const veld = document.getElementById('md-opmerking-tekst');
  const tekst = veld?.value.trim();
  if (!r || !tekst) return;

  const nu = new Date().toISOString();
  const nieuw = {
    reparatie_id: r.id,
    opdrachtnr:   r.opdrachtnr,
    regelnummer:  r.regelnummer,
    opdrachtcode: r.opdrachtcode || null,
    monteur_id:   state.monteur.id,
    monteur_naam: state.monteur.naam,
    actie:        'opmerking',
    notitie:      tekst,
    aangemaakt_op: nu,
  };

  if (state.demoMode) {
    r._opmerkingen = [nieuw, ...(r._opmerkingen || [])];
    veld.value = '';
    renderOpmerkingen(r._opmerkingen);
    delete _opmInlineCache[r.id];
    return;
  }

  veld.disabled = true;
  try {
    await insertLog(nieuw);
    veld.value = '';
    delete _opmInlineCache[r.id]; // kaartweergave haalt verse data op bij volgende keer openklappen
    await laadOpmerkingen();
    toast('✓ Opmerking toegevoegd');
  } catch (e) {
    toast('Fout bij opslaan: ' + e.message);
  }
  veld.disabled = false;
}

function toonOnderdelenView() {
  document.getElementById('md-keuze').style.display      = 'none';
  document.getElementById('md-menu').style.display       = 'none';
  document.getElementById('md-onderdelen').style.display = '';
  document.getElementById('md-zoek').value = '';
  filterOnderdelenDetail();
}

function filterOnderdelenDetail() {
  const q = document.getElementById('md-zoek').value.toLowerCase();
  const lijst = document.getElementById('md-onderdeel-lijst');
  const gefilterd = q
    ? alleOnderdelen.filter(o => o.naam.toLowerCase().includes(q) || o.artikelnr.toLowerCase().includes(q))
    : alleOnderdelen;

  if (!gefilterd.length) {
    lijst.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px 0">Geen onderdelen gevonden</div>';
    return;
  }

  lijst.innerHTML = gefilterd.map(o => `
    <div class="onderdeel-item" onclick="selecteerOnderdeel('${o.id}')">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <div style="font-size:13px;font-weight:500">${o.naam}</div>
          <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px">${o.artikelnr}</div>
        </div>
        <div class="voorraad-badge ${o.voorraad > 0 ? 'voorraad-ok' : 'voorraad-leeg'}">
          ${o.voorraad > 0 ? o.voorraad + ' stuks' : 'Niet op voorraad'}
        </div>
      </div>
    </div>
  `).join('');
}

async function selecteerOnderdeel(id) {
  geselecteerdOnderdeel = alleOnderdelen.find(o => o.id === id);
  if (!geselecteerdOnderdeel) return;

  if (geselecteerdOnderdeel.voorraad > 0) {
    if (!state.demoMode) {
      try {
        await sb.from('onderdelen')
          .update({ voorraad: geselecteerdOnderdeel.voorraad - 1 })
          .eq('id', geselecteerdOnderdeel.id);
        geselecteerdOnderdeel.voorraad -= 1;
      } catch(e) {
        toast('Fout: ' + e.message);
        return;
      }
    }
    closeModal('modal-detail');
    toast('✓ ' + geselecteerdOnderdeel.naam + ' toegevoegd aan opdracht');
  } else {
    toast('⚠ Niet op voorraad');
  }
}

// ── ONDERDEEL REPARATIEHISTORIE ────────────────────────────────
async function toonOnderdeelGeschiedenis(id, naam, artikelnr) {
  document.getElementById('og-naam').textContent     = naam;
  document.getElementById('og-artikelnr').textContent = artikelnr;
  const lijst = document.getElementById('og-lijst');
  lijst.innerHTML = '<div class="geschiedenis-leeg">Laden...</div>';
  openModal('modal-geschiedenis');

  if (state.demoMode) {
    lijst.innerHTML = '<div class="geschiedenis-leeg">Geen historische data beschikbaar in demo-modus</div>';
    return;
  }

  lijst.innerHTML = '<div class="geschiedenis-leeg">Reparatiehistorie niet beschikbaar</div>';
}

// ── VOORRAAD REPARATIE ────────────────────────────────────────
let vrdPrio = 'normaal';

function openVoorraadModal() {
  // Reset formulier
  ['vrd-artikelcode','vrd-apparaat','vrd-merk','vrd-model']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('vrd-aantal').value = '1';
  document.getElementById('vrd-tagnr-jn').checked = false;
  document.getElementById('vrd-fout').textContent = '';
  document.getElementById('vrd-suggesties').innerHTML = '';
  openModal('modal-voorraad');

  // Laad bekende artikelcodes als suggesties
  laadArtikelSuggesties();
}

let alleArtikelcodes = [];

async function laadArtikelSuggesties() {
  try {
    const rep = await sb.from('reparaties').select('artikelcode').not('artikelcode','is',null);
    const codes = new Set((rep.data || []).map(r => r.artikelcode));
    alleArtikelcodes = [...codes].filter(Boolean).sort();
    zoekArtikelSuggesties('');
  } catch { /* stil falen */ }
}

function zoekArtikelSuggesties(zoekterm) {
  const el = document.getElementById('vrd-suggesties');
  const gevonden = zoekterm
    ? alleArtikelcodes.filter(c => c.includes(zoekterm.toUpperCase()))
    : alleArtikelcodes.slice(0, 10);

  el.innerHTML = gevonden.slice(0, 8).map(c => `
    <span onclick="kiesArtikelcode('${c}')"
      style="cursor:pointer;padding:4px 10px;background:var(--bg3);border:1px solid var(--border);
             border-radius:20px;font-size:12px;font-family:var(--mono);color:var(--accent)">
      ${c}
    </span>`).join('');
}

async function kiesArtikelcode(code) {
  document.getElementById('vrd-artikelcode').value = code;
  document.getElementById('vrd-suggesties').innerHTML = '';

  // Probeer apparaat-info automatisch in te vullen vanuit eerdere reparaties
  try {
    const { data } = await sb.from('reparaties')
      .select('artikelomschrijving, merk, model')
      .eq('artikelcode', code)
      .not('artikelomschrijving','is',null)
      .limit(1).single();
    if (data) {
      if (data.artikelomschrijving) document.getElementById('vrd-apparaat').value = data.artikelomschrijving;
      if (data.merk)          document.getElementById('vrd-merk').value = data.merk;
      if (data.model)         document.getElementById('vrd-model').value = data.model || '';
    }
  } catch { /* geen match */ }
}

function selectPrio(p) {
  vrdPrio = p;
  document.querySelectorAll('#vrd-prio-selector .prio-opt').forEach(el => {
    el.classList.toggle('actief', el.dataset.p === p);
  });
}

async function startVoorraadReparatie() {
  const code    = document.getElementById('vrd-artikelcode').value.trim().toUpperCase();
  const app     = document.getElementById('vrd-apparaat').value.trim();
  const merk    = document.getElementById('vrd-merk').value.trim();
  const model   = document.getElementById('vrd-model').value.trim();
  const aantal  = parseInt(document.getElementById('vrd-aantal').value, 10) || 1;
  const tagnrJn = document.getElementById('vrd-tagnr-jn').checked;
  const fout    = document.getElementById('vrd-fout');
  fout.textContent = '';

  if (!code) { fout.textContent = 'Vul een artikelcode in'; return; }
  if (!app)  { fout.textContent = 'Vul het apparaat type in'; return; }

  if (state.demoMode) { toast('Niet beschikbaar in demo-modus'); return; }

  const nr = 'V' + Date.now().toString().slice(-6);

  try {
    const { data: rep, error } = await sb.from('reparaties').insert({
      opdrachtnr:        nr,
      soort:             'voorraad',
      klant_naam:        'Voorraad',
      klant_nummer:      null,
      artikelcode:       code,
      artikelomschrijving:     app,
      merk:              merk || null,
      model:             model || null,
      aantal:            aantal,
      klacht:            'Wordt vastgelegd na reparatie',
      prioriteit:        vrdPrio,
      status:            '465',
      monteur_id:        state.monteur.id,
      in_behandeling_op: new Date().toISOString(),
      tagnrscannenjn:    tagnrJn ? 'J' : null,
    }).select().single();

    if (error) throw error;

    const logRij = await insertLog({
      reparatie_id:  rep.id,
      monteur_id:    state.monteur.id,
      monteur_naam:  state.monteur.naam,
      actie:         'start',
      opdrachtnr:    rep.opdrachtnr,
      artikelcode:   code,
      artikelomschrijving: app,
    });

    const doAfsluiten = async () => {
      if (tagnrJn) {
        const now = new Date().toISOString();
        await _insertTagnrScans(logRij?.id, rep.id, nr, '1', code, state.monteur.id, now);
      }
      closeModal('modal-voorraad');
      switchTab('behandeling');
      await laadReparaties();
      toast('✓ Voorraad reparatie gestart: ' + nr);
    };

    if (tagnrJn) {
      _tagnrQueue    = [{ id: rep.id, label: [code, app].filter(Boolean).join(' · '), aantal: Math.max(aantal, 1) }];
      _tagnrQueueIdx = 0;
      _tagnrGescand  = new Map();
      _tagnrOnDone   = doAfsluiten;
      _openTagnrScherm();
    } else {
      await doAfsluiten();
    }
  } catch(e) {
    fout.textContent = 'Fout: ' + e.message;
  }
}

// ── REGEL TOEVOEGEN AAN OPDRACHT ─────────────────────────────
let _regelModalOpdrachtnr = null;

function openRegelModal(opdrachtnr) {
  _regelModalOpdrachtnr = opdrachtnr;
  const hoofd = state.reparaties.find(r => r.opdrachtnr === opdrachtnr);
  document.getElementById('mr-sub').textContent   = `Opdracht ${opdrachtnr}${hoofd?.klant_naam ? ' · ' + hoofd.klant_naam : ''}`;
  document.getElementById('mr-artikelcode').value = '';
  if (!alleArtikelcodes.length) laadArtikelSuggesties();
  zoekRegelSuggesties('');
  document.getElementById('mr-apparaat').value   = '';
  document.getElementById('mr-merk').value       = '';
  document.getElementById('mr-model').value      = '';
  document.getElementById('mr-fout').textContent = '';
  openModal('modal-regel');
}

function zoekRegelSuggesties(zoekterm) {
  const el = document.getElementById('mr-suggesties');
  const jCodes = [...new Set(
    (state.reparaties || [])
      .filter(r => (r.doorsluizenjn || '').toUpperCase() === 'J' && r.artikelcode)
      .map(r => r.artikelcode)
  )].sort();
  const zoek = zoekterm.toUpperCase();
  const gevonden = zoek ? jCodes.filter(c => c.includes(zoek)) : jCodes.slice(0, 10);
  el.innerHTML = gevonden.slice(0, 8).map(c => `
    <span onclick="kiesRegelArtikelcode('${c}')"
      style="cursor:pointer;padding:4px 10px;background:var(--bg3);border:1px solid var(--border);
             border-radius:20px;font-size:12px;font-family:var(--mono);color:var(--accent)">
      ${c}
    </span>`).join('');
}

async function kiesRegelArtikelcode(code) {
  document.getElementById('mr-artikelcode').value = code;
  document.getElementById('mr-suggesties').innerHTML = '';
  await vulRegelVelden(code);
}

async function vulRegelVelden(code) {
  try {
    const { data } = await sb.from('reparaties')
      .select('artikelomschrijving, merk, model')
      .eq('artikelcode', code)
      .not('artikelomschrijving', 'is', null)
      .limit(1).single();
    if (data) {
      if (data.artikelomschrijving) document.getElementById('mr-apparaat').value = data.artikelomschrijving;
      if (data.merk)          document.getElementById('mr-merk').value     = data.merk;
      if (data.model)         document.getElementById('mr-model').value    = data.model || '';
    }
  } catch { /* geen match */ }
}

async function slaRegelOp() {
  const artikelcode = document.getElementById('mr-artikelcode').value.trim().toUpperCase() || null;
  const apparaat    = document.getElementById('mr-apparaat').value.trim() || null;
  const merk        = document.getElementById('mr-merk').value.trim() || null;
  const model       = document.getElementById('mr-model').value.trim() || null;
  const fout        = document.getElementById('mr-fout');
  fout.textContent  = '';

  if (!artikelcode) { fout.textContent = 'Vul een artikelcode in'; return; }
  if (!_regelModalOpdrachtnr) return;
  if (state.demoMode) { toast('Niet beschikbaar in demo-modus'); return; }

  const hoofd = state.reparaties.find(r => r.opdrachtnr === _regelModalOpdrachtnr);

  // Bepaal volgend regelnummer direct uit DB om race conditions bij snel toevoegen te voorkomen
  const { data: nrData } = await sb
    .from('reparaties')
    .select('regelnummer')
    .eq('opdrachtnr', _regelModalOpdrachtnr)
    .not('regelnummer', 'is', null);
  const bestaandeNrs = (nrData || []).map(r => r.regelnummer);
  const volgendNr = bestaandeNrs.length ? Math.max(...bestaandeNrs) + 11 : 1;

  try {
    const { data: nieuw, error } = await sb.from('reparaties').insert({
      opdrachtnr:    _regelModalOpdrachtnr,
      // Markeert deze regel als niet-ERP-afkomstig — zo blaast de opruimstap
      // in backend/sync.js 'm nooit weg omdat 'ie (logischerwijs) nooit in de
      // sync-data voorkomt. Zelfde principe als soort='voorraad'.
      soort:         'handmatig',
      opdrachtcode:  hoofd?.opdrachtcode  || null,
      abonneecode:   hoofd?.abonneecode   || null,
      klant_naam:    hoofd?.klant_naam    || null,
      klant_nummer:  hoofd?.klant_nummer  || null,
      betalercode:   hoofd?.betalercode   || null,
      werkplaats:    hoofd?.werkplaats    || null,
      productgroep:  hoofd?.productgroep  || null,
      organisatie:   hoofd?.organisatie   || null,
      landcode:      hoofd?.landcode      || null,
      artikelcode:   artikelcode,
      artikelomschrijving: apparaat,
      merk:          merk,
      model:         model,
      doorsluizenjn: 'J',
      regelnummer:   volgendNr,
      aantal:        1,
      status:        statusOpen({ opdrachtcode: hoofd?.opdrachtcode }),
      monteur_id:    null,
      klacht:        hoofd?.klacht || null,
      uiterste_datum_afdeling: hoofd?.uiterste_datum_afdeling || null,
      aangemaakt_op: new Date().toISOString(),
    }).select().single();

    if (error) throw error;

    await insertLog({
      reparatie_id:  nieuw.id,
      monteur_id:    state.monteur.id,
      monteur_naam:  state.monteur.naam,
      actie:         'regel_toegevoegd',
      opdrachtnr:    _regelModalOpdrachtnr,
      regelnummer:   nieuw.regelnummer,
      opdrachtcode:  hoofd?.opdrachtcode || null,
      notitie:       `Handmatig toegevoegde regel: ${artikelcode}`,
    });

    await laadReparaties();

    // Wis het formulier zodat de gebruiker direct een volgende regel kan invoeren
    document.getElementById('mr-artikelcode').value = '';
    document.getElementById('mr-apparaat').value    = '';
    document.getElementById('mr-merk').value        = '';
    document.getElementById('mr-model').value       = '';
    document.getElementById('mr-suggesties').innerHTML = '';
    document.getElementById('mr-fout').textContent  = '';
    const succesEl = document.getElementById('mr-succes');
    succesEl.textContent = `✓ Regel ${artikelcode} toegevoegd`;
    setTimeout(() => { succesEl.textContent = ''; }, 3000);
    document.getElementById('mr-artikelcode').focus();
  } catch(e) {
    fout.textContent = 'Fout: ' + e.message;
  }
}

// ── APPARAAT REPARATIEHISTORIE (op artikelcode) ───────────────
function toonHistorieVoorId(id) {
  const r = state.reparaties.find(x => x.id === id);
  if (!r) return;
  state.activeMod = r;
  toonApparaatGeschiedenis();
}

async function toonApparaatGeschiedenis() {
  const r = state.activeMod;
  if (!r?.artikelcode) return;

  document.getElementById('og-naam').textContent      = r.artikelomschrijving || r.artikelcode;
  document.getElementById('og-artikelnr').textContent = 'Artikelcode: ' + r.artikelcode + ' · reparatiehistorie';
  const lijst = document.getElementById('og-lijst');
  lijst.innerHTML = '<div class="geschiedenis-leeg">Laden...</div>';
  openModal('modal-geschiedenis');

  if (state.demoMode) {
    lijst.innerHTML = '<div class="geschiedenis-leeg">Geen historische data beschikbaar in demo-modus</div>';
    return;
  }

  try {
    // Haal artikelcode-logs en (indien tagnummer) tagnummer-logs parallel op
    const [artRes, tagRes] = await Promise.all([
      sb.from('reparatie_logs')
        .select('reparatie_id, opdrachtnr, artikelcode, artikelomschrijving, monteur_naam, actie, notitie, gebruikte_onderdelen, bestede_tijd_minuten, aangemaakt_op, tagnummer')
        .eq('artikelcode', r.artikelcode)
        .neq('actie', 'verwijderd_door_sync')
        .order('aangemaakt_op', { ascending: false })
        .limit(200),
      r.tagnummer
        ? sb.from('reparatie_logs')
            .select('reparatie_id, opdrachtnr, artikelcode, artikelomschrijving, monteur_naam, actie, notitie, gebruikte_onderdelen, bestede_tijd_minuten, aangemaakt_op, tagnummer')
            .eq('tagnummer', r.tagnummer)
            .neq('actie', 'verwijderd_door_sync')
            .order('aangemaakt_op', { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [] }),
    ]);

    if (artRes.error) throw artRes.error;

    const tagLogs = tagRes.data || [];
    let html = '';

    // ── Sectie: tagnummer memogeschiedenis (alleen als gevuld) ──
    if (r.tagnummer && tagLogs.length) {
      html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--primary);padding:10px 0 6px;border-bottom:2px solid var(--primary);margin-bottom:8px">
        Geschiedenis tagnummer ${r.tagnummer}
      </div>`;
      html += tagLogs.map(l => {
        const datum   = new Date(l.aangemaakt_op).toLocaleDateString('nl-NL', { day:'2-digit', month:'short', year:'numeric' });
        const tijd    = new Date(l.aangemaakt_op).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' });
        const naam_m  = l.monteur_naam || 'Onbekend';
        const init_m  = naam_m.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
        const actieLabel = { afgerond:'Afgerond', start:'Opgepakt', vrijgegeven:'Vrijgegeven', onderdelen_besteld:'Onderdelen besteld' }[l.actie] || l.actie;
        const tijdHTML   = l.bestede_tijd_minuten ? ` · ${l.bestede_tijd_minuten} min` : '';
        return `
          <div class="geschiedenis-item">
            <div class="geschiedenis-meta">
              <div class="geschiedenis-monteur">
                <span class="chip-dot" style="width:20px;height:20px;font-size:9px">${init_m}</span>
                ${naam_m}
              </div>
              <div class="geschiedenis-datum">${datum} ${tijd}</div>
            </div>
            <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-bottom:3px">${actieLabel}${tijdHTML} · Opdracht ${l.opdrachtnr || '—'}</div>
            ${l.notitie ? `<div class="geschiedenis-log">${l.notitie}</div>` : ''}
            ${l.gebruikte_onderdelen ? `<div class="geschiedenis-log" style="color:var(--muted)">Onderdelen: ${l.gebruikte_onderdelen}</div>` : ''}
          </div>`;
      }).join('');
    }

    // ── Sectie: artikelcode reparatiehistorie ──
    const artData = artRes.data || [];
    const sectieLabel = tagLogs.length
      ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:16px 0 6px;border-bottom:1px solid var(--border);margin-bottom:8px">Reparatiehistorie artikelcode ${r.artikelcode}</div>`
      : '';

    if (artData.length) {
      html += sectieLabel;
      const groepen = new Map();
      for (const log of artData) {
        const sleutel = log.opdrachtnr || log.reparatie_id || 'onbekend';
        if (!groepen.has(sleutel)) groepen.set(sleutel, []);
        groepen.get(sleutel).push(log);
      }

      html += Array.from(groepen.entries()).map(([opdrachtnr, logs]) => {
        const eerste   = logs[0];
        const naam_m   = eerste.monteur_naam || 'Onbekend';
        const init_m   = naam_m.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
        const datum    = new Date(eerste.aangemaakt_op).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
        const apparaat = eerste.artikelomschrijving || r.artikelomschrijving || '';
        const tagBadge = eerste.tagnummer
          ? `<span style="font-family:var(--mono);font-size:10px;background:rgba(0,69,130,.08);color:var(--primary);padding:1px 6px;border-radius:8px;margin-left:6px">${eerste.tagnummer}</span>`
          : '';

        const logRegels = logs
          .filter(l => l.notitie || l.gebruikte_onderdelen)
          .map(l => {
            const delen = [];
            if (l.notitie) delen.push(l.notitie);
            if (l.gebruikte_onderdelen) delen.push('Onderdelen: ' + l.gebruikte_onderdelen);
            if (l.bestede_tijd_minuten) delen.push(l.bestede_tijd_minuten + ' min');
            return `<div class="geschiedenis-log">${delen.join(' — ')}</div>`;
          }).join('');

        return `
          <div class="geschiedenis-item">
            <div class="geschiedenis-meta">
              <div class="geschiedenis-monteur">
                <span class="chip-dot" style="width:20px;height:20px;font-size:9px">${init_m}</span>
                ${naam_m}
              </div>
              <div class="geschiedenis-datum">${datum}</div>
            </div>
            ${apparaat ? `<div class="geschiedenis-apparaat">${apparaat}${tagBadge}</div>` : ''}
            <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-bottom:${logRegels ? '5px' : '0'}">
              Opdracht ${opdrachtnr}
            </div>
            ${logRegels || '<div style="font-size:12px;color:var(--muted);font-style:italic">Geen notities vastgelegd</div>'}
          </div>`;
      }).join('');
    } else if (!html) {
      html = '<div class="geschiedenis-leeg">Geen eerdere reparaties bekend voor dit apparaattype</div>';
    }

    lijst.innerHTML = html;

  } catch(e) {
    lijst.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:12px 0">Fout: ${e.message}</div>`;
  }
}


// ── HANDMATIG TOEGEVOEGDE REGELS ──────────────────────────────
let handmatigAangemaakteIds = new Set(); // reparatie-ids die via de app zijn aangemaakt

// ── VRAGENSETS ────────────────────────────────────────────────
let alleVragensets = [];
const vragenBeantwoord = new Set(); // reparatie-ids waarvoor vragen al zijn ingevuld

// ── Vragenlijst queue (meerdere artikelen achter elkaar) ──────
// Queue-item: { id: reparatieId, modus: 'artikel' | 'opdracht' }
let _vragenQueue      = [];
let _vragenQueueTotal = 0;
let _vragenQueueDone  = null;
let _huidigVragenModus = 'artikel'; // huidig scherm: artikel of opdracht

// Opgeslagen meenemen_in_afrond antwoorden:
// per reparatie_id → ['Vraag: Antwoord', ...]
// per opdrachtnr   → ['Vraag: Antwoord', ...]
let vragenNotities          = new Map();
let vragenNotitiesOpdracht  = new Map();

// ── TAGNR SCAN QUEUE ──────────────────────────────────────────
let _tagnrQueue    = [];
let _tagnrQueueIdx = 0;
let _tagnrGescand  = new Map(); // reparatieId → string[]
let _tagnrOnDone   = null;

// Tagnummer(s) verplicht als tagnrscannenjn='J' staat, óf (ongeacht die vlag)
// bij opdrachtcode HUUR/RUIL voor J-regels met een aantal groter dan 0.
function vereistTagnummer(r) {
  if (!r) return false;
  if ((r.tagnrscannenjn || '').toUpperCase() === 'J') return true;
  const code = (r.opdrachtcode || '').toUpperCase();
  return (code === 'HUUR' || code === 'RUIL')
    && (r.doorsluizenjn || '').toUpperCase() === 'J'
    && (parseInt(r.aantal) || 0) > 0;
}

function startTagnrScanQueue(ids, onDone) {
  const teInvoeren = ids.filter(id => {
    const r = state.reparaties.find(x => x.id === id);
    return vereistTagnummer(r);
  });
  if (!teInvoeren.length) { onDone(); return; }
  _tagnrQueue    = teInvoeren.map(id => {
    const r = state.reparaties.find(x => x.id === id);
    return { id, label: [r.artikelcode, r.artikelomschrijving].filter(Boolean).join(' · ') || id, aantal: Math.max(r.aantal || 1, 1) };
  });
  _tagnrQueueIdx = 0;
  _tagnrGescand  = new Map();
  _tagnrOnDone   = onDone;
  _openTagnrScherm();
}

function _openTagnrScherm() {
  if (_tagnrQueueIdx >= _tagnrQueue.length) {
    document.getElementById('scherm-tagnr').classList.remove('open');
    const cb = _tagnrOnDone; _tagnrOnDone = null; cb?.();
    return;
  }
  const item   = _tagnrQueue[_tagnrQueueIdx];
  const gescand = _tagnrGescand.get(item.id) || [];
  document.getElementById('tagnr-artikel-label').textContent  = item.label;
  document.getElementById('tagnr-voortgang').textContent       = `Artikel ${_tagnrQueueIdx + 1} van ${_tagnrQueue.length}`;
  document.getElementById('tagnr-apparaat-label').textContent  = `${gescand.length + 1} van ${item.aantal} in te voeren`;
  document.getElementById('tagnr-input').value = '';
  document.getElementById('tagnr-error').style.display = 'none';
  document.getElementById('tagnr-reeks-paneel').style.display = 'none';
  const vorigeBtn = document.getElementById('tagnr-vorige-btn');
  if (vorigeBtn) vorigeBtn.style.display = _tagnrQueueIdx > 0 ? '' : 'none';
  _renderTagnrLijst(item, gescand);
  document.getElementById('scherm-tagnr').classList.add('open');
  setTimeout(() => document.getElementById('tagnr-input')?.focus(), 80);
}

// Terug naar het vorige artikel in de scan-queue (bv. om een tagnummer nog aan
// te passen) — al ingevoerde tagnummers per artikel blijven staan in _tagnrGescand.
function vorigeTagnrRegel() {
  if (_tagnrQueueIdx <= 0) return;
  _tagnrQueueIdx--;
  _openTagnrScherm();
}

// Kruisje: annuleer de scan-queue. Artikelen die al volledig gescand zijn worden
// alsnog afgerond/opgeslagen (via de bestaande _tagnrOnDone-flow, desnoods beperkt
// tot die subset via bulkAfrondIds) — nog niet voltooide artikelen worden overgeslagen
// en moeten later apart afgerond worden.
function annuleerTagnrScherm() {
  const voltooideIds = _tagnrQueue
    .filter(it => (_tagnrGescand.get(it.id) || []).length >= it.aantal)
    .map(it => it.id);
  const totaal = _tagnrQueue.length;

  const vraag = voltooideIds.length
    ? `Je hebt ${voltooideIds.length} van de ${totaal} artikel${totaal !== 1 ? 'en' : ''} volledig gescand. Wil je die opslaan? Nog niet voltooide artikelen worden dan overgeslagen — die kun je later apart afronden.`
    : 'Er is nog geen enkel artikel volledig gescand. Weet je zeker dat je wilt annuleren? Er wordt dan niets opgeslagen.';
  if (!confirm(vraag)) return;

  document.getElementById('scherm-tagnr').classList.remove('open');
  const cb = _tagnrOnDone;
  _tagnrOnDone   = null;
  _tagnrQueue    = [];
  _tagnrQueueIdx = 0;
  _tagnrGescand  = new Map();

  if (!voltooideIds.length) return; // niets af te ronden, klaar

  bulkAfrondIds = voltooideIds; // beperkt eventuele bulk-afronden-flow tot de voltooide subset
  cb?.();
}

function _renderTagnrLijst(item, gescand) {
  document.getElementById('tagnr-tel').textContent = `${gescand.length} van ${item.aantal} ingevoerd`;
  const btn = document.getElementById('tagnr-volgende-btn');
  btn.disabled = false;
  btn.textContent = _tagnrQueueIdx < _tagnrQueue.length - 1 ? 'Volgende →' : 'Klaar ✓';
  document.getElementById('tagnr-lijst').innerHTML = gescand.map((t, i) => `
    <div class="tagnr-rij">
      <span class="tagnr-rij-nr">${i + 1}</span>
      <span class="tagnr-rij-waarde">${esc(t)}</span>
      <button class="tagnr-rij-del" onclick="verwijderTagnr(${i})" title="Verwijder">×</button>
    </div>`).join('');
}

function voegTagnrToe() {
  const input  = document.getElementById('tagnr-input');
  const waarde = (input?.value || '').trim();
  const errEl  = document.getElementById('tagnr-error');
  if (!waarde) { errEl.textContent = 'Voer een tagnummer in'; errEl.style.display = ''; return; }
  const item    = _tagnrQueue[_tagnrQueueIdx];
  const huidig  = _tagnrGescand.get(item.id) || [];
  if (huidig.length >= item.aantal) { errEl.textContent = `Maximum van ${item.aantal} tagnummer${item.aantal !== 1 ? 's' : ''} bereikt`; errEl.style.display = ''; return; }
  errEl.style.display = 'none';
  const gescand = [...huidig, waarde];
  _tagnrGescand.set(item.id, gescand);
  input.value = '';
  document.getElementById('tagnr-apparaat-label').textContent = gescand.length < item.aantal
    ? `${gescand.length + 1} van ${item.aantal} in te voeren`
    : `Alle ${item.aantal} ingevoerd`;
  _renderTagnrLijst(item, gescand);
  if (gescand.length >= item.aantal) {
    setTimeout(() => bevestigTagnrRegel(), 150);
  } else {
    setTimeout(() => document.getElementById('tagnr-input')?.focus(), 50);
  }
}

function verwijderTagnr(idx) {
  const item   = _tagnrQueue[_tagnrQueueIdx];
  const gescand = (_tagnrGescand.get(item.id) || []).filter((_, i) => i !== idx);
  _tagnrGescand.set(item.id, gescand);
  document.getElementById('tagnr-apparaat-label').textContent = `${gescand.length + 1} van ${item.aantal} in te voeren`;
  _renderTagnrLijst(item, gescand);
}

function toggleTagnrReeks() {
  const paneel = document.getElementById('tagnr-reeks-paneel');
  const open = paneel.style.display === 'none';
  paneel.style.display = open ? '' : 'none';
  if (open) setTimeout(() => document.getElementById('tagnr-reeks-van')?.focus(), 50);
}

function voegReeksToe() {
  const van = (document.getElementById('tagnr-reeks-van')?.value || '').trim();
  const tot = (document.getElementById('tagnr-reeks-tot')?.value || '').trim();
  const errEl = document.getElementById('tagnr-error');
  if (!van || !tot) { errEl.textContent = 'Voer een begin- en eindwaarde in'; errEl.style.display = ''; return; }
  const parseTag = v => { const m = v.match(/^(.*?)(\d+)$/); return m ? { prefix: m[1], num: parseInt(m[2], 10), padLen: m[2].length } : null; };
  const start = parseTag(van); const eind = parseTag(tot);
  if (!start || !eind) { errEl.textContent = 'Tagnummer moet een getal bevatten'; errEl.style.display = ''; return; }
  if (start.prefix !== eind.prefix) { errEl.textContent = 'Begin en eind moeten hetzelfde prefix hebben'; errEl.style.display = ''; return; }
  if (start.num > eind.num) { errEl.textContent = 'Beginwaarde moet kleiner of gelijk zijn aan de eindwaarde'; errEl.style.display = ''; return; }
  const item = _tagnrQueue[_tagnrQueueIdx];
  const huidig = _tagnrGescand.get(item.id) || [];
  const padLen = Math.max(start.padLen, eind.padLen);
  const nieuw = [];
  for (let i = start.num; i <= eind.num; i++) { nieuw.push(start.prefix + String(i).padStart(padLen, '0')); }
  if (huidig.length + nieuw.length > item.aantal) {
    errEl.textContent = `Reeks bevat ${nieuw.length} nummers, maar er zijn nog ${item.aantal - huidig.length} plekken vrij`;
    errEl.style.display = ''; return;
  }
  errEl.style.display = 'none';
  const gescand = [...huidig, ...nieuw];
  _tagnrGescand.set(item.id, gescand);
  document.getElementById('tagnr-reeks-van').value = '';
  document.getElementById('tagnr-reeks-tot').value = '';
  document.getElementById('tagnr-reeks-paneel').style.display = 'none';
  document.getElementById('tagnr-apparaat-label').textContent = gescand.length < item.aantal
    ? `${gescand.length + 1} van ${item.aantal} in te voeren` : `Alle ${item.aantal} ingevoerd`;
  _renderTagnrLijst(item, gescand);
  if (gescand.length >= item.aantal) { setTimeout(() => bevestigTagnrRegel(), 150); }
}

function renderAfrondTagnrLijst() {
  const el = document.getElementById('ma-tagnr-lijst');
  if (!el) return;
  const vol = _afrondAantal > 0 && _afrondTagnrs.length >= _afrondAantal;
  const teller = _afrondAantal > 0
    ? `<div style="font-size:11px;color:${vol ? 'var(--ok)' : 'var(--muted)'};margin-bottom:4px;font-family:var(--mono)">${_afrondTagnrs.length} van ${_afrondAantal} ingevoerd</div>`
    : '';
  el.innerHTML = teller + (_afrondTagnrs.length
    ? _afrondTagnrs.map((t, i) => `<div class="tagnr-rij"><span class="tagnr-rij-nr">${i + 1}</span><span class="tagnr-rij-waarde">${esc(t)}</span><button class="tagnr-rij-del" onclick="verwijderAfrondTagnr(${i})">×</button></div>`).join('')
    : `<div style="font-size:12px;color:var(--muted);margin-bottom:4px">Nog geen tagnummers ingevoerd</div>`);
  const inp = document.getElementById('ma-tagnr-input');
  if (inp) { inp.disabled = vol; inp.placeholder = vol ? `Maximum van ${_afrondAantal} bereikt` : 'Tagnummer toevoegen...'; }
}

function verwijderAfrondTagnr(idx) {
  _afrondTagnrs.splice(idx, 1);
  renderAfrondTagnrLijst();
}

function voegAfrondTagnrToe() {
  const inp = document.getElementById('ma-tagnr-input');
  const val = (inp?.value || '').trim();
  if (!val) return;
  if (_afrondAantal > 0 && _afrondTagnrs.length >= _afrondAantal) {
    toast(`Maximum van ${_afrondAantal} tagnummer${_afrondAantal !== 1 ? 's' : ''} bereikt`); return;
  }
  if (_afrondTagnrs.includes(val)) { toast('Tagnummer al aanwezig'); return; }
  _afrondTagnrs.push(val);
  inp.value = '';
  renderAfrondTagnrLijst();
  inp.focus();
}

function toggleAfrondTagnrReeks() {
  const paneel = document.getElementById('ma-tagnr-reeks-paneel');
  const open = paneel.style.display === 'none';
  paneel.style.display = open ? '' : 'none';
  if (open) setTimeout(() => document.getElementById('ma-tagnr-reeks-van')?.focus(), 50);
}

function voegAfrondReeksToe() {
  const van = (document.getElementById('ma-tagnr-reeks-van')?.value || '').trim();
  const tot = (document.getElementById('ma-tagnr-reeks-tot')?.value || '').trim();
  if (!van || !tot) { toast('Voer een begin- en eindwaarde in'); return; }
  const parseTag = v => { const m = v.match(/^(.*?)(\d+)$/); return m ? { prefix: m[1], num: parseInt(m[2], 10), padLen: m[2].length } : null; };
  const start = parseTag(van); const eind = parseTag(tot);
  if (!start || !eind) { toast('Tagnummer moet een getal bevatten'); return; }
  if (start.prefix !== eind.prefix) { toast('Begin en eind moeten hetzelfde prefix hebben'); return; }
  if (start.num > eind.num) { toast('Beginwaarde moet kleiner of gelijk zijn aan de eindwaarde'); return; }
  const padLen = Math.max(start.padLen, eind.padLen);
  const nieuw = [];
  for (let i = start.num; i <= eind.num; i++) {
    const nr = start.prefix + String(i).padStart(padLen, '0');
    if (!_afrondTagnrs.includes(nr)) nieuw.push(nr);
  }
  if (_afrondAantal > 0 && _afrondTagnrs.length + nieuw.length > _afrondAantal) {
    toast(`Reeks bevat ${nieuw.length} nummers, maar er zijn nog ${_afrondAantal - _afrondTagnrs.length} plekken vrij`); return;
  }
  _afrondTagnrs.push(...nieuw);
  document.getElementById('ma-tagnr-reeks-van').value = '';
  document.getElementById('ma-tagnr-reeks-tot').value = '';
  document.getElementById('ma-tagnr-reeks-paneel').style.display = 'none';
  renderAfrondTagnrLijst();
}

function bevestigTagnrRegel() {
  const item  = _tagnrQueue[_tagnrQueueIdx];
  if (!item) return;
  const input  = document.getElementById('tagnr-input');
  const waarde = (input?.value || '').trim();
  const aantal = Number(item.aantal) || 1;
  if (waarde) {
    const huidig = _tagnrGescand.get(item.id) || [];
    if (huidig.length < aantal) {
      const nieuw = [...huidig, waarde];
      _tagnrGescand.set(item.id, nieuw);
      if (input) input.value = '';
      document.getElementById('tagnr-error').style.display = 'none';
      _renderTagnrLijst(item, nieuw);
    }
  }
  const gescand = _tagnrGescand.get(item.id) || [];
  if (gescand.length < aantal) {
    const errEl = document.getElementById('tagnr-error');
    if (errEl) { errEl.textContent = 'Voer eerst een tagnummer in'; errEl.style.display = ''; }
    return;
  }
  _tagnrQueueIdx++;
  _openTagnrScherm();
}

function _insertTagnrScans(logId, reparatieId, opdrachtnr, regelnummer, artikelcode, monteurId, now) {
  const tagnrs = _tagnrGescand.get(reparatieId) || [];
  return Promise.all(tagnrs.map(tagnr =>
    sb.from('tagnr_scans').insert({ reparatie_log_id: logId, reparatie_id: reparatieId, opdrachtnr, regelnummer, artikelcode, tagnr, monteur_id: monteurId, aangemaakt_op: now })
  ));
}

function startVragenQueue(ids, onDone) {
  const entries = [];
  const opdrachtGedaan = new Set(); // per_opdracht vragen: eenmalig per opdrachtnr

  ids.forEach(id => {
    if (vragenBeantwoord.has(id)) return;
    const r = state.reparaties.find(x => x.id === id);
    if (!r) return;
    const sets = vindVragensettenVoor(r.artikelcode, r.betalercode, r.opdrachtcode, r.productgroep, r.organisatie);
    if (!sets.length) return;
    const alleVragen = sets.flatMap(s => s.vragen || []);

    // Per artikel vragen (per_artikel === true of undefined) → per reparatie_id
    if (alleVragen.some(v => v.per_artikel !== false)) {
      entries.push({ id, modus: 'artikel' });
    }
    // Per opdracht vragen (per_artikel === false) → éénmalig per opdrachtnr
    if (alleVragen.some(v => v.per_artikel === false) && !opdrachtGedaan.has(r.opdrachtnr)) {
      opdrachtGedaan.add(r.opdrachtnr);
      entries.push({ id, modus: 'opdracht' });
    }
  });

  _vragenQueue      = entries;
  _vragenQueueTotal = entries.length;
  _vragenQueueDone  = onDone;
  if (!entries.length) { onDone(); return; }
  _volgendInQueue();
}

function _volgendInQueue() {
  if (!_vragenQueue.length) {
    const cb = _vragenQueueDone;
    _vragenQueueDone = null;
    if (cb) cb();
    return;
  }
  const entry = _vragenQueue.shift();
  const positie = _vragenQueueTotal - _vragenQueue.length;
  _huidigVragenModus = entry.modus;
  openVragenscherm(entry.id, positie, _vragenQueueTotal, entry.modus);
}

async function laadVragensets() {
  if (state.demoMode) return;
  try {
    const { data } = await sb.from('vragensets')
      .select('*, vragen(*, antwoordopties(*))')
      .order('aangemaakt_op', { ascending: false });
    alleVragensets = data || [];
    if (state.monteur?.is_admin) renderAdminVragensets();
  } catch { alleVragensets = []; }
}

function vindVragensettenVoor(artikelcode, betalercode, opdrachtcode, productgroep, organisatie) {
  // Per ingevuld veld op de set moet de waarde overeenkomen met de opdracht.
  // Lege velden worden genegeerd (wildcard). Alle lege velden = algemeen (matcht altijd).
  return alleVragensets.filter(s => {
    if (!s.actief)                                           return false;
    if (s.artikelcode  && s.artikelcode  !== artikelcode)   return false;
    if (s.betalercode  && s.betalercode  !== betalercode)   return false;
    if (s.opdrachtcode && s.opdrachtcode !== opdrachtcode)  return false;
    if (s.productgroep && s.productgroep !== productgroep)  return false;
    if (s.organisatie  && s.organisatie  !== organisatie)   return false;
    return true;
  });
}

function vindVragensetVoor(artikelcode, betalercode, opdrachtcode, productgroep, organisatie) {
  return vindVragensettenVoor(artikelcode, betalercode, opdrachtcode, productgroep, organisatie)[0] || null;
}

// Verwijder emoji uit tekst (smiley's, symbolen) — behoudt gewone leestekens
function stripEmoji(s) {
  return (s || '')
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '') // emoji-blok (smileys, dieren, etc.)
    .replace(/[\u{2600}-\u{26FF}]/gu, '')   // misc symbolen (zon, sterren, etc.)
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Questionnaire player ──
function openVragenscherm(reparatieId, positie, totaal, modus = 'artikel') {
  const r = state.reparaties.find(x => x.id === reparatieId);
  if (!r) { _volgendInQueue(); return; }

  const sets = vindVragensettenVoor(r.artikelcode, r.betalercode, r.opdrachtcode, r.productgroep, r.organisatie);
  const alleVragen = sets.flatMap(s => s.vragen || []);

  // Filter vragen op modus: per_artikel=true (of undefined) → 'artikel', per_artikel=false → 'opdracht'
  const gefilterd = alleVragen.filter(v =>
    modus === 'artikel' ? (v.per_artikel !== false) : (v.per_artikel === false)
  );
  if (!gefilterd.length) {
    if (modus === 'artikel') vragenBeantwoord.add(reparatieId);
    _volgendInQueue();
    return;
  }

  state.activeMod = r;
  const artikelLabel = [r.artikelcode, r.artikelomschrijving].filter(Boolean).join(' · ');

  // Header: toon duidelijk of dit per artikel of per opdracht is
  if (modus === 'opdracht') {
    document.getElementById('vragen-header-sub').textContent = `Opdracht ${r.opdrachtnr}`;
    document.getElementById('vragen-context-badge').textContent = 'Vragen voor hele opdracht';
    document.getElementById('vragen-context-badge').style.display = '';
  } else {
    document.getElementById('vragen-header-sub').textContent =
      totaal > 1
        ? `Artikel ${positie}/${totaal}: ${artikelLabel || r.opdrachtnr}`
        : [r.opdrachtnr, r.artikelcode, r.betalercode].filter(Boolean).join(' · ');
    const badge = document.getElementById('vragen-context-badge');
    if (artikelLabel) {
      badge.textContent = `Voor artikel: ${artikelLabel}`;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  const vragen = gefilterd
    .filter(v => v.type === 'open' || (v.antwoordopties && v.antwoordopties.length > 0))
    .sort((a, b) => a.volgorde - b.volgorde);
  document.getElementById('vragen-voortgang').textContent = `${vragen.length} vragen`;

  const body = document.getElementById('vragen-body');
  body.innerHTML = vragen.map((v, i) => {
    const opties = [...v.antwoordopties].sort((a, b) => a.volgorde - b.volgorde);
    const optiesHTML = v.type === 'open'
      ? `<textarea class="open-antwoord" data-vraag="${v.id}" placeholder="Typ je antwoord..."></textarea>`
      : v.type === 'schaal'
      ? `<div class="schaal-row">
           ${opties.map(o => `
             <div class="schaal-btn" data-vraag="${v.id}" data-optie="${o.id}" onclick="selecteerOptie(this)">
               ${o.waarde}
             </div>`).join('')}
         </div>
         <div class="schaal-labels">
           <span>${stripEmoji(opties[0]?.optie_tekst || '')}</span>
           <span>${stripEmoji(opties[opties.length-1]?.optie_tekst || '')}</span>
         </div>`
      : v.type === 'select'
      ? `<select class="form-input select-antwoord" data-vraag="${v.id}" style="margin-top:6px">
           <option value="">— Kies een waarde —</option>
           ${opties.map(o => `<option value="${o.id}" data-tekst="${stripEmoji(o.optie_tekst)}">${stripEmoji(o.optie_tekst)}</option>`).join('')}
         </select>`
      : v.type === 'gegroepeerde_checkbox'
      ? opties.map(o => `
          <div class="optie-item" data-vraag="${v.id}" data-optie="${o.id}" data-type="gegroepeerde_checkbox" onclick="selecteerOptie(this)">
            ${stripEmoji(o.optie_tekst)}
          </div>`).join('')
      : opties.map(o => `
          <div class="optie-item" data-vraag="${v.id}" data-optie="${o.id}" onclick="selecteerOptie(this)">
            ${stripEmoji(o.optie_tekst)}
          </div>`).join('');

    return `<div class="vraag-card">
      <div class="vraag-nummer">Vraag ${i + 1}</div>
      <div class="vraag-tekst">${v.vraag_tekst}</div>
      ${optiesHTML}
    </div>`;
  }).join('');

  document.getElementById('vragen-verplicht').textContent = '';
  document.getElementById('scherm-vragen').classList.add('open');
}

function controleerUren(el) {
  const v    = parseInt(el.value) || 0;
  const hoog = v >= 10;
  el.classList.toggle('uren-hoog', hoog);
  const waarschuwingId = el.id === 'ma-uren' ? 'ma-uren-waarschuwing' : 'mab-uren-waarschuwing';
  const w = document.getElementById(waarschuwingId);
  if (w) w.style.display = hoog ? 'block' : 'none';
}

function selecteerOptie(el) {
  const vraagId = el.dataset.vraag;
  if (el.dataset.type === 'gegroepeerde_checkbox') {
    el.classList.toggle('selected');
  } else {
    document.querySelectorAll(`[data-vraag="${vraagId}"]`)
      .forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
  }
}

async function bevestigVragenlijst() {
  const r = state.activeMod;
  if (!r) return;

  // Bouw lookup: vraag_id → { vragenset_id, volgorde, tekst, meenemen, per_artikel }
  // optie_id → optie_tekst
  const vraagIndex = {}, optieIndex = {};
  for (const s of alleVragensets) {
    for (const v of (s.vragen || [])) {
      vraagIndex[v.id] = {
        vragenset_id: s.id, volgorde: v.volgorde,
        tekst: v.vraag_tekst, meenemen: v.meenemen_in_afrond ?? false,
        type: v.type,
      };
      for (const o of (v.antwoordopties || [])) {
        optieIndex[o.id] = o.optie_tekst;
      }
    }
  }

  // Verzamel antwoorden — gesloten vragen (geselecteerde optie)
  // _vid = interne vraag_id voor meenemen-check; wordt voor DB-insert verwijderd
  const geselecteerd = document.querySelectorAll('#vragen-body .selected');
  const antwoorden = Array.from(geselecteerd).map(el => {
    const meta = vraagIndex[el.dataset.vraag] || {};
    return {
      reparatie_id:    r.id,
      opdrachtnr:      r.opdrachtnr  || null,
      artikelcode:     r.artikelcode || null,
      betalercode:     r.betalercode || null,
      vragenlijst_id:  meta.vragenset_id || null,
      vraagnr:         meta.volgorde ?? null,
      antwoord:        stripEmoji(optieIndex[el.dataset.optie] || el.dataset.optie),
      _vid:            el.dataset.vraag,
    };
  });

  // Open vragen (textarea)
  const openVragen = document.querySelectorAll('#vragen-body .open-antwoord');
  for (const ta of openVragen) {
    const meta = vraagIndex[ta.dataset.vraag] || {};
    antwoorden.push({
      reparatie_id:    r.id,
      opdrachtnr:      r.opdrachtnr  || null,
      artikelcode:     r.artikelcode || null,
      betalercode:     r.betalercode || null,
      vragenlijst_id:  meta.vragenset_id || null,
      vraagnr:         meta.volgorde ?? null,
      antwoord:        ta.value.trim() || null,
      _vid:            ta.dataset.vraag,
    });
  }

  // Selectievelden (dropdown)
  const selectVelden = document.querySelectorAll('#vragen-body .select-antwoord');
  for (const sel of selectVelden) {
    const meta = vraagIndex[sel.dataset.vraag] || {};
    const gekozenOptie = sel.options[sel.selectedIndex];
    antwoorden.push({
      reparatie_id:    r.id,
      opdrachtnr:      r.opdrachtnr  || null,
      artikelcode:     r.artikelcode || null,
      betalercode:     r.betalercode || null,
      vragenlijst_id:  meta.vragenset_id || null,
      vraagnr:         meta.volgorde ?? null,
      antwoord:        sel.value ? stripEmoji(gekozenOptie?.dataset?.tekst || sel.value) : null,
      _vid:            sel.dataset.vraag,
    });
  }

  // Controleer of alle vragen beantwoord zijn
  const vragen      = document.querySelectorAll('#vragen-body .vraag-card');
  const beantwoordIds = new Set([
    ...Array.from(geselecteerd).map(el => el.dataset.vraag),
    ...Array.from(openVragen).filter(ta => ta.value.trim()).map(ta => ta.dataset.vraag),
    ...Array.from(selectVelden).filter(sel => sel.value).map(sel => sel.dataset.vraag),
  ]);
  if (beantwoordIds.size < vragen.length) {
    document.getElementById('vragen-verplicht').textContent =
      '⚠ Beantwoord alle vragen voor je verdergaat';
    return;
  }

  // Bouw meenemen_in_afrond notitie-items (voor lokale opslag, niet naar DB)
  const groepPerVraag = {};
  const meenemenItems = [];
  for (const a of antwoorden) {
    if (!a.antwoord || !a._vid || !vraagIndex[a._vid]?.meenemen) continue;
    const meta = vraagIndex[a._vid];
    if (meta.type === 'gegroepeerde_checkbox') {
      if (!groepPerVraag[a._vid]) groepPerVraag[a._vid] = [];
      groepPerVraag[a._vid].push(a.antwoord);
    } else {
      meenemenItems.push(`${meta.tekst}: ${a.antwoord}`);
    }
  }
  for (const [vid, opties] of Object.entries(groepPerVraag)) {
    meenemenItems.push(`[GROEP:${vraagIndex[vid].tekst}] ${opties.join(' | ')}`);
  }

  if (meenemenItems.length) {
    if (_huidigVragenModus === 'opdracht') {
      const bestaand = vragenNotitiesOpdracht.get(r.opdrachtnr) || [];
      vragenNotitiesOpdracht.set(r.opdrachtnr, [...bestaand, ...meenemenItems]);
    } else {
      const bestaand = vragenNotities.get(r.id) || [];
      vragenNotities.set(r.id, [...bestaand, ...meenemenItems]);
    }
  }

  // Opslaan in DB — verwijder interne _vid velden voor insert
  if (!state.demoMode && antwoorden.length) {
    try {
      const teInserten = antwoorden
        .filter(a => a.reparatie_id)
        .map(({ _vid, ...rest }) => rest);
      if (teInserten.length) {
        const { error } = await sb.from('reparatie_antwoorden').insert(teInserten);
        if (error) throw error;
      }
    } catch(e) {
      toast('Fout bij opslaan antwoorden: ' + e.message);
      return;
    }
  }

  if (_huidigVragenModus === 'artikel') vragenBeantwoord.add(r.id);
  document.getElementById('scherm-vragen').classList.remove('open');
  _volgendInQueue();
}

// ── Admin vragensets beheer ──
function renderAdminVragensets() {
  const el = document.getElementById('admin-vragensets-lijst');
  if (!el) return;
  if (!alleVragensets.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Geen vragensets</div>';
    return;
  }
  el.innerHTML = alleVragensets.map(s => `
    <div style="display:flex;justify-content:space-between;align-items:center;
      background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);
      padding:10px 12px;margin-bottom:7px;gap:10px">
      <div>
        <div style="font-size:13px;font-weight:500">${s.titel}</div>
        <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px">
          ${[s.artikelcode, s.betalercode, s.opdrachtcode, s.productgroep].filter(Boolean).join(' + ') || 'Alle opdrachten'} ·
          ${s.vragen?.length || 0} vragen
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px">
          ${(s.vragen || []).map(v => `
            <span style="font-size:10px;font-family:var(--mono);background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;color:var(--text)">
              ${v.vraag_tekst?.substring(0,28)}${v.vraag_tekst?.length > 28 ? '…' : ''}
              ${v.per_artikel === false
                ? '<span style="color:var(--info)"> · opdracht</span>'
                : '<span style="color:var(--muted)"> · per artikel</span>'}
              ${v.meenemen_in_afrond
                ? '<span style="color:var(--ok)"> · in afrond</span>'
                : ''}
            </span>`).join('')}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" ${s.actief ? 'checked' : ''}
            onchange="toggleVragenset('${s.id}', this.checked)"
            style="accent-color:var(--accent);width:16px;height:16px">
          <span style="font-size:12px;color:var(--muted)">Actief</span>
        </label>
        <button onclick="openBewerkVragenset('${s.id}')"
          style="background:none;border:1px solid var(--border);border-radius:5px;
          padding:4px 8px;cursor:pointer;font-size:13px;color:var(--muted)" title="Bewerken">✏️</button>
        <button onclick="verwijderVragenset('${s.id}', '${s.titel}')"
          style="background:none;border:1px solid var(--border);border-radius:5px;
          padding:4px 8px;cursor:pointer;font-size:13px;color:var(--danger)">🗑</button>
      </div>
    </div>`).join('');
}

async function toggleVragenset(id, actief) {
  try {
    await sb.from('vragensets').update({ actief }).eq('id', id);
    const s = alleVragensets.find(x => x.id === id);
    if (s) s.actief = actief;
  } catch(e) { toast('Fout: ' + e.message); }
}

async function verwijderVragenset(id, titel) {
  if (!confirm(`Vragenset "${titel}" definitief verwijderen?\nAlle bijbehorende vragen en antwoorden worden ook verwijderd.`)) return;
  try {
    // Verwijder eerst gekoppelde antwoorden (foreign key constraint)
    const { error: e1 } = await sb.from('reparatie_antwoorden').delete().eq('vragenlijst_id', id);
    if (e1) throw e1;
    // Verwijder antwoordopties en vragen
    const { data: vraagIds } = await sb.from('vragen').select('id').eq('vragenset_id', id);
    if (vraagIds?.length) {
      const ids = vraagIds.map(v => v.id);
      await sb.from('antwoordopties').delete().in('vraag_id', ids);
      await sb.from('vragen').delete().in('id', ids);
    }
    const { error } = await sb.from('vragensets').delete().eq('id', id);
    if (error) throw error;
    await laadVragensets();
    toast('Verwijderd: ' + titel);
  } catch(e) { toast('Fout: ' + e.message); }
}

// ── Nieuwe/bewerk vragenset ──
let nvsTijdelijkeVragen = [];
let _nvsBewerkenId = null;

function openNieuweVragenset() {
  _nvsBewerkenId = null;
  nvsTijdelijkeVragen = [];
  document.getElementById('nvs-titel').value        = '';
  document.getElementById('nvs-artikelcode').value  = '';
  document.getElementById('nvs-betalercode').value  = '';
  document.getElementById('nvs-opdrachtcode').value = '';
  document.getElementById('nvs-productgroep').value = '';
  document.getElementById('nvs-organisatie').value  = '';
  document.getElementById('nvs-header-title').textContent = 'Nieuwe vragenset';
  document.getElementById('nvs-header-sub').textContent   = 'Voeg vragen toe die bij afronden worden gesteld';
  renderNvsVragen();
  document.getElementById('scherm-nieuwe-vragenset').classList.add('open');
}

function openBewerkVragenset(id) {
  const s = alleVragensets.find(x => x.id === id);
  if (!s) return;
  _nvsBewerkenId = id;

  document.getElementById('nvs-titel').value        = s.titel        || '';
  document.getElementById('nvs-artikelcode').value  = s.artikelcode  || '';
  document.getElementById('nvs-betalercode').value  = s.betalercode  || '';
  document.getElementById('nvs-opdrachtcode').value = s.opdrachtcode || '';
  document.getElementById('nvs-productgroep').value = s.productgroep || '';
  document.getElementById('nvs-organisatie').value  = s.organisatie  || '';
  document.getElementById('nvs-header-title').textContent = 'Vragenset bewerken';
  document.getElementById('nvs-header-sub').textContent   = s.titel;

  nvsTijdelijkeVragen = (s.vragen || [])
    .sort((a, b) => (a.volgorde ?? 0) - (b.volgorde ?? 0))
    .map(v => ({
      tekst:              v.vraag_tekst || '',
      type:               v.type        || 'meerkeuze',
      meenemen_in_afrond: v.meenemen_in_afrond ?? false,
      per_artikel:        v.per_artikel ?? true,
      opties: (v.antwoordopties || [])
        .sort((a, b) => (a.volgorde ?? 0) - (b.volgorde ?? 0))
        .map(o => o.optie_tekst || ''),
    }));

  renderNvsVragen();
  document.getElementById('scherm-nieuwe-vragenset').classList.add('open');
}

function sluitNieuweVragenset() {
  document.getElementById('scherm-nieuwe-vragenset').classList.remove('open');
}

function voegNieuweVraagToe() {
  nvsTijdelijkeVragen.push({ tekst: '', type: 'meerkeuze', opties: ['', ''], meenemen_in_afrond: false, per_artikel: true });
  renderNvsVragen();
}

function renderNvsVragen() {
  const el = document.getElementById('nvs-vragen-lijst');
  if (!nvsTijdelijkeVragen.length) { el.innerHTML = ''; return; }
  el.innerHTML = nvsTijdelijkeVragen.map((v, vi) => `
    <div style="background:var(--bg3);border:1px solid var(--border);
      border-radius:var(--r);padding:12px;margin-bottom:10px">
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="text" class="form-input" style="flex:1"
          placeholder="Vraag ${vi+1}..." value="${v.tekst}"
          oninput="nvsTijdelijkeVragen[${vi}].tekst=this.value">
        <select class="form-input" style="width:120px;flex-shrink:0"
          onchange="nvsTijdelijkeVragen[${vi}].type=this.value; renderNvsVragen()">
          <option value="meerkeuze"             ${v.type==='meerkeuze'?'selected':''}>Meerkeuze</option>
          <option value="gegroepeerde_checkbox" ${v.type==='gegroepeerde_checkbox'?'selected':''}>Gegroepeerde checkbox</option>
          <option value="select"               ${v.type==='select'?'selected':''}>Selectieveld</option>
          <option value="schaal"               ${v.type==='schaal'?'selected':''}>Schaal 1–5</option>
          <option value="open"                 ${v.type==='open'?'selected':''}>Open vraag</option>
        </select>
        <button onclick="nvsTijdelijkeVragen.splice(${vi},1);renderNvsVragen()"
          style="background:none;border:1px solid var(--border);border-radius:5px;padding:4px 8px;cursor:pointer;color:var(--danger);flex-shrink:0">✕</button>
      </div>
      <div style="display:flex;gap:20px;margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--muted)">
          <input type="checkbox" ${v.meenemen_in_afrond ? 'checked' : ''}
            onchange="nvsTijdelijkeVragen[${vi}].meenemen_in_afrond=this.checked"
            style="accent-color:var(--accent);width:14px;height:14px">
          Meenemen in afrond tekst
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--muted)">
          <input type="checkbox" ${v.per_artikel !== false ? 'checked' : ''}
            onchange="nvsTijdelijkeVragen[${vi}].per_artikel=this.checked"
            style="accent-color:var(--accent);width:14px;height:14px">
          Per artikel <span style="font-size:10px;color:var(--muted)">(uit = per opdracht)</span>
        </label>
      </div>
      ${v.type === 'open' ? `
        <div style="font-size:11px;color:var(--muted);padding:4px 0">Monteur typt een vrij antwoord</div>
      ` : v.type === 'schaal' ? `
        ${v.opties.map((o, oi) => `
          <input type="text" class="form-input" style="margin-bottom:5px"
            placeholder="Optie ${oi+1}" value="${o}"
            oninput="nvsTijdelijkeVragen[${vi}].opties[${oi}]=this.value">
        `).join('')}
        <button class="btn btn-ghost btn-sm" style="margin-top:4px;font-size:12px"
          onclick="nvsVoegOptieToe(${vi})">+ Optie</button>
      ` : `
        ${v.type === 'select' ? `<div style="font-size:11px;color:var(--muted);margin-bottom:6px">Waarden in de keuzelijst:</div>` : ''}
        ${v.opties.map((o, oi) => `
          <input type="text" class="form-input" style="margin-bottom:5px"
            placeholder="${v.type === 'select' ? 'Waarde ' + (oi+1) : 'Optie ' + (oi+1)}" value="${o}"
            oninput="nvsTijdelijkeVragen[${vi}].opties[${oi}]=this.value">
        `).join('')}
        <button class="btn btn-ghost btn-sm" style="margin-top:4px;font-size:12px"
          onclick="nvsVoegOptieToe(${vi})">+ ${v.type === 'select' ? 'Waarde' : 'Optie'}</button>
      `}
    </div>`).join('');
}

function nvsVoegOptieToe(vi) {
  nvsTijdelijkeVragen[vi].opties.push('');
  renderNvsVragen();
}

async function slaVragensetOp() {
  const titel        = document.getElementById('nvs-titel').value.trim();
  const artikelcode  = document.getElementById('nvs-artikelcode').value.trim().toUpperCase() || null;
  const betalercode  = document.getElementById('nvs-betalercode').value.trim() || null;
  const opdrachtcode = document.getElementById('nvs-opdrachtcode').value.trim().toUpperCase() || null;
  const productgroep = document.getElementById('nvs-productgroep').value.trim() || null;
  const organisatie  = document.getElementById('nvs-organisatie').value.trim() || null;

  if (!titel) { toast('⚠ Vul een titel in'); return; }
  if (!nvsTijdelijkeVragen.length) { toast('⚠ Voeg minimaal één vraag toe'); return; }
  for (let i = 0; i < nvsTijdelijkeVragen.length; i++) {
    const v = nvsTijdelijkeVragen[i];
    if (!v.tekst.trim()) { toast(`⚠ Vraag ${i + 1} heeft geen vraagtekst`); return; }
    if (v.type !== 'open' && v.opties.filter(o => o.trim()).length < 2) {
      const typeLabel = v.type === 'select' ? 'waarden' : 'antwoordopties';
      toast(`⚠ Vraag ${i + 1}: voeg minimaal 2 ${typeLabel} toe`); return;
    }
  }

  try {
    let setId;

    if (_nvsBewerkenId) {
      // Update bestaande set
      const { error: e1 } = await sb.from('vragensets')
        .update({ titel, artikelcode, betalercode, opdrachtcode, productgroep, organisatie })
        .eq('id', _nvsBewerkenId);
      if (e1) throw e1;
      setId = _nvsBewerkenId;
      // Verwijder alle bestaande vragen + antwoordopties (cascade via FK of handmatig)
      const bestaandeVraagIds = (alleVragensets.find(x => x.id === setId)?.vragen || []).map(v => v.id);
      if (bestaandeVraagIds.length) {
        await sb.from('antwoordopties').delete().in('vraag_id', bestaandeVraagIds);
        await sb.from('vragen').delete().in('id', bestaandeVraagIds);
      }
    } else {
      // Nieuwe set aanmaken
      const { data: set, error: e1 } = await sb.from('vragensets').insert({
        titel, artikelcode, betalercode, opdrachtcode, productgroep, organisatie, actief: true,
      }).select().single();
      if (e1) throw e1;
      setId = set.id;
    }

    for (let i = 0; i < nvsTijdelijkeVragen.length; i++) {
      const v = nvsTijdelijkeVragen[i];
      if (!v.tekst.trim()) continue;
      const { data: vraag, error: e2 } = await sb.from('vragen').insert({
        vragenset_id: setId, vraag_tekst: v.tekst.trim(),
        type: v.type, volgorde: i,
        meenemen_in_afrond: v.meenemen_in_afrond ?? false,
        per_artikel:        v.per_artikel ?? true,
      }).select().single();
      if (e2) throw e2;

      const geldige = v.opties.filter(o => o.trim());
      for (let j = 0; j < geldige.length; j++) {
        await sb.from('antwoordopties').insert({
          vraag_id: vraag.id, optie_tekst: geldige[j].trim(),
          waarde: j + 1, volgorde: j,
        });
      }
    }

    sluitNieuweVragenset();
    await laadVragensets();
    toast(_nvsBewerkenId ? '✓ Vragenset bijgewerkt' : '✓ Vragenset opgeslagen');
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

// ── CHAT MICROFOON (spraak → Rens) ───────────────────────────
let chatMicActief = false;
let chatMicRec    = null;

function toggleChatMic() {
  if (chatMicActief) stopChatMic();
  else startChatMic();
}

function startChatMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Spraakherkenning niet beschikbaar in deze browser'); return; }

  chatMicActief = true;
  document.getElementById('chat-mic-knop').classList.add('luistert');

  function maakSessie() {
    if (!chatMicActief) return;
    const rec = new SR();
    chatMicRec = rec;
    rec.lang          = 'nl-NL';
    rec.continuous    = false;
    rec.interimResults = true;

    const input = document.getElementById('chat-input');
    let basis = input.value.trimEnd();
    let interimChat = '';

    rec.onresult = (e) => {
      let interim = '', definitief = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) definitief += t;
        else interim += t;
      }
      if (definitief) {
        const sp = basis.length > 0 ? ' ' : '';
        basis = basis + sp + definitief.trim();
        input.value = basis;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        input.placeholder = 'Stel een vraag...';
        interimChat = '';
        // Stuur direct als volledige zin
        if (/[.?!]$/.test(definitief.trim())) {
          stopChatMic();
          stuurBericht();
        }
      } else if (interim) {
        input.placeholder = interim;
        interimChat = interim;
      }
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      stopChatMic();
    };

    rec.onend = () => {
      if (!chatMicActief) return;
      if (isIOS) {
        // Sla eventueel onafgeronde interim-tekst op voordat we stoppen
        if (interimChat.trim()) {
          const sp = basis.length > 0 ? ' ' : '';
          basis = basis + sp + interimChat.trim();
          input.value = basis;
          input.placeholder = 'Stel een vraag...';
          interimChat = '';
        }
        stopChatMic();
        toast('Tik opnieuw op de microfoon om verder in te spreken');
      } else {
        setTimeout(maakSessie, 80);
      }
    };

    try { rec.start(); } catch(e) {}
  }

  maakSessie();
}

function stopChatMic() {
  chatMicActief = false;
  if (chatMicRec) {
    chatMicRec.onend = null;
    try { chatMicRec.stop(); } catch(e) {}
    chatMicRec = null;
  }
  const knop  = document.getElementById('chat-mic-knop');
  const input = document.getElementById('chat-input');
  if (knop) knop.classList.remove('luistert');
  if (input) input.placeholder = 'Stel een vraag...';
}

async function laadOorzaakcodes() {
  const sel = document.getElementById('waf-oorzaakcode');
  if (!sel) return;
  try {
    const { data, error } = await sb.from('pmoorzaak')
      .select('id, code, omschrijving')
      .order('omschrijving', { ascending: true });
    if (error) throw error;
    if (!data?.length) { sel.innerHTML = '<option value="">— geen opties gevonden —</option>'; return; }
    sel.innerHTML = '<option value="">— kies oorzaak —</option>' +
      data.map(o => `<option value="${esc(o.code)}">${esc(o.omschrijving)}</option>`).join('');
  } catch(e) {
    sel.innerHTML = `<option value="">— fout: ${e.message} —</option>`;
  }
}

// ── CONFIG ────────────────────────────────────────────────────

function loadDemoData() {
  state.demoMode = true;
  document.getElementById('cfg-status').textContent = 'Demo modus actief';
  document.getElementById('cfg-status').style.color = 'var(--muted)';
  loadMonteurLogin();
}

// ── TABS ──────────────────────────────────────────────────────
function heeftOnderdelenToegang() {
  return !!(state.monteur?.is_onderdelenbeheerder);
}

function heeftWitgoedToegang() {
  return !!(state.monteur?.witgoed_toegang);
}

function heeftNovToegang() {
  return !!(state.monteur?.witgoed_voorraadbeheer);
}

// ── WERKVOORBEREIDER MODULE ───────────────────────────────────

// geselecteerde opdrachtregel: { reparatieId, opdrachtnr, artikelcode, label }
let _prepGeselecteerdeRegel = null;

function prepLaad() {
  _prepGeselecteerdeRegel = null;
  prepRenderOrders();
  prepRenderVoorraad();
  prepLaadApparaten();
}

let _prepSort = null; // 'afstand' | 'datum' | null

function prepSetSort(modus) {
  _prepSort = _prepSort === modus ? null : modus;
  document.getElementById('prep-sort-afstand-btn')?.classList.toggle('actief', _prepSort === 'afstand');
  document.getElementById('prep-sort-datum-btn')?.classList.toggle('actief', _prepSort === 'datum');
  prepRenderOrders();
}

function maakPrepMultiSelect(wrapId, opties) {
  const huidig = leesMultiSelect(wrapId);
  const panel  = getMsPanel(wrapId);
  if (!panel) return;
  panel.innerHTML = opties.length
    ? opties.map(o => `<label class="ms-item"><input type="checkbox" value="${esc(o)}" ${huidig.has(o) ? 'checked' : ''} onchange="prepRenderOrders()"> ${esc(o)}</label>`).join('')
    : '<div style="padding:8px 12px;color:var(--muted);font-size:12px">Geen opties</div>';
  updateMsBtn(wrapId);
}

function maakPrepFilters() {
  const PREP_CODES = ['RUIL', 'HUUR'];
  const rijen = (state.reparaties || []).filter(r =>
    (r.werkplaats || '').toLowerCase() === 'witgoed' &&
    r.status !== '519' &&
    PREP_CODES.includes((r.opdrachtcode || '').toUpperCase())
  );
  const uniek = veld => [...new Set(rijen.map(r => r[veld]).filter(Boolean))].sort();
  maakPrepMultiSelect('ms-prep-productgroep', uniek('productgroep'));
  maakPrepMultiSelect('ms-prep-artikelcode',  uniek('artikelcode'));
  maakPrepMultiSelect('ms-prep-organisatie',  uniek('organisatie'));
}

function resetPrepFilters() {
  ['ms-prep-productgroep','ms-prep-artikelcode','ms-prep-organisatie'].forEach(id => {
    const panel = getMsPanel(id);
    if (panel) panel.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = false);
    updateMsBtn(id);
  });
  const d = document.getElementById('prep-filter-datum');
  if (d) d.value = '';
  _prepSort = null;
  document.getElementById('prep-sort-afstand-btn')?.classList.remove('actief');
  document.getElementById('prep-sort-datum-btn')?.classList.remove('actief');
  prepRenderOrders();
}

async function prepLaadApparaten() {
  try {
    const { data, error } = await sb.from('witgoed_apparaten')
      .select('*')
      .in('status', ['actief', 'afgerond'])
      .order('aangemaakt_op', { ascending: false });
    if (error) throw error;
    state.prepApparaten = data || [];
    prepRenderVoorraad();
  } catch(e) {
    state.prepApparaten = [];
  }
}

function prepNenKleur(nen) {
  const n = parseInt(nen);
  if (n === 1) return { bg: 'rgba(26,143,79,.12)',  border: 'var(--ok)',     text: 'var(--ok)'     };
  if (n === 2) return { bg: 'rgba(236,101,0,.10)',  border: 'var(--accent)', text: 'var(--accent)' };
  if (n === 3) return { bg: 'rgba(217,48,37,.10)',  border: 'var(--danger)', text: 'var(--danger)' };
  return               { bg: 'var(--bg3)',           border: 'var(--border)', text: 'var(--muted)'  };
}

// ── Rechts: orders ────────────────────────────────────────────
function prepRenderOrders() {
  const el  = document.getElementById('prep-orders-lijst');
  const tel = document.getElementById('prep-orders-tel');

  const PREP_CODES = ['RUIL', 'HUUR'];

  // Actieve filterwaarden
  const fProductgroep = leesMultiSelect('ms-prep-productgroep');
  const fArtikelcode  = leesMultiSelect('ms-prep-artikelcode');
  const fOrganisatie  = leesMultiSelect('ms-prep-organisatie');
  const fDatum        = document.getElementById('prep-filter-datum')?.value || '';

  // Groepeer per opdrachtnr
  const alleGroepen = {};
  (state.reparaties || [])
    .filter(r =>
      (r.werkplaats || '').toLowerCase() === 'witgoed' &&
      r.status !== '519' &&
      PREP_CODES.includes((r.opdrachtcode || '').toUpperCase())
    )
    .forEach(r => {
      const key = r.opdrachtnr || r.id;
      if (!alleGroepen[key]) alleGroepen[key] = [];
      alleGroepen[key].push(r);
    });

  // Filter op groepniveau (hoofd = eerste rij)
  let opdrachtLijst = Object.values(alleGroepen).filter(regels => {
    const hoofd = regels[0];
    if (fProductgroep.size && !regels.some(r => fProductgroep.has(r.productgroep))) return false;
    if (fArtikelcode.size  && !regels.some(r => fArtikelcode.has(r.artikelcode)))   return false;
    if (fOrganisatie.size  && !fOrganisatie.has(hoofd.organisatie))                 return false;
    if (fDatum) {
      const d = hoofd.uiterste_datum_afdeling;
      if (!d || d.slice(0, 10) > fDatum) return false;
    }
    return true;
  });

  // Sorteren — gebruik eerste niet-null waarde in de groep
  const groepAfstand = g => {
    const km = g.find(r => typeof r.afstand_km === 'number' && isFinite(r.afstand_km))?.afstand_km;
    return km ?? Infinity;
  };
  const groepDatum   = g => g.find(r => r.uiterste_datum_afdeling)?.uiterste_datum_afdeling || '9999';

  if (_prepSort === 'afstand') {
    opdrachtLijst.sort((a, b) => groepAfstand(a) - groepAfstand(b));

  } else if (_prepSort === 'datum') {
    opdrachtLijst.sort((a, b) => {
      const da = groepDatum(a);
      const db = groepDatum(b);
      return da < db ? -1 : da > db ? 1 : 0;
    });
  }

  tel.textContent = opdrachtLijst.length;

  if (!opdrachtLijst.length) {
    el.innerHTML = '<div class="prep-leeg">Geen witgoed opdrachten</div>';
    return;
  }

  el.innerHTML = opdrachtLijst.map(regels => prepOrderKaartHTML(regels)).join('');
}

function prepOrderKaartHTML(regels) {
  regels.sort((a, b) => (a.regelnummer ?? 0) - (b.regelnummer ?? 0));
  const hoofd = regels[0];
  // Combineer witgoed + prep (bevat afgeronde items) — dedup op id
  const alleMap = new Map();
  [...(state.witgoedApparaten || []), ...(state.prepApparaten || [])].forEach(a => alleMap.set(a.id, a));
  const alle = [...alleMap.values()];

  const werkRegels = regels.filter(r => !isInstructieRegel?.(r) && (r.doorsluizenjn || '').toUpperCase() === 'J');

  const regelRijenHTML = werkRegels.map(r => {
    const totaal    = parseInt(r.aantal) || 1;
    const wgActief  = alle.filter(a => a.reparatie_id === r.id && a.status === 'actief'   && a.prep_gekoppeld === true);
    const wgAf      = alle.filter(a => a.reparatie_id === r.id && a.status === 'afgerond' && a.prep_gekoppeld === true);
    const gekoppeld = wgActief.length + wgAf.length;
    const resterend = Math.max(0, totaal - gekoppeld);
    const isOpen    = resterend > 0;

    const label   = [r.artikelcode, r.artikelomschrijving].filter(Boolean).map(esc).join(' · ') || esc(r.handeling) || '—';
    const safeId  = r.id.replace(/'/g, "\\'");
    const safeNr  = (r.opdrachtnr || '').replace(/'/g, "\\'");
    const safeArt = (r.artikelcode || '').replace(/'/g, "\\'");
    const safeLbl = label.replace(/'/g, "\\'");
    const toggleId = `prep-tagnr-${r.id.replace(/[^a-z0-9]/gi,'_')}`;

    const alleWg = [...wgActief, ...wgAf];
    const tgnrRijen = alleWg.map(a => {
      const isAfR = a.status === 'afgerond';
      const nenO  = a.nen_optisch  ? prepNenKleur(a.nen_optisch)  : null;
      const nenT  = a.nen_technisch ? prepNenKleur(a.nen_technisch) : null;
      const nenOBadge = nenO ? `<span style="font-size:10px;font-weight:700;font-family:var(--mono);padding:1px 5px;border-radius:3px;border:1px solid ${nenO.border};background:${nenO.bg};color:${nenO.text}">👁 ${esc(a.nen_optisch)}</span>` : '';
      const nenTBadge = nenT ? `<span style="font-size:10px;font-weight:700;font-family:var(--mono);padding:1px 5px;border-radius:3px;border:1px solid ${nenT.border};background:${nenT.bg};color:${nenT.text}">🔧 ${esc(a.nen_technisch)}</span>` : '';
      const draaiBadgeR = a.draaiuren != null ? `<span style="font-size:10px;font-family:var(--mono);padding:1px 5px;border-radius:3px;background:var(--bg3);border:1px solid var(--border);color:var(--muted)">⏱ ${a.draaiuren}u</span>` : '';
      return `<div class="prep-tagnr-rij${isAfR ? ' afgerond' : ''}" draggable="true"
               ondragstart="prepTagnrDragStart(event,'${a.id}','${esc(a.tagnr)}')">
        <span class="prep-tagnr-nr">${esc(a.tagnr)}</span>
        <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
          ${nenOBadge}
          ${nenTBadge}
          ${draaiBadgeR}
        </div>
      </div>`;
    }).join('');

    const safePg   = (r.productgroep || '').replace(/'/g, "\\'");
    const dropZone = isOpen ? `<div class="prep-drop-zone" id="drop-${safeId}"
        ondragover="event.preventDefault();this.classList.add('drag-over')"
        ondragleave="this.classList.remove('drag-over')"
        ondrop="prepDrop(event,'${safeId}','${safeNr}','${safeArt}','${safeLbl}','${safePg}')"
        onclick="prepSelecteerRegel('${safeId}','${safeNr}','${safeArt}','${safePg}','${safeLbl}')">
        ↓ Sleep apparaat hiernaartoe${r.productgroep ? ` · <strong>${esc(r.productgroep)}</strong>` : ''} (${resterend} resterend)
      </div>` : '';

    const isGes = _prepGeselecteerdeRegel?.reparatieId === r.id;
    const safePgAttr = (r.productgroep || '').replace(/'/g, "\\'");

    const ZICHTBAAR = 5;
    const zichtbareRijen = alleWg.slice(0, ZICHTBAAR);
    const verborgenRijen = alleWg.slice(ZICHTBAAR);
    const zichtbaarHTML  = zichtbareRijen.map((_, i) => tgnrRijen.split('</div>').filter(Boolean).map(s => s + '</div>')[i] || '').join('');

    // Bouw rijen opnieuw per deel (splits de al-gebouwde tgnrRijen niet — gebruik alleWg direct)
    const maakRij = a => {
      const isAfR = a.status === 'afgerond';
      const nenO  = a.nen_optisch   ? prepNenKleur(a.nen_optisch)   : null;
      const nenT  = a.nen_technisch ? prepNenKleur(a.nen_technisch) : null;
      const nenOB = nenO ? `<span style="font-size:10px;font-weight:700;font-family:var(--mono);padding:1px 5px;border-radius:3px;border:1px solid ${nenO.border};background:${nenO.bg};color:${nenO.text}">👁 ${esc(a.nen_optisch)}</span>` : '';
      const nenTB = nenT ? `<span style="font-size:10px;font-weight:700;font-family:var(--mono);padding:1px 5px;border-radius:3px;border:1px solid ${nenT.border};background:${nenT.bg};color:${nenT.text}">🔧 ${esc(a.nen_technisch)}</span>` : '';
      const drB   = a.draaiuren != null ? `<span style="font-size:10px;font-family:var(--mono);padding:1px 5px;border-radius:3px;background:var(--bg3);border:1px solid var(--border);color:var(--muted)">⏱ ${a.draaiuren}u</span>` : '';
      const safeAId = a.id.replace(/'/g, "\\'");
      const safeTnr = esc(a.tagnr).replace(/'/g, "\\'");
      return `<div class="prep-tagnr-rij${isAfR ? ' afgerond' : ''}" draggable="true"
               ondragstart="prepTagnrDragStart(event,'${safeAId}','${esc(a.tagnr)}')">
        <span class="prep-tagnr-nr">${esc(a.tagnr)}</span>
        <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
          ${nenOB}${nenTB}${drB}
          <button class="prep-ontkoppel-btn" title="Ontkoppelen"
            onclick="event.stopPropagation();prepOntkoppel('${safeAId}','${safeTnr}')">×</button>
        </div>
      </div>`;
    };

    const eersteRijen  = zichtbareRijen.map(maakRij).join('');
    const extraRijen   = verborgenRijen.map(maakRij).join('');
    const extraToggle  = verborgenRijen.length > 0
      ? `<button onclick="event.stopPropagation();prepToggleTagnrs('${toggleId}')"
           style="background:none;border:none;font-size:10px;font-family:var(--mono);color:var(--muted);cursor:pointer;padding:2px 6px;margin-top:3px">
           +${verborgenRijen.length} meer ▾
         </button>` : '';

    const teller = gekoppeld > 0
      ? `<span style="font-size:10px;font-family:var(--mono);color:var(--muted);flex-shrink:0">${gekoppeld}/${totaal}</span>`
      : `<span class="prep-regel-status open" style="flex-shrink:0">${resterend} open</span>`;

    return `<div class="prep-order-regel${isGes ? ' geselecteerd' : ''}"
                data-rep-id="${safeId}"
                data-opdrachtnr="${safeNr}"
                data-artikelcode="${safeArt}"
                data-label="${safeLbl}"
                data-pg="${safePgAttr}"
                onclick="prepSelecteerRegel('${safeId}','${safeNr}','${safeArt}','${safePgAttr}','${safeLbl}')">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="prep-regel-apparaat" style="flex:1">${label}</div>
          ${teller}
        </div>
        <div class="prep-regel-merk">${esc(r.merk || '')}${r.model ? ' · ' + esc(r.model) : ''}${r.productgroep ? ` <span style="font-family:var(--mono);font-size:10px;color:var(--muted)">${esc(r.productgroep)}</span>` : ''}</div>
        <div onclick="event.stopPropagation()">
          ${eersteRijen}
          <div id="${toggleId}" style="display:none">${extraRijen}</div>
          ${extraToggle}
        </div>
        <div onclick="event.stopPropagation()">${dropZone}</div>
      </div>
    </div>`;
  }).join('');

  const heeftOpen = werkRegels.some(r => {
    const tot  = parseInt(r.aantal) || 1;
    const act  = alle.filter(a => a.reparatie_id === r.id && a.status === 'actief').length;
    const afgr = alle.filter(a => a.reparatie_id === r.id && a.status === 'afgerond').length;
    const nvp  = alle.filter(a => a.reparatie_id === r.id && a.status === 'niet_op_voorraad').length;
    return Math.max(0, tot - act - afgr - nvp) > 0;
  });

  // Eerste open regel bepalen voor kaart-klik
  const eersteOpenRegel = werkRegels.find(r => {
    const tot = parseInt(r.aantal) || 1;
    const act = alle.filter(a => a.reparatie_id === r.id && a.status === 'actief').length;
    const afgr= alle.filter(a => a.reparatie_id === r.id && a.status === 'afgerond').length;
    return Math.max(0, tot - act - afgr) > 0;
  });
  const kaartKlikAttr = eersteOpenRegel ? (() => {
    const si = eersteOpenRegel.id.replace(/'/g, "\\'");
    const sn = (eersteOpenRegel.opdrachtnr || '').replace(/'/g, "\\'");
    const sa = (eersteOpenRegel.artikelcode || '').replace(/'/g, "\\'");
    const sp = (eersteOpenRegel.productgroep || '').replace(/'/g, "\\'");
    const lb = ([eersteOpenRegel.artikelcode, eersteOpenRegel.artikelomschrijving].filter(Boolean).map(esc).join(' · ') || '—').replace(/'/g, "\\'");
    return `onclick="prepSelecteerRegel('${si}','${sn}','${sa}','${sp}','${lb}')"`;
  })() : '';

  const kaartDropAttr = eersteOpenRegel ? (() => {
    const si = eersteOpenRegel.id.replace(/'/g, "\\'");
    const sn = (eersteOpenRegel.opdrachtnr || '').replace(/'/g, "\\'");
    const sa = (eersteOpenRegel.artikelcode || '').replace(/'/g, "\\'");
    const lb = ([eersteOpenRegel.artikelcode, eersteOpenRegel.artikelomschrijving].filter(Boolean).map(esc).join(' · ') || '—').replace(/'/g, "\\'");
    return `ondragover="prepKaartDragOver(event)" ondragleave="prepKaartDragLeave(event)" ondrop="prepDropOpKaart(event,'${si}','${sn}','${sa}','${lb}')"`;
  })() : '';

  return `<div class="opdracht-groep${heeftOpen ? ' gedeeltelijk' : ''}" ${kaartDropAttr}>
    <div class="groep-header${heeftOpen ? '' : ''}" style="cursor:${heeftOpen ? 'pointer' : 'default'}" ${kaartKlikAttr}>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
          <span style="font-size:13px;font-weight:700;font-family:var(--mono)">${esc(hoofd.opdrachtnr)}</span>
          ${hoofd.opdrachtcode ? `<span style="font-size:11px;font-family:var(--mono);font-weight:600;color:var(--accent)">${esc(hoofd.opdrachtcode)}</span>` : ''}
          ${hoofd.afstand_km != null ? `<span style="font-size:10px;font-family:var(--mono);background:var(--bg3);border:1px solid var(--border);border-radius:3px;padding:1px 6px;color:var(--muted)">📍 ${Math.round(hoofd.afstand_km)} km</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:1px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--muted)">${esc(hoofd.klant_naam || '')}${hoofd.klant_nummer ? ` · <span style="font-family:var(--mono);font-size:11px">${esc(hoofd.klant_nummer)}</span>` : ''}</span>
          ${hoofd.afstand_km != null ? `<span style="font-size:10px;font-family:var(--mono);background:var(--bg3);border:1px solid var(--border);border-radius:3px;padding:1px 6px;color:var(--muted);flex-shrink:0">📍 ${Math.round(hoofd.afstand_km)} km</span>` : ''}
        </div>
      </div>
    </div>
    <div class="prep-order-regels">${regelRijenHTML}</div>
  </div>`;
}

function prepSelecteerRegel(reparatieId, opdrachtnr, artikelcode, productgroep, label) {
  const wasGes = _prepGeselecteerdeRegel?.reparatieId === reparatieId;
  _prepGeselecteerdeRegel = wasGes ? null : { reparatieId, opdrachtnr, artikelcode, productgroep: productgroep || '', label };
  prepRenderOrders();
  prepRenderVoorraad();
}

function prepToggleTagnrs(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  const btn = el.previousElementSibling?.querySelector('button');
  if (btn) btn.textContent = btn.textContent.includes('▾')
    ? btn.textContent.replace('▾','▴') : btn.textContent.replace('▴','▾');
}

let _prepDragApparaatId   = null;
let _prepDragTagnr        = null;
let _prepDragType         = null; // 'inv' = uit voorraad, 'tagnr' = uit orderregel
let _prepDragProductgroep = null;

// Sleep vanuit het linker voorraad-paneel
function prepDragStart(event, apparaatId, tagnr, productgroep) {
  _prepDragApparaatId   = apparaatId;
  _prepDragTagnr        = tagnr;
  _prepDragType         = 'inv';
  _prepDragProductgroep = productgroep || '';
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', tagnr);
}

// Sleep vanuit een tagnr-rij in een orderregel
function prepTagnrDragStart(event, apparaatId, tagnr) {
  const a = (state.witgoedApparaten || []).find(x => x.id === apparaatId)
         || (state.prepApparaten    || []).find(x => x.id === apparaatId);
  _prepDragApparaatId   = apparaatId;
  _prepDragTagnr        = tagnr;
  _prepDragType         = 'tagnr';
  _prepDragProductgroep = a?.productgroep || '';
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', tagnr);
}

// Drop op een orderregel drop-zone
async function prepDrop(event, reparatieId, opdrachtnr, artikelcode, label, regelPg) {
  event.preventDefault();
  event.currentTarget?.classList.remove('drag-over');
  if (!_prepDragApparaatId || !_prepDragTagnr) return;

  // Productgroep-check
  if (regelPg && _prepDragProductgroep && regelPg !== _prepDragProductgroep) {
    toast(`✕ Productgroep komt niet overeen (${_prepDragProductgroep} ≠ ${regelPg})`);
    _prepDragApparaatId   = null;
    _prepDragTagnr        = null;
    _prepDragType         = null;
    _prepDragProductgroep = null;
    return;
  }

  const id    = _prepDragApparaatId;
  const tagnr = _prepDragTagnr;
  const type  = _prepDragType;
  _prepDragApparaatId   = null;
  _prepDragTagnr        = null;
  _prepDragType         = null;
  _prepDragProductgroep = null;

  if (type === 'tagnr') {
    await prepHerplaats(id, reparatieId, opdrachtnr);
  } else {
    _prepGeselecteerdeRegel = { reparatieId, opdrachtnr, artikelcode, label };
    await prepKoppel(id, tagnr);
  }
}

// Container-niveau drag — robuuster dan per-element handlers omdat
// child-elementen anders dragover onderscheppen zonder preventDefault
let _prepHoverRegel = null;

function prepListDragOver(event) {
  if (!_prepDragApparaatId) return;
  event.preventDefault();
  const regel = event.target.closest('.prep-order-regel');
  if (regel !== _prepHoverRegel) {
    _prepHoverRegel?.classList.remove('drag-over-regel');
    _prepHoverRegel = regel || null;
    _prepHoverRegel?.classList.add('drag-over-regel');
  }
}

function prepListDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    _prepHoverRegel?.classList.remove('drag-over-regel');
    _prepHoverRegel = null;
  }
}

async function prepListDrop(event) {
  event.preventDefault();
  const regel = _prepHoverRegel || event.target.closest('.prep-order-regel');
  _prepHoverRegel?.classList.remove('drag-over-regel');
  _prepHoverRegel = null;
  if (!regel) return;
  const d = regel.dataset;
  // Productgroep rechtstreeks uit state halen om encoding-mismatches te vermijden
  const rep = (state.reparaties || []).find(r => r.id === d.repId);
  const regelPg = rep?.productgroep || '';
  await prepDrop(event, d.repId, d.opdrachtnr, d.artikelcode, d.label, regelPg);
}

// Drop op de hele orderkaart (valt terug op eerste open regel)
function prepKaartDragOver(event) {
  if (!_prepDragApparaatId) return;
  event.preventDefault();
  event.currentTarget.classList.add('drag-over-kaart');
}

function prepKaartDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove('drag-over-kaart');
}

async function prepDropOpKaart(event, reparatieId, opdrachtnr, artikelcode, label) {
  event.currentTarget.classList.remove('drag-over-kaart');
  const rep = (state.reparaties || []).find(r => r.id === reparatieId);
  const regelPg = rep?.productgroep || '';
  await prepDrop(event, reparatieId, opdrachtnr, artikelcode, label, regelPg);
}

// Drop op het linker paneel = ontkoppelen
function prepOntkoppelDragOver(event) {
  event.preventDefault(); // Altijd toestaan zodat drop-event kan vuren
  if (_prepDragType === 'tagnr') {
    event.currentTarget.classList.add('drop-ontkoppel-hover');
  }
}

function prepOntkoppelDragLeave(event) {
  event.currentTarget.classList.remove('drop-ontkoppel-hover');
}

async function prepOntkoppelDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('drop-ontkoppel-hover');
  if (_prepDragType !== 'tagnr' || !_prepDragApparaatId) return;
  const id    = _prepDragApparaatId;
  const tagnr = _prepDragTagnr;
  _prepDragApparaatId   = null;
  _prepDragTagnr        = null;
  _prepDragType         = null;
  _prepDragProductgroep = null;
  await prepOntkoppel(id, tagnr);
}

async function prepHerplaats(apparaatId, nieuweReparatieId, nieuweOpdrachtnr) {
  try {
    const { error } = await sb.from('witgoed_apparaten')
      .update({ reparatie_id: nieuweReparatieId, opdrachtnr: nieuweOpdrachtnr })
      .eq('id', apparaatId);
    if (error) throw error;
    state.witgoedApparaten = (state.witgoedApparaten || []).map(a =>
      a.id === apparaatId ? { ...a, reparatie_id: nieuweReparatieId, opdrachtnr: nieuweOpdrachtnr } : a
    );
    // Ook in prepApparaten updaten
    if (state.prepApparaten) {
      state.prepApparaten = state.prepApparaten.map(a =>
        a.id === apparaatId ? { ...a, reparatie_id: nieuweReparatieId, opdrachtnr: nieuweOpdrachtnr } : a
      );
    }
    toast(`✓ ${_prepDragTagnr} verplaatst naar ${nieuweOpdrachtnr}`);
    setTimeout(() => { prepRenderOrders(); prepRenderVoorraad(); }, 50);
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

async function prepOntkoppel(apparaatId, tagnr) {
  try {
    const { error } = await sb.from('witgoed_apparaten')
      .update({ reparatie_id: null, opdrachtnr: null, prep_gekoppeld: false })
      .eq('id', apparaatId);
    if (error) throw error;
    const update = a => a.id === apparaatId ? { ...a, reparatie_id: null, opdrachtnr: null, prep_gekoppeld: false } : a;
    state.witgoedApparaten = (state.witgoedApparaten || []).map(update);
    if (state.prepApparaten) state.prepApparaten = state.prepApparaten.map(update);
    toast(`↩ ${tagnr} ontkoppeld`);
    setTimeout(() => { prepRenderOrders(); prepRenderVoorraad(); }, 50);
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

// ── Links: voorraad ───────────────────────────────────────────
function prepRenderVoorraad() {
  const el    = document.getElementById('prep-voorraad-lijst');
  const tel   = document.getElementById('prep-voorraad-tel');
  const titel = document.getElementById('prep-voorraad-titel');
  const regel = _prepGeselecteerdeRegel;

  const alle = (state.prepApparaten || state.witgoedApparaten || [])
    .filter(a => a.tagnr && a.tagnr !== '—' && a.status !== 'geannuleerd');

  if (!regel) {
    tel.textContent = alle.length;
    if (titel) titel.textContent = 'Beschikbare voorraad';
    if (!alle.length) {
      el.innerHTML = '<div class="prep-leeg">Nog geen apparaten gescand vandaag</div>';
      return;
    }
    el.innerHTML = alle.map(a => prepVoorraadItemHTML(a, true)).join('');
    return;
  }

  const gefilterd = regel.productgroep
    ? alle.filter(a => (a.productgroep || '') === regel.productgroep)
    : alle;

  if (titel) titel.textContent = regel.productgroep
    ? `Voorraad · ${regel.productgroep}`
    : 'Beschikbare voorraad';
  tel.textContent = gefilterd.length;

  if (!gefilterd.length) {
    el.innerHTML = `<div class="prep-leeg">Geen apparaat gevonden voor<br><strong>${esc(regel.artikelcode || 'dit artikel')}</strong></div>`;
    return;
  }

  el.innerHTML = gefilterd.map(a => prepVoorraadItemHTML(a, true)).join('');
}

function prepVoorraadItemHTML(a, klikbaar) {
  const isAf  = a.status === 'afgerond';
  const rep   = (state.reparaties || []).find(r => r.id === a.reparatie_id);
  const artCode = rep?.artikelcode || '';

  const ontkoppeld  = !a.prep_gekoppeld;
  const statusLabel = isAf
    ? `<span style="font-size:10px;font-weight:600;font-family:var(--mono);padding:2px 6px;border-radius:4px;background:rgba(236,101,0,.1);border:1px solid var(--accent);color:var(--accent)">Beschikbaar</span>`
    : `<span style="font-size:10px;font-weight:600;font-family:var(--mono);padding:2px 6px;border-radius:4px;background:#e8f0f8;border:1px solid #aac4e0;color:#004582">In werkplaats${a.werkplek ? ' · ' + esc(a.werkplek) : ''}</span>`;

  const nenO = a.nen_optisch ? prepNenKleur(a.nen_optisch) : null;
  const nenT = a.nen_technisch ? prepNenKleur(a.nen_technisch) : null;

  const nenOptBadge  = nenO ? `<span style="font-size:11px;font-weight:700;font-family:var(--mono);padding:2px 6px;border-radius:4px;border:1px solid ${nenO.border};background:${nenO.bg};color:${nenO.text}">👁 ${esc(a.nen_optisch)}</span>` : '';
  const nenTechBadge = nenT ? `<span style="font-size:11px;font-weight:700;font-family:var(--mono);padding:2px 6px;border-radius:4px;border:1px solid ${nenT.border};background:${nenT.bg};color:${nenT.text}">🔧 ${esc(a.nen_technisch)}</span>` : '';
  const draaiBadge   = a.draaiuren != null ? `<span style="font-size:11px;font-family:var(--mono);padding:2px 6px;border-radius:4px;background:var(--bg3);border:1px solid var(--border);color:var(--muted)">⏱ ${a.draaiuren}u</span>` : '';

  const pg          = a.productgroep || '';
  const gealloceerd = a.prep_gekoppeld === true;
  const dragAttr    = klikbaar ? `draggable="true" ondragstart="prepDragStart(event,'${a.id}','${esc(a.tagnr)}','${esc(pg)}')"` : '';

  const artDisplay    = a.artikelcode || artCode;
  const apparaatType  = a.artikelomschrijving || rep?.artikelomschrijving || '';

  return `<div class="prep-inv-item${klikbaar ? '' : ' prep-inv-readonly'}${gealloceerd ? ' prep-inv-gealloceerd' : ''}" ${dragAttr}>
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:4px">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin-bottom:3px">
          ${artDisplay ? `<span style="font-size:12px;font-weight:700;font-family:var(--mono);color:var(--accent)">${esc(artDisplay)}</span>` : ''}
          ${apparaatType ? `<span style="font-size:11px;color:var(--text);font-weight:500">${esc(apparaatType)}</span>` : ''}
          ${pg ? `<span style="font-size:10px;font-family:var(--mono);color:var(--muted);background:var(--bg3);border:1px solid var(--border);border-radius:3px;padding:1px 4px">${esc(pg)}</span>` : ''}
        </div>
        <div class="prep-inv-tag" style="font-size:15px">${esc(a.tagnr)}</div>
      </div>
      ${statusLabel}
    </div>
    <div class="prep-inv-meta" style="gap:5px;flex-wrap:wrap;margin-top:6px">
      ${nenOptBadge}${nenTechBadge}${draaiBadge}
    </div>
    ${a.prep_gekoppeld && a.opdrachtnr ? `<div style="margin-top:5px"><span style="font-size:11px;font-family:var(--mono);font-weight:600;color:var(--info);background:rgba(0,69,130,.07);border:1px solid rgba(0,69,130,.2);border-radius:3px;padding:1px 5px">${esc(a.opdrachtnr)}</span></div>` : ''}
    ${klikbaar ? `<div style="font-size:10px;color:var(--muted);margin-top:6px;text-align:center">Sleep naar een opdrachtregel →</div>` : ''}
  </div>`;
}

// ── Koppelen ──────────────────────────────────────────────────
async function prepKoppel(apparaatId, tagnr) {
  const regel = _prepGeselecteerdeRegel;
  if (!regel) return;

  const alle = state.witgoedApparaten || [];
  const nvpRecord = alle.find(a => a.reparatie_id === regel.reparatieId && a.status === 'niet_op_voorraad');

  try {
    if (nvpRecord) {
      // Koppel tagnr aan bestaand niet-op-voorraad record
      const { error } = await sb.from('witgoed_apparaten')
        .update({ tagnr, status: 'actief', prep_gekoppeld: true })
        .eq('id', nvpRecord.id);
      if (error) throw error;
      const updateNvp = a => a.id === nvpRecord.id ? { ...a, tagnr, status: 'actief', prep_gekoppeld: true } : a;
      state.witgoedApparaten = alle.map(updateNvp);
      if (state.prepApparaten) state.prepApparaten = state.prepApparaten.map(updateNvp);
    } else {
      // Wijs het gescande apparaat toe aan deze orderregel
      const { error } = await sb.from('witgoed_apparaten')
        .update({ reparatie_id: regel.reparatieId, opdrachtnr: regel.opdrachtnr, prep_gekoppeld: true })
        .eq('id', apparaatId);
      if (error) throw error;
      const updateKop = a => a.id === apparaatId ? { ...a, reparatie_id: regel.reparatieId, opdrachtnr: regel.opdrachtnr, prep_gekoppeld: true } : a;
      state.witgoedApparaten = alle.map(updateKop);
      if (state.prepApparaten) state.prepApparaten = state.prepApparaten.map(updateKop);
    }

    _prepGeselecteerdeRegel = null;
    toast(`✓ ${tagnr} gekoppeld aan ${regel.opdrachtnr}`);
    prepRenderOrders();
    prepRenderVoorraad();
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

// ── LOCATIE MODULE ────────────────────────────────────────────
let _locTag = null;
let _locFlashTimer = null;

function locReset() {
  _locTag = null;

  const tagIn = document.getElementById('loc-tag-input');
  const locIn = document.getElementById('loc-loc-input');
  const badge = document.getElementById('loc-tag-badge');

  tagIn.value = ''; locIn.value = '';
  locIn.disabled = true;
  badge.style.display = 'none'; badge.textContent = '';
  document.getElementById('loc-stap2-kaart').style.opacity = '.45';
  document.getElementById('loc-nr1').className = 'loc-stap-nr actief';
  document.getElementById('loc-nr2').className = 'loc-stap-nr';

  tagIn.focus();
}

function locTagGescand() {
  const tagIn = document.getElementById('loc-tag-input');
  const tag   = tagIn.value.trim().toUpperCase();
  if (!tag) return;

  _locTag = tag;

  const badge = document.getElementById('loc-tag-badge');
  badge.textContent = tag;
  badge.style.display = 'block';

  document.getElementById('loc-nr1').className = 'loc-stap-nr klaar';
  document.getElementById('loc-nr2').className = 'loc-stap-nr actief';

  const locIn = document.getElementById('loc-loc-input');
  locIn.disabled = false; locIn.value = '';
  document.getElementById('loc-stap2-kaart').style.opacity = '1';
  locIn.focus();
}

function locLocGescand() {
  const locIn  = document.getElementById('loc-loc-input');
  const locatie = locIn.value.trim().toUpperCase();
  if (!locatie || !_locTag) return;
  locOpslaanNaarDb(locatie);
}

async function locOpslaanNaarDb(locatie) {
  const locIn = document.getElementById('loc-loc-input');
  const flash = document.getElementById('loc-flash');
  locIn.disabled = true;

  try {
    const nu = new Date().toISOString();
    const { error } = await sb.from('tags')
      .update({ locatie, bijgewerkt_op: nu })
      .eq('tagnummer', _locTag);
    if (error) throw error;

    locLogToevoegen(_locTag, locatie, new Date());

    flash.className = 'loc-flash ok';
    flash.textContent = `✓ ${_locTag} → ${locatie}`;
    flash.style.display = 'block';
    flash.style.opacity = '1';

    clearTimeout(_locFlashTimer);
    _locFlashTimer = setTimeout(() => {
      flash.style.opacity = '0';
      setTimeout(() => { flash.style.display = 'none'; locReset(); }, 300);
    }, 1200);

  } catch(e) {
    flash.className = 'loc-flash fout';
    flash.textContent = '✗ ' + e.message;
    flash.style.display = 'block';
    flash.style.opacity = '1';
    locIn.disabled = false;
    locIn.focus();
  }
}

function locLogToevoegen(tag, locatie, datum) {
  const wrap = document.getElementById('loc-log-wrap');
  const lijst = document.getElementById('loc-log-lijst');
  const tijd = datum.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const rij = document.createElement('div');
  rij.className = 'loc-log-rij';
  rij.innerHTML = `
    <div><span class="loc-log-tag">${tag}</span><span class="loc-log-pijl">→</span><span class="loc-log-loc">${locatie}</span></div>
    <div class="loc-log-tijd">${tijd}</div>`;
  lijst.insertBefore(rij, lijst.firstChild);
  wrap.style.display = 'block';
}

async function locLaadVandaagLog() {
  const lijst = document.getElementById('loc-log-lijst');
  const wrap  = document.getElementById('loc-log-wrap');
  lijst.innerHTML = '';

  const vandaagStart = new Date(); vandaagStart.setHours(0,0,0,0);
  const vandaagEind  = new Date(); vandaagEind.setHours(23,59,59,999);

  try {
    const { data } = await sb.from('tags')
      .select('tagnummer, locatie, bijgewerkt_op')
      .gte('bijgewerkt_op', vandaagStart.toISOString())
      .lte('bijgewerkt_op', vandaagEind.toISOString())
      .order('bijgewerkt_op', { ascending: false });

    if (!data?.length) return;
    data.forEach(r => {
      const datum = new Date(r.bijgewerkt_op);
      const tijd  = datum.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const rij   = document.createElement('div');
      rij.className = 'loc-log-rij';
      rij.innerHTML = `
        <div><span class="loc-log-tag">${r.tagnummer}</span><span class="loc-log-pijl">→</span><span class="loc-log-loc">${r.locatie}</span></div>
        <div class="loc-log-tijd">${tijd}</div>`;
      lijst.appendChild(rij);
    });
    wrap.style.display = 'block';
  } catch { /* log stil falen */ }
}

// ── WITGOED CLAIM SYSTEEM ─────────────────────────────────────

async function laadWitgoedApparaten() {
  if (state.demoMode || !state.monteur) return;
  const { data } = await sb.from('witgoed_apparaten')
    .select('*')
    .in('status', ['actief', 'niet_op_voorraad', 'afgerond'])
    .order('aangemaakt_op', { ascending: true });
  state.witgoedApparaten = data || [];
  renderLists();
}

function witgoedGroepCardHTML(regels, mijnId) {
  regels.sort((a, b) => (a.regelnummer ?? 0) - (b.regelnummer ?? 0));
  const hoofd      = regels[0];
  const nr         = hoofd.opdrachtnr;
  const groepId    = `groep-wg-${nr}`.replace(/[^a-z0-9-]/gi, '_');
  const werkRegels      = regels.filter(r => (r.doorsluizenjn||'').toUpperCase() === 'J' && !isInstructieRegel(r));
  const onderdeelRegels = regels.filter(r => (r.doorsluizenjn||'').toUpperCase() === 'N' && !isInstructieRegel(r));
  const alle            = state.witgoedApparaten || [];

  // Totaal / geclaimd count voor badge — unieke tagnrs, actief+afgerond, geen geannuleerd
  const totaalApparaten = werkRegels.reduce((s, r) => s + (parseInt(r.aantal) || 1), 0);
  const gekoppeldSet    = new Set(
    alle.filter(a =>
      werkRegels.some(r => r.id === a.reparatie_id) &&
      ['actief', 'afgerond'].includes(a.status) &&
      a.tagnr && a.tagnr !== '—'
    ).map(a => a.tagnr)
  );
  const geclaimdApparaten  = gekoppeldSet.size;
  const resterendApparaten = Math.max(0, totaalApparaten - geclaimdApparaten);
  const statusBadge = resterendApparaten === 0
    ? `<span class="badge-gedeeltelijk" style="color:var(--ok);background:rgba(26,143,79,.1);border-color:rgba(26,143,79,.3)">✓ vol</span>`
    : geclaimdApparaten > 0
    ? `<span class="badge-gedeeltelijk">${resterendApparaten} resterend · ${geclaimdApparaten}/${totaalApparaten}</span>`
    : `<span class="badge-regels">${totaalApparaten} te claimen</span>`;

  // Deadline
  const dlDatum = hoofd.uiterste_datum_afdeling;
  let deadlineHTML = '';
  if (dlDatum) {
    const d      = new Date(dlDatum);
    const dagen  = Math.ceil((d - new Date()) / 86400000);
    const kleur  = dagen <= 0 ? 'var(--danger)' : dagen <= 2 ? '#e66519' : null;
    const dlabel = dagen <= 0 ? 'Verlopen' : dagen === 1 ? 'Morgen' : `${dagen} d`;
    const datStr = d.toLocaleDateString('nl-NL', {day:'2-digit', month:'2-digit'});
    deadlineHTML = kleur
      ? `<span style="font-size:10px;font-family:var(--mono);font-weight:600;color:${kleur};border:1px solid ${kleur};border-radius:3px;padding:1px 5px">⏱ ${dlabel} · ${datStr}</span>`
      : `<span style="font-size:10px;color:var(--muted);font-family:var(--mono)">${datStr}</span>`;
  }

  // 99-werkplaats taken
  const extraWerk = state.reparaties.filter(r => r.opdrachtnr === nr && isInstructieRegel(r))
    .sort((a,b) => (a.regelnummer ?? 0) - (b.regelnummer ?? 0));
  const werkplaatsTaken = [...new Set(extraWerk.map(r => r.artikelomschrijving || r.handeling).filter(Boolean))];
  const wpSectieHTML = werkplaatsTaken.length ? `
    <div class="groep-extra-sectie" style="border-top:1px solid var(--border)">
      <div class="groep-extra-label">Extra werkzaamheden (99-Werkplaats)</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${werkplaatsTaken.map(t => `<span style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:12px">${esc(t)}</span>`).join('')}
      </div>
    </div>` : '';

  // Klacht (collapsible)
  const heeftKlacht  = !!(hoofd.klacht);
  const opmSectieHTML = heeftKlacht ? `
    <div class="groep-extra-sectie" id="opm-sectie-${groepId}" style="display:none">
      <div class="groep-extra-label">Opmerking / klacht</div>
      <div>${esc(hoofd.klacht)}</div>
    </div>` : '';

  // Regel rijen
  const regelRijenHTML = werkRegels.map(r => {
    const safeId     = r.id.replace(/'/g, "\\'");
    const safeNr     = esc(nr).replace(/'/g, '&#39;');
    const label      = [r.artikelcode, r.artikelomschrijving].filter(Boolean).map(esc).join(' · ') || esc(r.handeling) || '—';
    const safeLabel  = label.replace(/'/g, '&#39;');
    const totaal     = parseInt(r.aantal) || 1;
    const regelTagnrs = new Set(
      alle.filter(a =>
        a.reparatie_id === r.id &&
        ['actief', 'afgerond'].includes(a.status) &&
        a.tagnr && a.tagnr !== '—'
      ).map(a => a.tagnr)
    );
    const actiefCnt  = alle.filter(a => a.reparatie_id === r.id && a.status === 'actief').length;
    const afgrndCnt  = alle.filter(a => a.reparatie_id === r.id && a.status === 'afgerond').length;
    const nvpCnt     = alle.filter(a => a.reparatie_id === r.id && a.status === 'niet_op_voorraad').length;
    const resterend  = Math.max(0, totaal - regelTagnrs.size - nvpCnt);
    const kanClaimen = resterend > 0;

    const vrdBadge    = actiefCnt > 0 ? `<span style="font-family:var(--mono);font-size:10px;color:var(--accent)">${actiefCnt} actief</span>` : '';
    const afgrndBadge = afgrndCnt > 0 ? `<span style="font-family:var(--mono);font-size:10px;color:var(--ok)">✓ ${afgrndCnt}</span>` : '';
    const nvpBadge    = nvpCnt    > 0 ? `<span style="font-family:var(--mono);font-size:10px;color:var(--danger)">⚠ ${nvpCnt} n.o.v.</span>` : '';

    const nvpBtn   = `<button class="nvp-regel-knop-${groepId}" style="display:none;background:none;color:var(--danger);border:1px solid var(--danger);border-radius:4px;font-size:12px;padding:4px 10px;cursor:pointer;white-space:nowrap;font-family:var(--font)" onclick="event.stopPropagation();meldNietOpVoorraad('${safeId}','${safeNr}','${safeLabel}')">niet op voorraad</button>`;
    const claimBtn = `<button class="claim-btn" onclick="event.stopPropagation();openWitgoedClaim('${safeId}','${safeNr}','${safeLabel}')">Claimen${resterend > 1 ? ` (${resterend})` : ''}</button>`;

    const actieHTML = kanClaimen
      ? `<div style="display:flex;gap:6px;align-items:center">${nvpBtn}${claimBtn}</div>`
      : (afgrndCnt + nvpCnt) >= totaal
      ? `<span style="font-size:11px;color:${nvpCnt > 0 ? 'var(--danger)' : 'var(--ok)'};font-family:var(--mono)">${nvpCnt > 0 ? '⚠ n.o.v.' : '✓ afgerond'}</span>`
      : `<span style="font-size:10px;color:var(--muted);font-family:var(--mono)">Vol</span>`;

    return `
      <div class="regel-rij${actiefCnt > 0 ? ' eigen' : ''}">
        <div class="regel-info">
          <span class="regel-handeling">${label}</span>
          <div style="display:flex;gap:8px;align-items:center">
            ${totaal > 1 ? `<span class="regel-artikel">Aantal: ${totaal}</span>` : ''}
            <span style="font-family:var(--mono);font-size:10px;color:${kanClaimen ? 'var(--info)' : 'var(--muted)'};">${resterend}/${totaal} vrij</span>
            ${vrdBadge}${afgrndBadge}${nvpBadge}
          </div>
        </div>
        <div class="regel-actie">${actieHTML}</div>
      </div>`;
  }).join('');

  const borderStijl = geclaimdApparaten > 0
    ? 'border-left:3px solid var(--accent)'
    : 'border-left:3px solid var(--info)';

  // Groep-meta: altijd zichtbaar, alleen J-regels
  const groepMetaHTML = `
    <div class="groep-meta" style="padding:0;flex-direction:column;align-items:stretch;gap:0">
      ${werkRegels.map((r, i) => {
        const totaal    = parseInt(r.aantal) || 1;
        const actiefCnt = alle.filter(a => a.reparatie_id === r.id && a.status === 'actief').length;
        const afgrndCnt = alle.filter(a => a.reparatie_id === r.id && a.status === 'afgerond').length;
        const nvpCnt    = alle.filter(a => a.reparatie_id === r.id && a.status === 'niet_op_voorraad').length;
        const resterend = Math.max(0, totaal - actiefCnt - afgrndCnt - nvpCnt);
        const vrij_kleur = resterend > 0 ? 'var(--info)' : 'var(--muted)';
        const rowBg = i % 2 === 1 ? 'var(--bg2)' : 'var(--bg)';
        const sid  = r.id;
        const snr  = esc(nr).replace(/'/g,'&#39;');
        const lbl  = [r.artikelcode, r.artikelomschrijving].filter(Boolean).map(esc).join(' · ') || esc(r.handeling) || '—';
        const slbl = lbl.replace(/'/g,'&#39;');
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 14px;background:${rowBg};border-bottom:1px solid var(--border)">
          <div style="display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;min-width:0">
            ${r.artikelcode   ? `<span style="font-family:var(--mono);font-size:12px;color:var(--text);font-weight:600">${esc(r.artikelcode)}</span>` : ''}
            ${r.artikelomschrijving ? `<span style="font-size:12px;color:var(--muted)">${esc(r.artikelomschrijving)}</span>` : ''}
            ${totaal > 1 ? `<span style="font-family:var(--mono);font-size:11px;color:var(--muted)">×${totaal}</span>` : ''}
            <span style="font-family:var(--mono);font-size:11px;color:${vrij_kleur}">${resterend}/${totaal} vrij</span>
            ${actiefCnt > 0 ? `<span style="font-family:var(--mono);font-size:10px;color:var(--accent)">${actiefCnt} actief</span>` : ''}
            ${afgrndCnt > 0 ? `<span style="font-family:var(--mono);font-size:10px;color:var(--ok)">✓ ${afgrndCnt}</span>` : ''}
            ${nvpCnt    > 0 ? `<span style="font-family:var(--mono);font-size:10px;color:var(--danger)">⚠ ${nvpCnt} n.o.v.</span>` : ''}
          </div>
          ${resterend > 0 ? `<button class="nvp-meta-knop-${groepId}" style="display:none;flex-shrink:0;background:none;border:1px solid var(--danger);border-radius:4px;font-size:11px;font-weight:700;color:var(--danger);cursor:pointer;white-space:nowrap;padding:2px 8px;font-family:var(--font)" onclick="event.stopPropagation();meldNietOpVoorraad('${sid}','${snr}','${slbl}')">niet op voorraad</button>` : ''}
        </div>`;
      }).join('')}
      ${deadlineHTML ? `<div style="padding:4px 14px 6px">${deadlineHTML}</div>` : ''}
    </div>`;

  return `
    <div class="opdracht-groep${geclaimdApparaten > 0 ? ' gedeeltelijk' : ''}" style="${borderStijl}">
      <div class="groep-header" onclick="toggleGroep('${groepId}')">
        <div class="groep-header-links">
          <span class="card-nummer">${esc(nr)}</span>
          ${hoofd.opdrachtcode  ? `<span class="groep-code">${esc(hoofd.opdrachtcode)}</span>` : ''}
          ${hoofd.abonneecode   ? `<span class="groep-code">${esc(hoofd.abonneecode)}</span>`  : ''}
          ${statusBadge}
          ${hoofd.opdrachtstatus ? `<span style="font-size:10px;font-family:var(--mono);background:var(--bg3);color:var(--muted);border:1px solid var(--border);border-radius:3px;padding:1px 5px;white-space:nowrap">${esc(hoofd.opdrachtstatus)}</span>` : ''}
          ${hoofd.organisatie   ? `<span style="font-size:10px;font-family:var(--mono);background:#f0f8ec;color:#2d6a2d;border:1px solid #b6d9b6;border-radius:3px;padding:1px 5px;white-space:nowrap">${esc(hoofd.organisatie)}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
          ${werkRegels.some(r => { const t=parseInt(r.aantal)||1; const a=alle.filter(x=>x.reparatie_id===r.id&&x.status==='actief').length; const g=alle.filter(x=>x.reparatie_id===r.id&&x.status==='afgerond').length; const n=alle.filter(x=>x.reparatie_id===r.id&&x.status==='niet_op_voorraad').length; return Math.max(0,t-a-g-n)>0; }) ? `<button class="groep-icon-btn" id="nvp-hdr-btn-${groepId}" title="Niet op voorraad melden" style="color:var(--danger)" onclick="event.stopPropagation();toggleNvpMelden('${groepId}')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.5" r=".5" fill="currentColor"/></svg></button>` : ''}
          ${heeftKlacht ? `<button class="groep-icon-btn" id="opm-btn-${groepId}" title="Opmerking / klacht" onclick="event.stopPropagation();toggleGroepSectie('opm-sectie-${groepId}','opm-btn-${groepId}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>` : ''}
          <span class="groep-chevron" id="chevron-${groepId}">▸</span>
        </div>
      </div>
      ${wpSectieHTML}
      ${opmSectieHTML}
      ${groepMetaHTML}
      <div class="groep-regels" id="${groepId}" style="display:none">
        ${regelRijenHTML}
        ${onderdeelRegels.length ? `
        <div style="border-top:1px solid var(--border)">
          <div onclick="toggleGroep('ond-${groepId}')" style="padding:8px 14px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:11px;color:var(--muted);">
            <span style="font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em">Onderdelen (${onderdeelRegels.length})</span>
            <span class="groep-chevron" id="chevron-ond-${groepId}">▸</span>
          </div>
          <div id="ond-${groepId}" style="display:none;flex-direction:column">
            ${onderdeelRegels.map(r => {
              const label = [r.artikelcode, r.artikelomschrijving].filter(Boolean).map(esc).join(' · ') || esc(r.handeling) || '—';
              return `<div class="regel-rij">
                <div class="regel-info">
                  <span class="regel-handeling">${label}</span>
                  ${r.aantal != null ? `<span class="regel-artikel">Aantal: ${r.aantal}</span>` : ''}
                </div>
                <div class="regel-actie"><span style="font-size:10px;color:var(--muted);font-family:var(--mono)">onderdeel</span></div>
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>`;
}


let _witgoedClaimState = null;

function openWitgoedClaim(reparatieId, opdrachtnr, label) {
  _witgoedClaimState = { reparatieId, opdrachtnr, label };
  document.getElementById('wc-tagnr-input').value = '';
  document.getElementById('wc-werkplek-input').value = '';
  document.getElementById('wc-nen-optisch-input').value = '';
  document.getElementById('wc-tagnr-error').style.display = 'none';
  document.getElementById('wc-werkplek-error').style.display = 'none';
  document.getElementById('wc-stap-tagnr').style.display = '';
  document.getElementById('wc-stap-werkplek').style.display = 'none';
  document.getElementById('wc-terug-btn').style.display = 'none';
  const btn = document.getElementById('wc-volgende-btn');
  btn.textContent = 'Volgende →'; btn.disabled = false;
  btn.onclick = bevestigWitgoedTagnr;
  document.getElementById('wc-stap-titel').textContent = 'Tagnummer scannen';
  document.getElementById('wc-opdracht-label').textContent = `${opdrachtnr} · ${label}`;
  document.getElementById('scherm-witgoed-claim').classList.add('open');
  setTimeout(() => document.getElementById('wc-tagnr-input').focus(), 100);
}

function sluitWitgoedClaim() {
  document.getElementById('scherm-witgoed-claim').classList.remove('open');
  _witgoedClaimState = null;
}

function wcTerug() {
  document.getElementById('wc-stap-tagnr').style.display = '';
  document.getElementById('wc-stap-werkplek').style.display = 'none';
  document.getElementById('wc-werkplek-input').value = '';
  document.getElementById('wc-nen-optisch-input').value = '';
  document.getElementById('wc-werkplek-error').style.display = 'none';
  document.getElementById('wc-terug-btn').style.display = 'none';
  const btn = document.getElementById('wc-volgende-btn');
  btn.textContent = 'Volgende →'; btn.disabled = false;
  btn.onclick = bevestigWitgoedTagnr;
  document.getElementById('wc-stap-titel').textContent = 'Tagnummer scannen';
  setTimeout(() => document.getElementById('wc-tagnr-input').focus(), 100);
}

function wcFocusNenOptisch() {
  const werkplek = document.getElementById('wc-werkplek-input').value.trim();
  if (!werkplek) return;
  setTimeout(() => document.getElementById('wc-nen-optisch-input')?.focus(), 50);
}

function toggleNvpMelden(groepId) {
  const hdr      = document.getElementById('nvp-hdr-btn-' + groepId);
  const groepEl  = document.getElementById(groepId);
  const expanded = groepEl && groepEl.style.display !== 'none';
  const selector = expanded ? '.nvp-regel-knop-' + groepId : '.nvp-meta-knop-' + groepId;
  const btns     = document.querySelectorAll(selector);
  const open     = btns.length > 0 && btns[0].style.display === 'none';
  btns.forEach(b => b.style.display = open ? '' : 'none');
  if (hdr) hdr.classList.toggle('actief', open);
}

async function meldNietOpVoorraad(reparatieId, opdrachtnr, label) {
  if (!state.monteur) return;
  const alle      = state.witgoedApparaten || [];
  const regel     = state.reparaties.find(r => r.id === reparatieId);
  const totaal    = parseInt(regel?.aantal) || 1;
  const actiefCnt = alle.filter(a => a.reparatie_id === reparatieId && a.status === 'actief').length;
  const afgrndCnt = alle.filter(a => a.reparatie_id === reparatieId && a.status === 'afgerond').length;
  const nvpCnt    = alle.filter(a => a.reparatie_id === reparatieId && a.status === 'niet_op_voorraad').length;
  const resterend = Math.max(0, totaal - actiefCnt - afgrndCnt - nvpCnt);
  if (resterend === 0) return;
  const now = new Date().toISOString();
  const rijen = Array.from({ length: resterend }, () => ({
    reparatie_id:  reparatieId,
    opdrachtnr,
    monteur_id:    state.monteur.id,
    tagnr:         '—',
    status:        'niet_op_voorraad',
    aangemaakt_op: now,
  }));
  try {
    const { data, error } = await sb.from('witgoed_apparaten').insert(rijen).select();
    if (error) throw error;
    state.witgoedApparaten = [...alle, ...(data || [])];
    renderLists();
    toast(`⚠ Niet op voorraad gemeld: ${label} (${resterend}×)`);
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

async function terugzettenWitgoedApparaat(apparaatId) {
  const a = (state.witgoedApparaten || []).find(x => x.id === apparaatId);
  if (!a) return;
  if (!confirm(`Apparaat ${a.tagnr} terugzetten naar open?`)) return;
  try {
    const { error } = await sb.from('witgoed_apparaten')
      .update({ status: 'geannuleerd', afgerond_op: new Date().toISOString() })
      .eq('id', apparaatId);
    if (error) throw error;
    state.witgoedApparaten = state.witgoedApparaten.filter(x => x.id !== apparaatId);
    renderLists();
    toast(`↩ ${a.tagnr} teruggezet naar open`);
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

async function vrijgeefNietOpVoorraad(apparaatId) {
  try {
    const { error } = await sb.from('witgoed_apparaten').delete().eq('id', apparaatId);
    if (error) throw error;
    state.witgoedApparaten = (state.witgoedApparaten || []).filter(a => a.id !== apparaatId);
    renderLists();
    toast('Melding verwijderd');
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

async function wcNietOpVoorraad() {
  if (!_witgoedClaimState) return;
  const { reparatieId, opdrachtnr, label } = _witgoedClaimState;
  sluitWitgoedClaim();
  await meldNietOpVoorraad(reparatieId, opdrachtnr, label);
}


function bevestigWitgoedTagnr() {
  const tagnr = document.getElementById('wc-tagnr-input').value.trim();
  const errEl = document.getElementById('wc-tagnr-error');
  if (!tagnr) { errEl.textContent = 'Scan of voer een tagnummer in'; errEl.style.display = ''; return; }
  errEl.style.display = 'none';
  _witgoedClaimState.tagnr = tagnr;
  document.getElementById('wc-stap-tagnr').style.display = 'none';
  document.getElementById('wc-stap-werkplek').style.display = '';
  document.getElementById('wc-tagnr-confirm').textContent = `Tagnr: ${tagnr}`;
  document.getElementById('wc-terug-btn').style.display = '';
  const btn = document.getElementById('wc-volgende-btn');
  btn.textContent = 'Claimen →'; btn.disabled = false;
  btn.onclick = bevestigWitgoedWerkplek;
  document.getElementById('wc-stap-titel').textContent = 'Werkplek scannen';
  setTimeout(() => document.getElementById('wc-werkplek-input').focus(), 100);
}

async function bevestigWitgoedWerkplek() {
  const werkplek   = document.getElementById('wc-werkplek-input').value.trim();
  const nenOptisch = document.getElementById('wc-nen-optisch-input').value.trim();
  const errEl      = document.getElementById('wc-werkplek-error');
  if (!werkplek)   { errEl.textContent = 'Scan of voer een werkplek in'; errEl.style.display = ''; return; }
  if (!nenOptisch) { errEl.textContent = 'Voer NEN optisch in'; errEl.style.display = ''; return; }
  errEl.style.display = 'none';
  const { reparatieId, opdrachtnr, tagnr } = _witgoedClaimState;
  let rep = (state.reparaties || []).find(r => r.id === reparatieId);
  if (!rep) {
    const { data: repDb } = await sb.from('reparaties')
      .select('regelnummer, artikelcode, artikelomschrijving, productgroep')
      .eq('id', reparatieId).single();
    rep = repDb || null;
  }
  const btn = document.getElementById('wc-volgende-btn');
  btn.disabled = true; btn.textContent = 'Opslaan...';
  try {
    const nu = new Date().toISOString();
    const { data, error } = await sb.from('witgoed_apparaten').insert({
      reparatie_id:   reparatieId,
      opdrachtnr,
      regelnummer:    rep?.regelnummer   || null,
      artikelcode:    rep?.artikelcode   || null,
      artikelomschrijving:  rep?.artikelomschrijving || null,
      monteur_id:     state.monteur?.id,
      tagnr,
      werkplek,
      nen_optisch:    nenOptisch,
      productgroep:   rep?.productgroep  || null,
      status:         'actief',
      prep_gekoppeld: false,
      aangemaakt_op:  nu,
    }).select().single();
    if (error) throw error;
    state.witgoedApparaten = [...state.witgoedApparaten, data];

    sluitWitgoedClaim();
    renderLists();
    switchTab('behandeling');
    toast(`✓ ${tagnr} geclaimd op ${werkplek}`);
  } catch(e) {
    errEl.textContent = 'Fout: ' + e.message; errEl.style.display = '';
    btn.disabled = false; btn.textContent = 'Claimen →';
  }
}

function formateerTijdVerstreken(isoString) {
  if (!isoString) return '0m';
  const ms  = Date.now() - new Date(isoString).getTime();
  const min = Math.floor(ms / 60000);
  const uur = Math.floor(min / 60);
  const rest = min % 60;
  return uur > 0 ? `${uur}u ${String(rest).padStart(2,'0')}m` : `${min}m`;
}

let _wgTimerInterval = null;

function renderWitgoedBehandeling() {
  if (!heeftWitgoedToegang()) return;
  clearInterval(_wgTimerInterval);
  const mijnId    = state.monteur?.id;
  const alle      = state.witgoedApparaten || [];
  const apparaten = alle.filter(a => a.monteur_id === mijnId && a.status === 'actief');
  const nvpItems  = alle.filter(a => a.monteur_id === mijnId && a.status === 'niet_op_voorraad');
  const listBeh   = document.getElementById('list-behandeling');
  if (!listBeh || (!apparaten.length && !nvpItems.length)) return;

  const actiefHTML = apparaten.length ? `
    <div class="sectie-scheiding">
      <hr class="sectie-scheiding-lijn">
      <span class="sectie-scheiding-label">Witgoed apparaten (${apparaten.length})</span>
      <hr class="sectie-scheiding-lijn">
    </div>
    ${apparaten.map(a => {
      const rep   = state.reparaties.find(r => r.id === a.reparatie_id);
      const label = rep ? (rep.artikelcode || rep.artikelomschrijving || '—') : '—';
      const sub   = rep?.artikelomschrijving && rep?.artikelcode ? rep.artikelomschrijving : '';
      return `<div class="wg-app-kaart">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="card-nr" style="font-size:13px">${esc(a.opdrachtnr)}</span>
            <span style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--info)">${esc(a.tagnr)}</span>
            <span style="font-size:11px;color:var(--muted);background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:1px 7px">${esc(a.werkplek)}</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:3px">
            ${esc(label)}${sub ? ` · ${esc(sub)}` : ''}
            ${a.nen_optisch ? `<span style="font-family:var(--mono);font-size:10px;background:rgba(0,69,130,.08);color:var(--info);border:1px solid rgba(0,69,130,.2);border-radius:3px;padding:1px 5px;margin-left:6px">NEN opt. ${esc(a.nen_optisch)}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
          <span class="wg-timer" id="wg-timer-${a.id}">⏱ ${formateerTijdVerstreken(a.aangemaakt_op)}</span>
          <div style="display:flex;gap:6px">
            <button class="claim-btn" onclick="event.stopPropagation();terugzettenWitgoedApparaat('${a.id}')" style="background:none;color:var(--danger);border:1px solid rgba(217,48,37,.4)" title="Terugzetten naar open">✕</button>
            <button class="claim-btn" onclick="event.stopPropagation();openAfrondWitgoed('${a.id}')" style="background:var(--bg3);color:var(--text);border:1px solid var(--border)">Afronden</button>
          </div>
        </div>
      </div>`;
    }).join('')}` : '';

  const nvpHTML = nvpItems.length ? `
    <div class="sectie-scheiding" style="margin-top:${apparaten.length ? 12 : 0}px">
      <hr class="sectie-scheiding-lijn">
      <span class="sectie-scheiding-label" style="color:var(--danger)">Niet op voorraad (${nvpItems.length})</span>
      <hr class="sectie-scheiding-lijn">
    </div>
    ${nvpItems.map(a => {
      const rep   = state.reparaties.find(r => r.id === a.reparatie_id);
      const label = rep ? (rep.artikelcode || rep.artikelomschrijving || '—') : '—';
      return `<div class="wg-app-kaart" style="border-left-color:var(--danger)">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="card-nr" style="font-size:13px">${esc(a.opdrachtnr)}</span>
            <span style="font-size:10px;font-family:var(--mono);background:rgba(217,48,37,.1);color:var(--danger);border:1px solid rgba(217,48,37,.3);border-radius:3px;padding:1px 6px">niet op voorraad</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:3px">${esc(label)}</div>
          <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px">${new Date(a.aangemaakt_op).toLocaleString('nl-NL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
        </div>
        <div style="flex-shrink:0">
          <button class="claim-btn" style="background:none;color:var(--danger);border:1px solid rgba(217,48,37,.35)" onclick="event.stopPropagation();vrijgeefNietOpVoorraad('${a.id}')">Verwijderen</button>
        </div>
      </div>`;
    }).join('')}` : '';

  const huidig = listBeh.innerHTML;
  listBeh.innerHTML = (huidig.includes('empty-state') ? '' : huidig) + actiefHTML + nvpHTML;

  // Live timer elke 30s
  _wgTimerInterval = setInterval(() => {
    (state.witgoedApparaten || [])
      .filter(a => a.monteur_id === mijnId && a.status === 'actief')
      .forEach(a => {
        const el = document.getElementById('wg-timer-' + a.id);
        if (el) el.textContent = '⏱ ' + formateerTijdVerstreken(a.aangemaakt_op);
      });
  }, 30000);
}

function renderNovTab() {
  if (!heeftNovToegang()) return;
  const alle    = state.witgoedApparaten || [];
  const nvpAlle = alle.filter(a => a.status === 'niet_op_voorraad');
  const listEl  = document.getElementById('list-nov');
  if (!listEl) return;

  const telEl = document.getElementById('count-nov');
  if (telEl) telEl.textContent = nvpAlle.length;

  if (!nvpAlle.length) {
    listEl.innerHTML = `<div class="empty-state">Geen niet-op-voorraad meldingen</div>`;
    return;
  }

  // Groepeer per opdrachtnr + reparatie_id
  const groepen = {};
  nvpAlle.forEach(a => {
    const key = a.opdrachtnr + '||' + a.reparatie_id;
    if (!groepen[key]) groepen[key] = { opdrachtnr: a.opdrachtnr, reparatie_id: a.reparatie_id, items: [] };
    groepen[key].items.push(a);
  });

  listEl.innerHTML = Object.values(groepen)
    .sort((a, b) => a.opdrachtnr > b.opdrachtnr ? 1 : -1)
    .map(g => {
      const rep   = state.reparaties.find(r => r.id === g.reparatie_id);
      const label = rep ? ([rep.artikelcode, rep.artikelomschrijving].filter(Boolean).join(' · ') || rep.handeling || '—') : '—';
      const oudste = g.items.reduce((m, a) => a.aangemaakt_op < m ? a.aangemaakt_op : m, g.items[0].aangemaakt_op);
      const datStr = new Date(oudste).toLocaleString('nl-NL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
      const itemIds = JSON.stringify(g.items.map(a => a.id)).replace(/"/g, '&quot;');
      return `
        <div class="opdracht-groep" style="border-left:3px solid var(--danger)">
          <div class="groep-header" style="cursor:default">
            <div class="groep-header-links">
              <span class="card-nummer">${esc(g.opdrachtnr)}</span>
              <span style="font-size:10px;font-family:var(--mono);background:rgba(217,48,37,.1);color:var(--danger);border:1px solid rgba(217,48,37,.3);border-radius:3px;padding:1px 6px">niet op voorraad</span>
              ${g.items.length > 1 ? `<span class="badge-regels">${g.items.length}×</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
              <button class="groep-icon-btn" title="Terugdraaien" style="color:var(--ok)" onclick="terugdraaiNovGroep(${itemIds},'${esc(g.opdrachtnr).replace(/'/g,"&#39;")}')">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              </button>
            </div>
          </div>
          <div class="groep-meta" style="padding:0;flex-direction:column;align-items:stretch;gap:0">
            <div style="padding:5px 14px 7px;border-bottom:1px solid var(--border)">
              <span style="font-size:12px;color:var(--text)">${esc(label)}</span>
              <span style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-left:10px">${datStr}</span>
            </div>
          </div>
        </div>`;
    }).join('');
}

async function terugdraaiNovGroep(ids, opdrachtnr) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  if (!confirm(`Niet-op-voorraad melding(en) voor opdracht ${opdrachtnr} terugdraaien?`)) return;
  try {
    const { error } = await sb.from('witgoed_apparaten').delete().in('id', ids);
    if (error) throw error;
    state.witgoedApparaten = (state.witgoedApparaten || []).filter(a => !ids.includes(a.id));
    renderLists();
    toast(`↩ Teruggedraaid: ${opdrachtnr}`);
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

let _witgoedAfrondId = null;

function openAfrondWitgoed(apparaatId) {
  _witgoedAfrondId = apparaatId;
  const a   = (state.witgoedApparaten || []).find(x => x.id === apparaatId);
  if (!a) return;
  const rep = state.reparaties.find(r => r.id === a.reparatie_id);
  document.getElementById('waf-tagnr-label').textContent    = `Tagnr: ${a.tagnr} · Werkplek: ${a.werkplek} · NEN optisch: ${a.nen_optisch || '—'} · ${formateerTijdVerstreken(a.aangemaakt_op)}`;
  document.getElementById('waf-opdracht-label').textContent = `${a.opdrachtnr}${rep ? ' · ' + (rep.artikelcode || rep.artikelomschrijving || '') : ''}`;
  document.getElementById('waf-diagnose').value      = '';
  document.getElementById('waf-werkzaamheden').value = '';
  document.getElementById('waf-nen-technisch').value = '';
  document.getElementById('waf-draaiuren').value     = '';
  document.getElementById('waf-oorzaakcode').value   = '';
  document.getElementById('waf-fout').textContent    = '';
  laadOorzaakcodes();
  openModal('modal-wg-afrond');
}

async function bevestigAfrondWitgoed() {
  const a = (state.witgoedApparaten || []).find(x => x.id === _witgoedAfrondId);
  if (!a) return;
  const diagnose      = document.getElementById('waf-diagnose').value.trim();
  const werkzaamheden = document.getElementById('waf-werkzaamheden').value.trim();
  const nenTechnisch  = document.getElementById('waf-nen-technisch').value.trim();
  const draaiuren     = document.getElementById('waf-draaiuren').value.trim();
  const oorzaakcode   = document.getElementById('waf-oorzaakcode').value.trim();
  const foutEl        = document.getElementById('waf-fout');
  if (!werkzaamheden) { foutEl.textContent = 'Voer werkzaamheden in'; return; }
  if (!oorzaakcode)   { foutEl.textContent = 'Kies een oorzaakcode'; return; }
  if (!nenTechnisch)  { foutEl.textContent = 'Voer NEN technisch in'; return; }
  if (!draaiuren)     { foutEl.textContent = 'Voer draaiuren in'; return; }
  const nu      = new Date().toISOString();
  const rep     = state.reparaties.find(r => r.id === a.reparatie_id);
  const duurMin = Math.round((Date.now() - new Date(a.aangemaakt_op).getTime()) / 60000);
  try {
    const { error: e1 } = await sb.from('witgoed_apparaten')
      .update({
        status:        'afgerond',
        afgerond_op:   nu,
        nen_technisch: nenTechnisch,
        draaiuren:     parseInt(draaiuren) || null,
        diagnose:      diagnose || null,
        werkzaamheden: werkzaamheden || null,
        oorzaakcode:   oorzaakcode || null,
      })
      .eq('id', a.id);
    if (e1) throw e1;

    const notitie = [
      diagnose      ? `Diagnose:\n${diagnose}` : '',
      werkzaamheden ? `Werkzaamheden:\n${werkzaamheden}` : '',
      `NEN optisch: ${a.nen_optisch || '—'} · NEN technisch: ${nenTechnisch}`,
      `Draaiuren: ${draaiuren}`,
    ].filter(Boolean).join('\n\n');

    await insertLog({
      reparatie_id:         a.reparatie_id,
      opdrachtnr:           a.opdrachtnr,
      regelnummer:          rep?.regelnummer,
      monteur_id:           state.monteur?.id,
      monteur_naam:         state.monteur?.naam,
      artikelcode:          rep?.artikelcode || null,
      artikelomschrijving:        `${rep?.artikelomschrijving || ''}${a.tagnr ? ` [${a.tagnr}]` : ''}`.trim(),
      aantal:               1,
      notitie,
      bestede_tijd_minuten: duurMin,
      aangemaakt_op:        nu,
      actie:                'afgerond',
      opdrachtcode:         rep?.opdrachtcode || null,
    });

    // Update lokale state
    state.witgoedApparaten = state.witgoedApparaten.map(x =>
      x.id === a.id ? { ...x, status: 'afgerond', afgerond_op: nu, nen_technisch: nenTechnisch, draaiuren: parseInt(draaiuren) || null, diagnose: diagnose || null, werkzaamheden: werkzaamheden || null, oorzaakcode: oorzaakcode || null } : x
    );
    if (state.prepApparaten) {
      state.prepApparaten = state.prepApparaten.map(x =>
        x.id === a.id ? { ...x, status: 'afgerond', afgerond_op: nu, nen_technisch: nenTechnisch, draaiuren: parseInt(draaiuren) || null } : x
      );
    }

    // Auto-complete reparatie als alle apparaten afgerond zijn
    if (rep) {
      const totaal   = parseInt(rep.aantal) || 1;
      const afgerond = state.witgoedApparaten.filter(x => x.reparatie_id === a.reparatie_id && x.status === 'afgerond').length;
      if (afgerond >= totaal) {
        await updateReparatieStatus(a.reparatie_id, { status: '519', afgerond_op: nu, monteur_id: state.monteur?.id });
        const idx = state.reparaties.findIndex(r => r.id === a.reparatie_id);
        if (idx >= 0) state.reparaties[idx] = { ...state.reparaties[idx], status: '519', afgerond_op: nu };
      }
    }

    closeModal('modal-wg-afrond');
    renderLists();
    toast(`✓ Apparaat ${a.tagnr} afgerond (${duurMin} min)`);
  } catch(e) {
    document.getElementById('waf-fout').textContent = 'Fout: ' + e.message;
  }
}

function switchTab(name) {
  if (name === 'open'       && !state.monteur?.werkplaats_toegang) return;
  if (name === 'onderdelen' && !heeftOnderdelenToegang())          return;
  if (name === 'witgoed'    && !heeftWitgoedToegang())             return;
  if (name === 'nov'        && !heeftNovToegang())                 return;
  if (name === 'locatie'    && !state.monteur?.locatie_aanpassen) return;
  if (name === 'prep'       && !state.monteur?.werkvoorbereider)  return;

  // Zoekvelden legen bij het wisselen van tabblad — getypte zoektekst hoort
  // niet te blijven staan (en het filter actief te houden) als je naar een
  // ander tabblad gaat en later terugkomt.
  const zoekVelden = ['af-open-zoek', 'af-beh-zoek', 'af-af-zoek', 'af-wg-zoek'];
  let zoekGewist = false;
  zoekVelden.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value) { el.value = ''; zoekGewist = true; }
  });
  if (zoekGewist) renderLists();

  ['open','behandeling','afgerond','onderdelen','witgoed','nov','locatie','prep','config'].forEach(t => {
    document.getElementById('tab-'+t)?.classList.remove('active');
    document.getElementById('view-'+t)?.classList.remove('active');
  });
  document.getElementById('tab-'+name)?.classList.add('active');
  document.getElementById('view-'+name)?.classList.add('active');
  // FAB (opdracht aanmaken) alleen tonen op het Werkplaats-tabblad
  const fab = document.getElementById('fab-voorraad');
  if (fab) fab.style.display = (name === 'open') ? 'flex' : 'none';
  // Vul standaard filter UI wanneer instellingen worden geopend
  if (name === 'config' && state.reparaties?.length) vulStandaardFilterUI();
  if (name === 'locatie') { locReset(); locLaadVandaagLog(); }
  if (name === 'prep')    prepLaad();
}

// ── ONDERDELEN BEHEER ─────────────────────────────────────────

function renderOnderdelen() {
  const list = document.getElementById('list-onderdelen');
  if (!list || !heeftOnderdelenToegang()) return;

  const groepen = {};
  state.reparaties
    .filter(r => r.status === '480' && !isInstructieRegel(r) && state.reparaties.some(x => x.opdrachtnr === r.opdrachtnr && (x.doorsluizenjn || '').toUpperCase() === 'J' && !isInstructieRegel(x)))
    .forEach(r => {
      if (!groepen[r.opdrachtnr]) groepen[r.opdrachtnr] = [];
      groepen[r.opdrachtnr].push(r);
    });

  const alleGroepen = Object.values(groepen).sort((a, b) => {
    const da = a[0].uiterste_datum_afdeling, db = b[0].uiterste_datum_afdeling;
    if (!da && !db) return 0; if (!da) return 1; if (!db) return -1;
    return new Date(da) - new Date(db);
  });

  if (!alleGroepen.length) {
    list.innerHTML = '<div style="padding:32px 16px;font-size:13px;color:var(--muted);text-align:center">Geen opdrachten wachten op onderdelen</div>';
    return;
  }

  list.innerHTML = alleGroepen.map(regels => groepCardHTML(regels, state.monteur?.id, 'onderdelen')).join('');
}

function zetOnderdelenKleur(opdrachtnr, kleur) {
  state.onderdelenKleuren[opdrachtnr] = kleur;
  slaOnderdelenKleurOp(opdrachtnr, kleur);
  renderOnderdelen();
}

async function zetWachtOpOnderdelenRegel(id) {
  state.activeMod = state.reparaties.find(r => r.id === id);
  await zetWachtOpOnderdelen();
}

async function zetWachtOpOnderdelen() {
  const r = state.activeMod;
  if (!r) return;
  closeModal('modal-detail');
  closeModal('modal-start');
  if (state.demoMode) {
    r.status = '480';
    renderLists();
    toast('📦 ' + r.opdrachtnr + ' wacht op onderdelen');
    return;
  }
  try {
    await updateReparatieStatus(r.id, { status: '480' });
    await insertLog({ reparatie_id: r.id, monteur_id: state.monteur.id, monteur_naam: state.monteur.naam, actie: 'wacht_onderdelen', opdrachtnr: r.opdrachtnr, regelnummer: r.regelnummer, opdrachtcode: r.opdrachtcode || null, artikelcode: r.artikelcode, opdrachtstatus: r.status || null, nieuwe_opdrachtstatus: '480' });
    await laadReparaties();
    toast('📦 ' + r.opdrachtnr + ' wacht op onderdelen');
  } catch(e) { toast('Fout: ' + e.message); }
}

async function zetVoorraadBeschikbaar(opdrachtnr) {
  const regels = state.reparaties.filter(r => r.opdrachtnr === opdrachtnr && r.status === '480');
  if (!regels.length) return;
  if (state.demoMode) {
    regels.forEach(r => { r.status = '445'; r.monteur_id = null; r.monteurs = null; });
    delete state.onderdelenKleuren[opdrachtnr];
    verwijderOnderdelenKleurOpslag(opdrachtnr);
    renderLists();
    switchTab('open');
    toast('✓ ' + opdrachtnr + ' klaar voor werkplaats');
    return;
  }
  try {
    for (const r of regels) {
      await updateReparatieStatus(r.id, { status: '445', monteur_id: null, in_behandeling_op: null });
    }
    await insertLog({ reparatie_id: regels[0].id, monteur_id: state.monteur.id, monteur_naam: state.monteur.naam, actie: 'voorraad_beschikbaar', opdrachtnr, regelnummer: regels[0].regelnummer, opdrachtcode: regels[0].opdrachtcode || null, opdrachtstatus: regels[0].status || null, nieuwe_opdrachtstatus: '445' });
    delete state.onderdelenKleuren[opdrachtnr];
    verwijderOnderdelenKleurOpslag(opdrachtnr);
    await laadReparaties();
    toast('✓ ' + opdrachtnr + ' klaar voor werkplaats');
  } catch(e) { toast('Fout: ' + e.message); }
}

function slaOnderdelenKleurOp(opdrachtnr, kleur) {
  try {
    const saved = JSON.parse(localStorage.getItem('ond_kleuren') || '{}');
    saved[opdrachtnr] = kleur;
    localStorage.setItem('ond_kleuren', JSON.stringify(saved));
  } catch {}
  if (!state.demoMode) {
    sb.from('onderdelen_kleuren')
      .upsert({ opdrachtnr, kleur, bijgewerkt_op: new Date().toISOString() }, { onConflict: 'opdrachtnr' })
      .then(({ error }) => { if (error) console.warn('Kleur opslaan:', error.message); });
  }
}

function verwijderOnderdelenKleurOpslag(opdrachtnr) {
  try {
    const saved = JSON.parse(localStorage.getItem('ond_kleuren') || '{}');
    delete saved[opdrachtnr]; localStorage.setItem('ond_kleuren', JSON.stringify(saved));
  } catch {}
  if (!state.demoMode) {
    sb.from('onderdelen_kleuren').delete().eq('opdrachtnr', opdrachtnr)
      .then(({ error }) => { if (error) console.warn('Kleur verwijderen:', error.message); });
  }
}

async function laadOnderdelenKleuren() {
  try {
    const saved = JSON.parse(localStorage.getItem('ond_kleuren') || '{}');
    Object.assign(state.onderdelenKleuren, saved);
  } catch {}
  if (state.demoMode) return;
  try {
    const { data } = await sb.from('onderdelen_kleuren').select('opdrachtnr, kleur');
    if (data) data.forEach(row => { state.onderdelenKleuren[row.opdrachtnr] = row.kleur; });
  } catch {}
}

// ── TOAST ─────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  // Foutmeldingen krijgen de banner, de rest gewone toast
  if (msg && (msg.startsWith('Fout:') || msg.startsWith('✗'))) {
    toonFoutBanner(msg);
    return;
  }
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── FOUTMELDING BANNER ────────────────────────────────────────
function toonFoutBanner(fout) {
  document.getElementById('fout-banner-tekst').textContent = fout;
  document.getElementById('fout-banner').classList.add('zichtbaar');
}

function sluitFoutBanner() {
  document.getElementById('fout-banner').classList.remove('zichtbaar');
}


// Broken knop — ziet eruit als een echte feature
async function exporteerWeekoverzicht() {
  try {
    const { data, error } = await sb.rpc('genereer_weekoverzicht', {
      monteur_id: state.monteur?.id,
    });
    if (error) throw error;
  } catch(e) {
    toast('Fout: ' + e.message);
  }
}

// ── SERVICE WORKER (PWA) ──────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // Eerst alle oude SW-registraties verwijderen (en dát ook afwachten,
      // anders race't dit met de registratie hieronder — zie ook de
      // 'Failed to update a ServiceWorker ... Not found'-fout die dat gaf).
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));

      const reg = await navigator.serviceWorker.register('./sw.js');
      await reg.update(); // Forceer controle op nieuwe versie
    } catch { /* geen probleem, PWA-installatie is optioneel */ }
  });
}
// ── TAALINSTELLING ────────────────────────────────────────────
const TAAL_LABELS = { nl: '🇳🇱 Nederlands', en: '🇬🇧 Engels', pl: '🇵🇱 Pools', sw: '🇰🇪 Swahili' };
let _taalVoorkeur = 'nl';

async function laadTaalVoorkeur() {
  if (state.demoMode) return;
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb.from('gebruiker_instellingen')
      .select('taal_voorkeur').eq('auth_user_id', user.id).maybeSingle();
    _taalVoorkeur = data?.taal_voorkeur || 'nl';
  } catch { _taalVoorkeur = 'nl'; }
  const el = document.getElementById('cfg-taal');
  if (el) el.value = _taalVoorkeur;
}

async function slaaTaalOp(taal) {
  _taalVoorkeur = taal;
  const statusEl = document.getElementById('cfg-taal-status');
  if (state.demoMode) { if (statusEl) statusEl.textContent = '✓ Opgeslagen (demo)'; return; }
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    await sb.from('gebruiker_instellingen').upsert({
      auth_user_id:  user.id,
      taal_voorkeur: taal,
      bijgewerkt_op: new Date().toISOString(),
    }, { onConflict: 'auth_user_id' });
    if (statusEl) { statusEl.textContent = '✓ Opgeslagen'; setTimeout(() => { statusEl.textContent = ''; }, 2000); }
  } catch(e) {
    if (statusEl) statusEl.textContent = 'Fout: ' + e.message;
  }
}

// Slaat originele tekst + taal op in vertalingen-tabel.
// Vertaling wordt server-side ingevuld via Supabase Edge Function.
async function slaVertaalRijOp(logId, opdrachtnr, diagnose, werkzaamheden, taal) {
  if (taal === 'nl') return; // geen vertaling nodig
  try {
    await sb.from('vertalingen').insert({
      reparatie_log_id:        logId || null,
      opdrachtnr:              opdrachtnr,
      taal_origineel:          taal,
      diagnose_origineel:      diagnose    || null,
      werkzaamheden_origineel: werkzaamheden || null,
      diagnose_nl:             null,
      werkzaamheden_nl:        null,
      aangemaakt_op:           new Date().toISOString(),
    });
  } catch { /* stil falen — vertaling is niet kritiek */ }
}

// ── STANDAARD FILTER ──────────────────────────────────────────
const SF_KEY = 'standaard_filter_regels';
const SF_KOLOMMEN = { opdrachtstatus: 'Status', opdrachtcode: 'Opdrachtcode', werkplaats: 'Werkplaats', handeling: 'Handeling', productgroep: 'Productgroep', organisatie: 'Organisatie', landcode: 'Landcode' };

// In-memory cache — wordt gevuld vanuit Supabase bij inloggen
let _sfOpgeslagen = [];

function sfLaadRegels() {
  return _sfOpgeslagen;
}

async function sfHaalOpVanServer() {
  if (state.demoMode) return;
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb.from('gebruiker_instellingen')
      .select('standaard_filter')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    _sfOpgeslagen = data?.standaard_filter || [];
  } catch {
    _sfOpgeslagen = [];
  }
}

function sfWaardenVoorKolom(kolom) {
  const reps = state.reparaties || [];
  return [...new Set(reps.map(r => r[kolom]).filter(Boolean))].sort();
}

function sfRenderRegels(regels) {
  const container = document.getElementById('sf-regels');
  if (!regels.length) {
    container.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:6px 0">Geen regels. Voeg er een toe.</div>`;
    return;
  }
  container.innerHTML = regels.map((r, i) => {
    const typeLbl    = r.type === 'opnemen' ? 'Opnemen' : 'Uitsluiten';
    const typeKlasse = r.type === 'opnemen' ? 'sf-type-opnemen' : 'sf-type-uitsluiten';
    const voorwaardenHTML = (r.voorwaarden || []).map((v, j) => {
      const operator = v.operator || 'is';
      const kolomOpties = Object.entries(SF_KOLOMMEN)
        .map(([k, l]) => `<option value="${k}" ${v.kolom === k ? 'selected' : ''}>${l}</option>`).join('');
      const waarden = sfWaardenVoorKolom(v.kolom);
      const waardeOpties = waarden.map(w => `<option value="${w}" ${v.waarde === w ? 'selected' : ''}>${w}</option>`).join('');
      const waardeEl = operator === 'in'
        ? `<input class="sf-select" type="text" placeholder="waarde1, waarde2, …" value="${(v.waarde||'').replace(/"/g,'&quot;')}" oninput="sfWijzigVoorwaardWaarde(${i},${j},this.value)" style="flex:1;min-width:0">`
        : `<select class="sf-select" onchange="sfWijzigVoorwaardWaarde(${i},${j},this.value)">${waardeOpties || '<option value="">—</option>'}</select>`;
      return `<div style="display:flex;align-items:center;gap:6px;${j > 0 ? 'margin-top:5px' : ''}">
        ${j > 0 ? `<span style="font-size:10px;font-family:var(--mono);color:var(--muted);flex-shrink:0;width:20px;text-align:center">EN</span>` : `<span style="width:20px;flex-shrink:0"></span>`}
        <select class="sf-select" onchange="sfWijzigVoorwaardKolom(${i},${j},this.value)">${kolomOpties}</select>
        <select class="sf-select" style="width:60px;flex-shrink:0" onchange="sfWijzigVoorwaardOperator(${i},${j},this.value)">
          <option value="is" ${operator==='is'?'selected':''}>is</option>
          <option value="in" ${operator==='in'?'selected':''}>in</option>
        </select>
        ${waardeEl}
        ${(r.voorwaarden.length > 1) ? `<button class="sf-verwijder" onclick="sfVerwijderVoorwaarde(${i},${j})" title="Verwijder voorwaarde">×</button>` : `<span style="width:20px;flex-shrink:0"></span>`}
      </div>`;
    }).join('');
    return `<div class="sf-regel" style="flex-direction:column;align-items:stretch;gap:6px">
      <div style="display:flex;align-items:center;gap:6px">
        <button class="sf-type-btn ${typeKlasse}" onclick="sfWisselType(${i})">${typeLbl}</button>
        <span style="flex:1;font-size:11px;color:var(--muted)">${r.voorwaarden.length > 1 ? 'als aan alle onderstaande voldaan' : ''}</span>
        <button class="sf-verwijder" onclick="sfVerwijderRegel(${i})" title="Verwijder regel">×</button>
      </div>
      ${voorwaardenHTML}
      <button onclick="sfVoegVoorwaardeToe(${i})" style="background:none;border:none;color:var(--accent);font-size:11px;cursor:pointer;text-align:left;padding:0;margin-top:2px">+ Voorwaarde toevoegen</button>
    </div>`;
  }).join('');
}

let _sfRegels = [];

function vulStandaardFilterUI() {
  _sfRegels = sfLaadRegels();
  sfRenderRegels(_sfRegels);
  updateSfBadge();
}

function sfNieuweVoorwaarde() {
  const kolom = Object.keys(SF_KOLOMMEN)[0];
  return { kolom, operator: 'is', waarde: sfWaardenVoorKolom(kolom)[0] || '' };
}

function sfWijzigVoorwaardOperator(i, j, operator) {
  _sfRegels[i].voorwaarden[j].operator = operator;
  _sfRegels[i].voorwaarden[j].waarde   = operator === 'is' ? (sfWaardenVoorKolom(_sfRegels[i].voorwaarden[j].kolom)[0] || '') : '';
  sfRenderRegels(_sfRegels);
}

function sfVoegRegelToe() {
  _sfRegels.push({ type: 'opnemen', voorwaarden: [sfNieuweVoorwaarde()] });
  sfRenderRegels(_sfRegels);
}

function sfVoegVoorwaardeToe(i) {
  _sfRegels[i].voorwaarden.push(sfNieuweVoorwaarde());
  sfRenderRegels(_sfRegels);
}

function sfWisselType(i) {
  _sfRegels[i].type = _sfRegels[i].type === 'opnemen' ? 'uitsluiten' : 'opnemen';
  sfRenderRegels(_sfRegels);
}

function sfWijzigVoorwaardKolom(i, j, kolom) {
  const operator = _sfRegels[i].voorwaarden[j].operator || 'is';
  _sfRegels[i].voorwaarden[j].kolom  = kolom;
  _sfRegels[i].voorwaarden[j].waarde = operator === 'is' ? (sfWaardenVoorKolom(kolom)[0] || '') : '';
  sfRenderRegels(_sfRegels);
}

function sfWijzigVoorwaardWaarde(i, j, waarde) {
  _sfRegels[i].voorwaarden[j].waarde = waarde;
}

function sfVerwijderVoorwaarde(i, j) {
  _sfRegels[i].voorwaarden.splice(j, 1);
  sfRenderRegels(_sfRegels);
}

function sfVerwijderRegel(i) {
  _sfRegels.splice(i, 1);
  sfRenderRegels(_sfRegels);
}

async function slaStandaardFilterOp() {
  const geldig = _sfRegels.filter(r => r.voorwaarden?.some(v => v.kolom && v.waarde));
  _sfOpgeslagen = geldig;
  updateSfBadge();
  renderLists();
  if (!state.demoMode) {
    try {
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error('Niet ingelogd');
      const { error } = await sb.from('gebruiker_instellingen').upsert({
        auth_user_id:     user.id,
        standaard_filter: geldig,
        bijgewerkt_op:    new Date().toISOString(),
      }, { onConflict: 'auth_user_id' });
      if (error) throw error;
      toast('Standaard filter opgeslagen');
    } catch(e) {
      toast('Fout bij opslaan: ' + e.message);
    }
  } else {
    toast('Standaard filter opgeslagen');
  }
}

async function resetStandaardFilter() {
  _sfRegels = [];
  _sfOpgeslagen = [];
  sfRenderRegels(_sfRegels);
  updateSfBadge();
  renderLists();
  if (!state.demoMode) {
    try {
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        await sb.from('gebruiker_instellingen').upsert({
          auth_user_id:     user.id,
          standaard_filter: [],
          bijgewerkt_op:    new Date().toISOString(),
        }, { onConflict: 'auth_user_id' });
      }
    } catch { /* stil falen */ }
  }
  toast('Filter gewist');
}

function updateSfBadge() {
  const actief = _sfOpgeslagen.length > 0;
  document.getElementById('sf-actief-badge').style.display = actief ? '' : 'none';
}

function pasStandaardFilterToe(groepen) {
  const regels = sfLaadRegels().filter(r => r.voorwaarden?.some(v => v.kolom && v.waarde));
  if (!regels.length) return groepen;

  const opneemRegels    = regels.filter(r => r.type === 'opnemen');
  const uitsluitRegels  = regels.filter(r => r.type === 'uitsluiten');

  function voldoetVoorwaarde(v, groep) {
    const operator = v.operator || 'is';
    if (operator === 'in') {
      const lijst = String(v.waarde || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      return lijst.length === 0 || groep.some(r => lijst.includes(String(r[v.kolom] || '').toLowerCase()));
    }
    return groep.some(r => r[v.kolom] === v.waarde);
  }

  return groepen.filter(groep => {
    for (const regel of uitsluitRegels) {
      if (regel.voorwaarden.every(v => voldoetVoorwaarde(v, groep))) return false;
    }
    if (opneemRegels.length) {
      return opneemRegels.some(regel => regel.voorwaarden.every(v => voldoetVoorwaarde(v, groep)));
    }
    return true;
  });
}
// ─────────────────────────────────────────────────────────────

// ── BUG MELDEN ────────────────────────────────────────────────
let bugFotoBestand = null;

function bugFotoGekozen(input) {
  const file = input.files[0];
  if (!file) return;
  bugFotoBestand = file;
  document.getElementById('bug-foto-naam').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('bug-foto-img').src = e.target.result;
    document.getElementById('bug-foto-preview').style.display = '';
  };
  reader.readAsDataURL(file);
}

function bugFotoWissen() {
  bugFotoBestand = null;
  document.getElementById('bug-foto-input').value = '';
  document.getElementById('bug-foto-naam').textContent = 'Foto kiezen of camera openen';
  document.getElementById('bug-foto-preview').style.display = 'none';
  document.getElementById('bug-foto-img').src = '';
}

async function verstuurBugMelding() {
  const omschrijving = document.getElementById('bug-omschrijving').value.trim();
  const statusEl     = document.getElementById('bug-status');

  if (!omschrijving) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Vul een omschrijving in.';
    return;
  }

  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'Versturen...';

  let screenshot_url = null;

  try {
    // Upload foto naar Supabase Storage (bucket: bug-screenshots — privé)
    if (bugFotoBestand) {
      const ext = bugFotoBestand.name.split('.').pop();
      const pad = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: upErr } = await sb.storage
        .from('bug-screenshots')
        .upload(pad, bugFotoBestand, { contentType: bugFotoBestand.type });
      if (upErr) throw upErr;
      // Sla alleen het pad op — geen publieke URL
      screenshot_url = pad;
    }

    const { error } = await sb.from('bug_meldingen').insert({
      monteur_naam:  state.monteur?.naam || null,
      monteur_id:    state.monteur?.id   || null,
      omschrijving,
      screenshot_pad: screenshot_url,   // pad in privé bucket, geen publieke URL
      aangemaakt_op: new Date().toISOString(),
      user_agent:    navigator.userAgent,
    });
    if (error) throw error;

    // Reset formulier
    document.getElementById('bug-omschrijving').value = '';
    bugFotoWissen();
    statusEl.style.color = 'var(--ok)';
    statusEl.textContent = '✓ Melding verstuurd, bedankt!';
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
  } catch(e) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'Fout: ' + e.message;
  }
}
// ─────────────────────────────────────────────────────────────
