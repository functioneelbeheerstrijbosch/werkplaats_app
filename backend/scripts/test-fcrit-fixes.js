// Geïsoleerde, niet-destructieve regressietest voor F-CRIT-01 en F-CRIT-02
// (zie internal-docs/onafhankelijke-security-audit-2026-09-09.md).
//
// Draait NOOIT tegen de echte (test- of productie-)database — `../db`
// wordt hieronder vervangen door een in-memory nepmodule vóórdat
// routes/api.js wordt ingeladen, dus er wordt geen enkele echte SQL-query
// uitgevoerd. authMiddleware wordt bewust niet gemount: dit test alleen de
// autorisatie-/validatielogica die ín routes/api.js zelf zit (de twee
// fixes), niet de JWT-laag (die is elders al gedekt).
//
// Uitvoeren: node scripts/test-fcrit-fixes.js  (of: npm run test:fcrit)

const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const DB_PAD       = path.join(BACKEND_DIR, 'db.js');

// ── Nep-db: logt elke aanroep, voert nooit echt iets uit ───────────────────
const uitgevoerdeQueries = [];
const fakeDb = {
  query: async (sql, params) => {
    uitgevoerdeQueries.push({ sql, params });
    // Generieke fallback-respons: lege resultset (voldoende voor deze tests,
    // die alleen willen aantonen dát/dat-niet een query wordt gestart).
    return [[]];
  },
};

require.cache[require.resolve(DB_PAD)] = {
  id: DB_PAD,
  filename: DB_PAD,
  loaded: true,
  exports: fakeDb,
};

const express   = require('express');
const apiRoutes = require(path.join(BACKEND_DIR, 'routes', 'api.js'));

const app = express();
app.use(express.json());
app.use('/api', apiRoutes); // bewust ZONDER authMiddleware — zie uitleg boven

let server;

function queriesSinds(n) {
  return uitgevoerdeQueries.slice(n);
}

async function run() {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let pass = 0, fail = 0;
  const check = (naam, conditie, detail) => {
    if (conditie) { pass++; console.log(`✅ ${naam}`); }
    else { fail++; console.log(`❌ ${naam}${detail ? ' — ' + detail : ''}`); }
  };

  // ── F-CRIT-01a: PATCH /api/monteurs mag is_admin niet zetten ────────────
  {
    const voor = uitgevoerdeQueries.length;
    const res = await fetch(`${baseUrl}/api/monteurs?eq_id=1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: 1 }),
    });
    const body = await res.json();
    check('F-CRIT-01a: PATCH monteurs {is_admin:1} → 403', res.status === 403, `status=${res.status} body=${JSON.stringify(body)}`);
    check('F-CRIT-01a: geen UPDATE-query uitgevoerd', queriesSinds(voor).length === 0, JSON.stringify(queriesSinds(voor)));
  }

  // ── F-CRIT-01b: PATCH /api/monteurs mag wachtwoord_hash niet zetten ─────
  {
    const voor = uitgevoerdeQueries.length;
    const res = await fetch(`${baseUrl}/api/monteurs?eq_id=2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wachtwoord_hash: '$2b$12$aanvallerHash' }),
    });
    const body = await res.json();
    check('F-CRIT-01b: PATCH monteurs {wachtwoord_hash:...} → 403', res.status === 403, `status=${res.status} body=${JSON.stringify(body)}`);
    check('F-CRIT-01b: geen UPDATE-query uitgevoerd', queriesSinds(voor).length === 0, JSON.stringify(queriesSinds(voor)));
  }

  // ── F-CRIT-01c: PATCH /api/monteurs met een normaal, toegestaan veld werkt nog ──
  {
    const voor = uitgevoerdeQueries.length;
    const res = await fetch(`${baseUrl}/api/monteurs?eq_id=3`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ naam: 'Jan Jansen' }),
    });
    const body = await res.json();
    check('F-CRIT-01c: PATCH monteurs {naam:...} (onschadelijk veld) → 200 (geen regressie)', res.status === 200, `status=${res.status} body=${JSON.stringify(body)}`);
    check('F-CRIT-01c: er is wél een UPDATE-query uitgevoerd', queriesSinds(voor).some(q => /UPDATE/i.test(q.sql)), JSON.stringify(queriesSinds(voor)));
  }

  // ── F-CRIT-02a: DELETE /api/reparaties?neq_id=0 (was: hele tabel wissen) ──
  {
    const voor = uitgevoerdeQueries.length;
    const res = await fetch(`${baseUrl}/api/reparaties?neq_id=0`, { method: 'DELETE' });
    const body = await res.json();
    check('F-CRIT-02a: DELETE reparaties?neq_id=0 → 400', res.status === 400, `status=${res.status} body=${JSON.stringify(body)}`);
    check('F-CRIT-02a: geen DELETE-query uitgevoerd', queriesSinds(voor).length === 0, JSON.stringify(queriesSinds(voor)));
  }

  // ── F-CRIT-02b: PATCH /api/monteurs?neq_id=0 (was: alle accounts in één keer) ──
  {
    const voor = uitgevoerdeQueries.length;
    const res = await fetch(`${baseUrl}/api/monteurs?neq_id=0`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ naam: 'Overschreven' }),
    });
    const body = await res.json();
    check('F-CRIT-02b: PATCH monteurs?neq_id=0 → 400', res.status === 400, `status=${res.status} body=${JSON.stringify(body)}`);
    check('F-CRIT-02b: geen UPDATE-query uitgevoerd', queriesSinds(voor).length === 0, JSON.stringify(queriesSinds(voor)));
  }

  // ── F-CRIT-02c: DELETE met een normaal eq_-filter werkt nog (geen regressie) ──
  {
    const voor = uitgevoerdeQueries.length;
    const res = await fetch(`${baseUrl}/api/tagnr_scans?eq_reparatie_id=42`, { method: 'DELETE' });
    const body = await res.json();
    check('F-CRIT-02c: DELETE tagnr_scans?eq_reparatie_id=42 → 200 (geen regressie)', res.status === 200, `status=${res.status} body=${JSON.stringify(body)}`);
    check('F-CRIT-02c: er is wél een DELETE-query uitgevoerd', queriesSinds(voor).some(q => /DELETE/i.test(q.sql)), JSON.stringify(queriesSinds(voor)));
  }

  // ── F-CRIT-02d: PATCH met een normaal eq_-filter op reparaties werkt nog ──
  {
    const voor = uitgevoerdeQueries.length;
    const res = await fetch(`${baseUrl}/api/reparaties?eq_opdrachtnr=W2024-003`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magazijnlocatie: 'A-12' }),
    });
    const body = await res.json();
    check('F-CRIT-02d: PATCH reparaties?eq_opdrachtnr=... → 200 (geen regressie)', res.status === 200, `status=${res.status} body=${JSON.stringify(body)}`);
    check('F-CRIT-02d: er is wél een UPDATE-query uitgevoerd', queriesSinds(voor).some(q => /UPDATE/i.test(q.sql)), JSON.stringify(queriesSinds(voor)));
  }

  // ── F-CRIT-01d: POST /api/monteurs (nieuwe rij) mag is_admin niet zetten ──
  {
    const voor = uitgevoerdeQueries.length;
    const res = await fetch(`${baseUrl}/api/monteurs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ naam: 'Nieuwe Monteur', is_admin: 1 }),
    });
    const body = await res.json();
    check('F-CRIT-01d: POST monteurs {..., is_admin:1} → 403', res.status === 403, `status=${res.status} body=${JSON.stringify(body)}`);
    check('F-CRIT-01d: geen INSERT-query uitgevoerd', queriesSinds(voor).length === 0, JSON.stringify(queriesSinds(voor)));
  }

  // ── F-CRIT-01e: POST /api/monteurs/upsert mag nfc_token_hash niet zetten ──
  {
    const voor = uitgevoerdeQueries.length;
    const res = await fetch(`${baseUrl}/api/monteurs/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 4, nfc_token_hash: 'aanvaller-hash' }),
    });
    const body = await res.json();
    check('F-CRIT-01e: POST monteurs/upsert {nfc_token_hash:...} → 403', res.status === 403, `status=${res.status} body=${JSON.stringify(body)}`);
    check('F-CRIT-01e: geen INSERT/UPSERT-query uitgevoerd', queriesSinds(voor).length === 0, JSON.stringify(queriesSinds(voor)));
  }

  console.log(`\n${pass} geslaagd, ${fail} gefaald (${uitgevoerdeQueries.length} query's totaal gelogd, 0 echte databaseverbindingen gebruikt)`);
  process.exitCode = fail === 0 ? 0 : 1;
  server.close();
}

run().catch(err => { console.error(err); process.exitCode = 1; if (server) server.close(); });
