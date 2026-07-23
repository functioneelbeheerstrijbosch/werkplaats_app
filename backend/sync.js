/**
 * sync.js — Periodieke sync van MSSQL (ERP) → MySQL (werkplaats app)
 *
 * Configuratie via .env:
 *   MSSQL_SERVER, MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD
 *   MSSQL_PORT          (default: 1433)
 *   MSSQL_ENCRYPT       (default: false — zet op 'true' voor Azure SQL)
 *   MSSQL_VIEW          (default: JVDV_Service_Bruingoed_Werkplaats_App)
 *   SYNC_INTERVAL_MS    (default: 300000 = 5 minuten)
 */

require('dotenv').config();
const sql = require('mssql');
const db  = require('./db');

const MSSQL_CONFIG = {
  server:   process.env.MSSQL_SERVER,
  database: process.env.MSSQL_DATABASE,
  user:     process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  port:     parseInt(process.env.MSSQL_PORT || '1433', 10),
  options: {
    encrypt:                process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: true,
  },
};

const MSSQL_VIEW = process.env.MSSQL_VIEW || 'JVDV_Service_Bruingoed_Werkplaats_App';
const SYNC_MS    = parseInt(process.env.SYNC_INTERVAL_MS || String(5 * 60 * 1000), 10);

// ── Kolom-mapping: MSSQL kolomnaam → MySQL kolomnaam ─────────────────────────
// Als de kolomnamen in MSSQL anders zijn, pas de linkerkant aan.
// Kolommen die hier NIET staan worden genegeerd.
const KOLOM_MAPPING = {
  opdrachtnr:               'opdrachtnr',
  opdrachtcode:             'opdrachtcode',
  opdrachtstatus:           'opdrachtstatus',
  abonneecode:              'abonneecode',
  betalercode:              'betalercode',
  handeling:                'handeling',
  soort:                    'soort',
  regelnummer:              'regelnummer',
  artikelcode:              'artikelcode',
  artikelomschrijving:      'artikelomschrijving',
  merk:                     'merk',
  model:                    'model',
  serienummer:              'serienummer',
  klant_naam:               'klant_naam',
  klant_nummer:             'klant_nummer',
  tagnummer:                'tagnummer',
  memogeschiedenis:         'memogeschiedenis',
  klacht:                   'klacht',
  diagnose:                 'diagnose',
  werkzaamheden:            'werkzaamheden',
  prioriteit:               'prioriteit',
  status:                   'status',
  aantal:                   'aantal',
  doorsluizenjn:            'doorsluizenjn',
  tagnrscannenjn:           'tagnrscannenjn',
  organisatie:              'organisatie',
  productgroep:             'productgroep',
  werkplaats:               'werkplaats',
  magazijnlocatie:          'magazijnlocatie',
  landcode:                 'landcode',
  postcode:                 'postcode',
  locatie:                  'locatie',
  reden_datum:              'reden_datum',
  uiterste_datum_afdeling:  'uiterste_datum_afdeling',
  bestede_minuten:          'bestede_minuten',
  uitkomst:                 'uitkomst',
  aangemaakt_op:            'aangemaakt_op',
};

// Deze velden worden bij een UPDATE nooit overschreven vanuit de ERP,
// omdat de werkplaats app ze zelf beheert.
const BESCHERMDE_VELDEN = new Set([
  'monteur_id', 'in_behandeling_op', 'afgerond_op', 'toegewezen_door',
  'status', 'diagnose',
]);

// ── Hulpfuncties ──────────────────────────────────────────────────────────────

function normaliseerDatum(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 19).replace('T', ' ');
    if (/^\d{4}-\d{2}-\d{2}$/.test(v))  return v;
    if (/^\d{8}$/.test(v)) return `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`;
  }
  return null;
}

function normaliseerDoorsluizen(v) {
  if (v === true || v === 1 || v === 'J' || v === 'j' || v === '1' || v === 'true') return 'J';
  return 'N';
}

function bouwMysqlRij(mssqlRij) {
  const rij = {};
  for (const [van, naar] of Object.entries(KOLOM_MAPPING)) {
    if (mssqlRij[van] !== undefined) rij[naar] = mssqlRij[van];
  }

  if (rij.doorsluizenjn !== undefined) rij.doorsluizenjn = normaliseerDoorsluizen(rij.doorsluizenjn);
  if (rij.aangemaakt_op)               rij.aangemaakt_op = normaliseerDatum(rij.aangemaakt_op);
  if (rij.status !== undefined)        rij.status        = String(rij.status);

  return rij;
}

// ── Hoofd sync-functie ────────────────────────────────────────────────────────

let eersteKeer = true;

async function syncReparaties(pool) {
  const result = await pool.request().query(`SELECT * FROM [${MSSQL_VIEW}]`);
  const rijen  = result.recordset;

  // Druk kolommen af bij de eerste sync zodat je de mapping kunt controleren
  if (eersteKeer && rijen.length > 0) {
    eersteKeer = false;
    console.log('[SYNC] MSSQL kolomnamen:', Object.keys(rijen[0]).join(', '));
    console.log('[SYNC] Pas KOLOM_MAPPING in sync.js aan als kolomnamen afwijken.');
  }

  console.log(`[SYNC] ${rijen.length} rijen gelezen`);
  let nieuw = 0, bijgewerkt = 0, fouten = 0;

  for (const mssqlRij of rijen) {
    try {
      const rij = bouwMysqlRij(mssqlRij);
      if (!rij.opdrachtnr) continue;

      const [bestaand] = await db.query(
        'SELECT id FROM reparaties WHERE opdrachtnr = ? AND regelnummer = ?',
        [rij.opdrachtnr, rij.regelnummer ?? 1]
      );

      if (bestaand.length > 0) {
        // Update: alleen ERP-velden, nooit beschermde werkplaats-velden
        const updateRij = Object.fromEntries(
          Object.entries(rij).filter(([k]) => !BESCHERMDE_VELDEN.has(k) && k !== 'opdrachtnr' && k !== 'regelnummer')
        );
        const setCols = Object.keys(updateRij).map(c => `\`${c}\` = ?`).join(', ');
        if (setCols) {
          await db.query(
            `UPDATE reparaties SET ${setCols} WHERE opdrachtnr = ? AND regelnummer = ?`,
            [...Object.values(updateRij), rij.opdrachtnr, rij.regelnummer ?? 1]
          );
        }
        bijgewerkt++;
      } else {
        // Nieuwe rij invoegen
        const kolommen     = Object.keys(rij).map(c => `\`${c}\``).join(', ');
        const placeholders = Object.keys(rij).map(() => '?').join(', ');
        await db.query(
          `INSERT INTO reparaties (${kolommen}) VALUES (${placeholders})`,
          Object.values(rij)
        );
        nieuw++;
      }
    } catch (err) {
      console.error(`[SYNC] Fout bij ${mssqlRij.opdrachtnr}/${mssqlRij.regelnummer}:`, err.message);
      fouten++;
    }
  }

  console.log(`[SYNC] Klaar: ${nieuw} nieuw, ${bijgewerkt} bijgewerkt, ${fouten} fouten`);
}

async function eenSync() {
  let pool;
  try {
    console.log(`[SYNC] Verbinden met ${MSSQL_CONFIG.server}/${MSSQL_CONFIG.database}...`);
    pool = await sql.connect(MSSQL_CONFIG);
    await syncReparaties(pool);
  } catch (err) {
    console.error('[SYNC] Verbindingsfout:', err.message);
  } finally {
    try { if (pool) await pool.close(); } catch { /* genegeerd */ }
  }
}

function startSync() {
  if (process.env.SYNC_ENABLED === 'false') {
    console.warn('[SYNC] Uitgeschakeld via SYNC_ENABLED=false in .env — geen MSSQL- of API-sync gestart.');
    return;
  }

  if (!MSSQL_CONFIG.server || !MSSQL_CONFIG.database) {
    console.warn('[SYNC] MSSQL_SERVER of MSSQL_DATABASE niet ingesteld — sync uitgeschakeld.');
  } else {
    console.log(`[SYNC] Gestart, interval: ${SYNC_MS / 1000}s, bron: ${MSSQL_VIEW}`);
    eenSync();
    setInterval(eenSync, SYNC_MS);
  }

  // Strijbosch REST API sync altijd starten als URL en key aanwezig zijn
  startApiSync();
}

// ── Strijbosch REST API → MySQL (reparaties) ─────────────────────────────────

const API_URL     = process.env.STRIJBOSCH_API_URL;
const API_KEY     = process.env.STRIJBOSCH_API_KEY;
const API_SYNC_MS = parseInt(process.env.STRIJBOSCH_SYNC_MS || '300000', 10);

const API_KOLOM_MAPPING = {
  opdrachtnr:              'opdrachtnr',
  opdrachtcode:            'opdrachtcode',
  opdrachtstatus:          'opdrachtstatus',
  betalercode:             'betalercode',
  abonneecode:             'abonneecode',
  regelnummer:             'regelnummer',
  tagnummer:               'tagnummer',
  artikelcode:             'artikelcode',
  omschrijving1:           'artikelomschrijving',
  merk:                    'merk',
  productgroep:            'productgroep',
  aantal:                  'aantal',
  melddatum:               'aangemaakt_op',
  doorsluizenjn:           'doorsluizenjn',
  organisatie:             'organisatie',
  landcode:                'landcode',
  memogeschiedenis:        'memogeschiedenis',
  opmerking:               'klacht',
  magazijnlocatie:         'magazijnlocatie',
  reden_datum:             'reden_datum',
  uiterste_datum_afdeling: 'uiterste_datum_afdeling',
  handeling:               'handeling',
  werkplaats:              'werkplaats',
  postcode:                'postcode',
  tagnrscannenjn:          'tagnrscannenjn',
};

function bouwApiRij(apiRij) {
  const genorm = Object.fromEntries(Object.entries(apiRij).map(([k, v]) => [k.toLowerCase(), v]));
  const rij = {};
  for (const [van, naar] of Object.entries(API_KOLOM_MAPPING)) {
    if (genorm[van] !== undefined) rij[naar] = genorm[van];
  }
  if (rij.doorsluizenjn !== undefined) rij.doorsluizenjn = normaliseerDoorsluizen(rij.doorsluizenjn);
  for (const k of ['aangemaakt_op', 'reden_datum', 'uiterste_datum_afdeling']) {
    if (rij[k]) rij[k] = normaliseerDatum(rij[k]);
  }
  return rij;
}

async function syncVanApi() {
  if (!API_URL || !API_KEY) return;

  try {
    const url = `${API_URL}?apikey=${API_KEY}`;
    console.log('[API] Data ophalen van', API_URL);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Strijbosch-Werkplaats/1.0', 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text().catch(() => '')}`);

    const apiRijen = await res.json();
    if (!Array.isArray(apiRijen) || apiRijen.length === 0) {
      console.log('[API] Geen rijen ontvangen');
      return;
    }

    console.log(`[API] ${apiRijen.length} rijen ontvangen`);
    let nieuw = 0, bijgewerkt = 0, fouten = 0;

    for (const apiRij of apiRijen) {
      try {
        const rij = bouwApiRij(apiRij);
        if (!rij.opdrachtnr) continue;

        const [bestaand] = await db.query(
          'SELECT id FROM reparaties WHERE opdrachtnr = ? AND regelnummer = ?',
          [rij.opdrachtnr, rij.regelnummer ?? 1]
        );

        if (bestaand.length > 0) {
          const updateRij = Object.fromEntries(
            Object.entries(rij).filter(([k]) => !BESCHERMDE_VELDEN.has(k) && k !== 'opdrachtnr' && k !== 'regelnummer')
          );
          const setCols = Object.keys(updateRij).map(c => `\`${c}\` = ?`).join(', ');
          if (setCols) {
            await db.query(
              `UPDATE reparaties SET ${setCols} WHERE opdrachtnr = ? AND regelnummer = ?`,
              [...Object.values(updateRij), rij.opdrachtnr, rij.regelnummer ?? 1]
            );
          }
          bijgewerkt++;
        } else {
          const kolommen     = Object.keys(rij).map(c => `\`${c}\``).join(', ');
          const placeholders = Object.keys(rij).map(() => '?').join(', ');
          await db.query(
            `INSERT INTO reparaties (${kolommen}) VALUES (${placeholders})`,
            Object.values(rij)
          );
          nieuw++;
        }
      } catch (err) {
        console.error('[API] Rij fout:', err.message);
        fouten++;
      }
    }

    console.log(`[API] Klaar: ${nieuw} nieuw, ${bijgewerkt} bijgewerkt, ${fouten} fouten`);
  } catch (err) {
    console.error('[API] Fout:', err.message);
  }
}

function startApiSync() {
  if (!API_URL || !API_KEY) {
    console.warn('[API] STRIJBOSCH_API_URL of STRIJBOSCH_API_KEY niet ingesteld — API sync uitgeschakeld.');
    return;
  }
  console.log(`[API] Gestart, interval: ${API_SYNC_MS / 1000}s`);
  syncVanApi();
  setInterval(syncVanApi, API_SYNC_MS);
}

module.exports = { startSync, eenSync, syncVanApi };
