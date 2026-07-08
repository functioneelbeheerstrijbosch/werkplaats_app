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
// Als de kolomnamen in MSSQL anders zijn, pas dit object aan.
// Kolommen die hier NIET staan worden genegeerd.
const KOLOM_MAPPING = {
  opdrachtnr:          'opdrachtnr',
  opdrachtcode:        'opdrachtcode',
  opdrachtstatus:      'opdrachtstatus',
  artikelcode:         'artikelcode',
  artikelomschrijving: 'artikelomschrijving',
  merk:                'merk',
  model:               'model',
  serienummer:         'serienummer',
  klant_naam:          'klant_naam',
  klant_nummer:        'klant_nummer',
  prioriteit:          'prioriteit',
  status:              'status',
  klacht:              'klacht',
  doorsluizenjn:       'doorsluizenjn',
  aangemaakt_op:       'aangemaakt_op',
};

// Deze velden worden bij een UPDATE nooit overschreven vanuit de ERP,
// omdat de werkplaats app ze zelf beheert.
const BESCHERMDE_VELDEN = new Set([
  'monteur_id', 'in_behandeling_op', 'afgerond_op', 'toegewezen_door',
]);

// ── Hulpfuncties ──────────────────────────────────────────────────────────────

function normaliseerDatum(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    return v.slice(0, 19).replace('T', ' ');
  }
  return v;
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
        'SELECT id FROM reparaties WHERE opdrachtnr = ? AND artikelcode = ?',
        [rij.opdrachtnr, rij.artikelcode ?? null]
      );

      if (bestaand.length > 0) {
        // Update: alleen ERP-velden, nooit beschermde werkplaats-velden
        const updateRij = Object.fromEntries(
          Object.entries(rij).filter(([k]) => !BESCHERMDE_VELDEN.has(k) && k !== 'opdrachtnr')
        );
        const setCols = Object.keys(updateRij).map(c => `\`${c}\` = ?`).join(', ');
        if (setCols) {
          await db.query(
            `UPDATE reparaties SET ${setCols} WHERE opdrachtnr = ? AND artikelcode = ?`,
            [...Object.values(updateRij), rij.opdrachtnr, rij.artikelcode ?? null]
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
      console.error(`[SYNC] Fout bij opdrachtnr ${mssqlRij.opdrachtnr}:`, err.message);
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
  if (!MSSQL_CONFIG.server || !MSSQL_CONFIG.database) {
    console.warn('[SYNC] MSSQL_SERVER of MSSQL_DATABASE niet ingesteld — sync uitgeschakeld.');
    return;
  }

  console.log(`[SYNC] Gestart, interval: ${SYNC_MS / 1000}s, bron: ${MSSQL_VIEW}`);
  eenSync();
  setInterval(eenSync, SYNC_MS);
}

module.exports = { startSync, eenSync };
