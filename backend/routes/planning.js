const router = require('express').Router();
const db     = require('../db');
const planningMiddleware = require('../middleware/planning');
const { broadcast } = require('./realtime');
const { logAudit } = require('../auditLog');

router.use(planningMiddleware);

// ── Reparaties ────────────────────────────────────────────────────
router.get('/reparaties', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.*, m.naam AS monteur_naam, m.initialen AS monteur_initialen
      FROM reparaties r
      LEFT JOIN monteurs m ON r.monteur_id = m.id
      ORDER BY r.aangemaakt_op DESC
      LIMIT 2000
    `);
    res.json(rows.map(r => ({
      ...r,
      monteurs: r.monteur_id ? { naam: r.monteur_naam, initialen: r.monteur_initialen } : null,
    })));
  } catch (err) {
    console.error('[planning GET /reparaties]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

router.patch('/reparaties/:id', async (req, res) => {
  try {
    const toegestaan = ['status','monteur_id','toegewezen_door','in_behandeling_op','afgerond_op','prioriteit','diagnose','werkzaamheden','klacht'];
    const velden = Object.fromEntries(Object.entries(req.body).filter(([k]) => toegestaan.includes(k)));
    if (!Object.keys(velden).length) return res.status(400).json({ error: 'Geen geldige velden' });
    const cols = Object.keys(velden).map(k => `\`${k}\` = ?`).join(', ');
    await db.query(`UPDATE reparaties SET ${cols} WHERE id = ?`, [...Object.values(velden), req.params.id]);
    broadcast('werkplaats-sync', { event: 'UPDATE', table: 'reparaties' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[planning PATCH /reparaties/:id]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ── Monteurs ──────────────────────────────────────────────────────
router.get('/monteurs', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM monteurs WHERE actief = 1 ORDER BY naam');
    // wachtwoord_hash nooit meesturen — zelfde reden als bij POST /auth/login.
    res.json(rows.map(({ wachtwoord_hash, ...r }) => r));
  } catch (err) {
    console.error('[planning GET /monteurs]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

router.patch('/monteurs/:id', async (req, res) => {
  try {
    const toegestaan = ['is_admin','is_onderdelenbeheerder','werkplaats_toegang','witgoed_toegang','witgoed_voorraadbeheer','locatie_aanpassen','werkvoorbereider','werkplaats_planning','productieplanning'];
    const velden = Object.fromEntries(Object.entries(req.body).filter(([k]) => toegestaan.includes(k)));
    if (!Object.keys(velden).length) return res.status(400).json({ error: 'Geen geldige velden' });
    const cols = Object.keys(velden).map(k => `\`${k}\` = ?`).join(', ');
    await db.query(`UPDATE monteurs SET ${cols} WHERE id = ?`, [...Object.values(velden), req.params.id]);
    broadcast('monteurs-sync', { event: 'UPDATE', table: 'monteurs' });
    logAudit({ monteurId: req.user.id, actie: 'rol_wijziging', doelMonteurId: req.params.id, details: velden });
    res.json({ ok: true });
  } catch (err) {
    console.error('[planning PATCH /monteurs/:id]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ── Reparatie logs ────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  try {
    const { van, tm, nrs } = req.query;
    let sql = "SELECT * FROM reparatie_logs WHERE actie = 'afgerond'";
    const params = [];
    if (nrs) {
      // Volledige historie ophalen voor specifieke opdrachtnrs (ongeacht datum)
      const lijst = nrs.split(',').map(s => s.trim()).filter(Boolean);
      if (lijst.length) {
        sql += ` AND opdrachtnr IN (${lijst.map(() => '?').join(',')})`;
        params.push(...lijst);
      }
    } else {
      if (van) { sql += ' AND aangemaakt_op >= ?'; params.push(van); }
      if (tm)  { sql += ' AND aangemaakt_op < ?';  params.push(tm); }
    }
    sql += ' ORDER BY aangemaakt_op DESC LIMIT 5000';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    console.error('[planning GET /logs]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ── Tagnr scans ───────────────────────────────────────────────────
router.get('/tagnr-scans', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM tagnr_scans ORDER BY aangemaakt_op DESC LIMIT 5000');
    res.json(rows);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    console.error('[planning GET /tagnr-scans]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ── Onderdelen ────────────────────────────────────────────────────
router.get('/onderdelen', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM onderdelen ORDER BY naam');
    res.json(rows);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    console.error('[planning GET /onderdelen]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ── Voorraad taken ────────────────────────────────────────────────
router.get('/voorraad-taken', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT vt.*, m.naam AS monteur_naam, m.initialen AS monteur_initialen,
             o.naam AS onderdeel_naam, o.artikelnr AS onderdeel_artikelnr
      FROM voorraad_taken vt
      LEFT JOIN monteurs m ON vt.monteur_id = m.id
      LEFT JOIN onderdelen o ON vt.onderdeel_id = o.id
      ORDER BY vt.aangemaakt_op DESC
    `);
    res.json(rows.map(r => ({
      ...r,
      monteurs:   r.monteur_naam   ? { naam: r.monteur_naam,   initialen: r.monteur_initialen }  : null,
      onderdelen: r.onderdeel_naam ? { naam: r.onderdeel_naam, artikelnr: r.onderdeel_artikelnr } : null,
    })));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    console.error('[planning GET /voorraad-taken]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

router.post('/voorraad-taken', async (req, res) => {
  try {
    const { onderdeel_id, monteur_id } = req.body;
    const [result] = await db.query(
      'INSERT INTO voorraad_taken (onderdeel_id, monteur_id) VALUES (?, ?)',
      [onderdeel_id, monteur_id]
    );
    broadcast('voorraad-taken-sync', { event: 'INSERT', table: 'voorraad_taken' });
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    console.error('[planning POST /voorraad-taken]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

router.delete('/voorraad-taken/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM voorraad_taken WHERE id = ?', [req.params.id]);
    broadcast('voorraad-taken-sync', { event: 'DELETE', table: 'voorraad_taken' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[planning DELETE /voorraad-taken/:id]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

// ── Onderdelen kleuren ────────────────────────────────────────────
router.get('/onderdelen-kleuren', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM onderdelen_kleuren');
    res.json(rows);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    console.error('[planning GET /onderdelen-kleuren]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

router.post('/onderdelen-kleuren', async (req, res) => {
  const { opdrachtnr, kleur } = req.body;
  const upsert = async () => db.query(
    `INSERT INTO onderdelen_kleuren (opdrachtnr, kleur, bijgewerkt_op) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE kleur = VALUES(kleur), bijgewerkt_op = NOW()`,
    [opdrachtnr, kleur]
  );
  try {
    await upsert();
    broadcast('onderdelen-kleuren-sync', { event: 'UPSERT', table: 'onderdelen_kleuren' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      try {
        await db.query(`CREATE TABLE IF NOT EXISTS onderdelen_kleuren (
          opdrachtnr VARCHAR(50) PRIMARY KEY,
          kleur VARCHAR(20) NOT NULL DEFAULT 'oranje',
          bijgewerkt_op DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await upsert();
        broadcast('onderdelen-kleuren-sync', { event: 'UPSERT', table: 'onderdelen_kleuren' });
        return res.json({ ok: true });
      } catch (err2) {
        console.error('[planning POST /onderdelen-kleuren]', err2.message);
        return res.status(500).json({ error: 'Serverfout' });
      }
    }
    console.error('[planning POST /onderdelen-kleuren]', err.message);
    res.status(500).json({ error: 'Serverfout' });
  }
});

module.exports = router;
