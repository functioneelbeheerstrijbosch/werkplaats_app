const router   = require('express').Router();
const db       = require('../db');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { broadcast } = require('./realtime');

// ── Tabellen die via de generieke router mogen worden benaderd ──────────────
// Voeg hier GEEN tabellen toe die je niet wil blootstellen via de API.
const TOEGESTANE_TABELLEN = new Set([
  'reparaties',
  'reparatie_logs',
  'monteurs',
  'tagnr_scans',
  'artikel_voorraad',
  'onderdelen',
  'vragensets',
  'reparatie_antwoorden',
  'vragen',
  'antwoordopties',
  'pmoorzaak',
  'witgoed_apparaten',
  'tags',
  'onderdelen_kleuren',
  'gebruiker_instellingen',
  'vertalingen',
  'bug_meldingen',
  'postcodes',
]);

// Realtime-kanalen per tabel (voor broadcasting na mutaties)
const TABEL_KANAAL = {
  reparaties:     'werkplaats-sync',
  reparatie_logs: 'werkplaats-sync',
};

// ── Multer voor bestandsuploads ─────────────────────────────────────────────
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Alleen foto's (bug-screenshots) en geluidsopnames (reparatie-geluid) toestaan —
// voorkomt dat willekeurige bestandstypes (bv. .html/.svg met script) worden
// geüpload en vervolgens vanaf hetzelfde origin teruggeserveerd.
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const toegestaan = file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/');
    cb(toegestaan ? null : new Error('Alleen afbeeldingen en geluidsopnames zijn toegestaan'), toegestaan);
  },
});

// Kolomnamen mogen alleen letters, cijfers en underscores bevatten
function isGeldigeKolom(naam) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(naam);
}

// ISO 8601 ('2024-07-08T17:25:33.123Z') → MySQL datetime ('2024-07-08 17:25:33')
function normaliseerWaarde(val) {
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
    return val.slice(0, 19).replace('T', ' ');
  }
  return val;
}

// ── Query-parameter → WHERE-clausule ───────────────────────────────────────
function buildWhere(params) {
  const conditions = [];
  const values     = [];

  for (const [key, val] of Object.entries(params)) {
    let col;

    if (key.startsWith('eq_'))       col = key.slice(3);
    else if (key.startsWith('neq_')) col = key.slice(4);
    else if (key.startsWith('in_'))  col = key.slice(3);
    else if (key.startsWith('is_'))  col = key.slice(3);
    else if (key.startsWith('not_null_')) col = key.slice(9);
    else if (key.startsWith('gte_')) col = key.slice(4);
    else if (key.startsWith('lte_')) col = key.slice(4);
    else if (key.startsWith('ilike_')) col = key.slice(6);
    else continue;

    if (!isGeldigeKolom(col)) continue;

    if (key.startsWith('eq_')) {
      conditions.push(`\`${col}\` = ?`);
      values.push(val);
    } else if (key.startsWith('neq_')) {
      conditions.push(`\`${col}\` != ?`);
      values.push(val);
    } else if (key.startsWith('in_')) {
      const vals = val.split(',');
      conditions.push(`\`${col}\` IN (${vals.map(() => '?').join(',')})`);
      values.push(...vals);
    } else if (key.startsWith('is_')) {
      if (val === 'null') conditions.push(`\`${col}\` IS NULL`);
      else { conditions.push(`\`${col}\` = ?`); values.push(val); }
    } else if (key.startsWith('not_null_')) {
      conditions.push(`\`${col}\` IS NOT NULL`);
    } else if (key.startsWith('gte_')) {
      conditions.push(`\`${col}\` >= ?`);
      values.push(val);
    } else if (key.startsWith('lte_')) {
      conditions.push(`\`${col}\` <= ?`);
      values.push(val);
    } else if (key.startsWith('ilike_')) {
      conditions.push(`\`${col}\` LIKE ?`);
      values.push(`%${val.replace(/%/g, '')}%`);
    }
  }

  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    values,
  };
}

// Verwijder interne queryparams zodat ze niet in buildWhere terecht komen
function filterParams(query) {
  const { select, order, asc, limit, single, offset, ...rest } = query;
  return rest;
}

// ── GET /api/:tabel ─────────────────────────────────────────────────────────
router.get('/:tabel', async (req, res) => {
  const { tabel } = req.params;
  if (!TOEGESTANE_TABELLEN.has(tabel)) {
    return res.status(400).json({ data: null, error: 'Onbekende tabel' });
  }

  const { select = '*', order, asc, limit, single, offset } = req.query;
  const { where, values } = buildWhere(filterParams(req.query));

  // Kolommen: '*' of valideerde 'col1,col2,...'
  const cols = select === '*'
    ? '*'
    : select.split(',').map(c => c.trim()).filter(isGeldigeKolom).map(c => `\`${c}\``).join(', ') || '*';

  // ORDER BY alleen toestaan met geldige kolomnaam
  const orderClause  = (order && isGeldigeKolom(order)) ? `ORDER BY \`${order}\` ${asc === '0' ? 'DESC' : 'ASC'}` : '';
  const limitClause  = limit  ? `LIMIT ${parseInt(limit)}`  : (single === '1' ? 'LIMIT 1' : '');
  const offsetClause = offset ? `OFFSET ${parseInt(offset)}` : '';

  try {
    const [rows] = await db.query(
      `SELECT ${cols} FROM \`${tabel}\` ${where} ${orderClause} ${limitClause} ${offsetClause}`,
      values
    );

    if (single === '1') {
      if (rows.length === 0) return res.status(406).json({ data: null, error: 'Niet gevonden' });
      return res.json({ data: rows[0], error: null });
    }
    res.json({ data: rows, error: null });

  } catch (err) {
    console.error(`[GET /${tabel}]`, err.message);
    res.status(500).json({ data: null, error: 'Serverfout' });
  }
});

// ── POST /api/:tabel ────────────────────────────────────────────────────────
router.post('/:tabel', async (req, res) => {
  const { tabel } = req.params;
  if (!TOEGESTANE_TABELLEN.has(tabel)) {
    return res.status(400).json({ data: null, error: 'Onbekende tabel' });
  }

  const rijen        = Array.isArray(req.body) ? req.body : [req.body];
  const metSelect    = !!req.query.select;
  const results      = [];

  try {
    for (const rij of rijen) {
      if (!rij || Object.keys(rij).length === 0) continue;
      const kolommen     = Object.keys(rij).map(c => `\`${c}\``).join(', ');
      const placeholders = Object.keys(rij).map(() => '?').join(', ');
      const waarden      = Object.values(rij).map(normaliseerWaarde);

      const [result] = await db.query(
        `INSERT INTO \`${tabel}\` (${kolommen}) VALUES (${placeholders})`,
        waarden
      );

      if (metSelect) {
        const [ingevoegd] = await db.query(
          `SELECT * FROM \`${tabel}\` WHERE id = ?`,
          [result.insertId]
        );
        results.push(ingevoegd[0] ?? { id: result.insertId });
      } else {
        results.push({ id: result.insertId });
      }
    }

    // Broadcast naar realtime-clients
    const kanaal = TABEL_KANAAL[tabel];
    if (kanaal) broadcast(kanaal, { event: 'INSERT', table: tabel, new: results[0] });

    const data = results.length === 1 ? results[0] : results;
    res.status(201).json({ data, error: null });

  } catch (err) {
    console.error(`[POST /${tabel}]`, err.message);
    res.status(500).json({ data: null, error: 'Serverfout' });
  }
});

// ── PATCH /api/:tabel  (update met filters als queryparams) ─────────────────
router.patch('/:tabel', async (req, res) => {
  const { tabel } = req.params;
  if (!TOEGESTANE_TABELLEN.has(tabel)) {
    return res.status(400).json({ data: null, error: 'Onbekende tabel' });
  }

  const { where, values: whereValues } = buildWhere(filterParams(req.query));
  if (!where) {
    return res.status(400).json({ data: null, error: 'Geen filter meegegeven bij UPDATE (veiligheid)' });
  }

  const body = req.body;
  if (!body || Object.keys(body).length === 0) {
    return res.status(400).json({ data: null, error: 'Geen data meegegeven' });
  }

  const setCols   = Object.keys(body).map(c => `\`${c}\` = ?`).join(', ');
  const setValues = Object.values(body).map(normaliseerWaarde);

  try {
    await db.query(`UPDATE \`${tabel}\` SET ${setCols} ${where}`, [...setValues, ...whereValues]);

    const kanaal = TABEL_KANAAL[tabel];
    if (kanaal) broadcast(kanaal, { event: 'UPDATE', table: tabel });

    res.json({ data: null, error: null });

  } catch (err) {
    console.error(`[PATCH /${tabel}]`, err.message);
    res.status(500).json({ data: null, error: 'Serverfout' });
  }
});

// ── DELETE /api/:tabel ──────────────────────────────────────────────────────
router.delete('/:tabel', async (req, res) => {
  const { tabel } = req.params;
  if (!TOEGESTANE_TABELLEN.has(tabel)) {
    return res.status(400).json({ data: null, error: 'Onbekende tabel' });
  }

  const { where, values } = buildWhere(filterParams(req.query));
  if (!where) {
    return res.status(400).json({ data: null, error: 'Geen filter meegegeven bij DELETE (veiligheid)' });
  }

  try {
    await db.query(`DELETE FROM \`${tabel}\` ${where}`, values);

    const kanaal = TABEL_KANAAL[tabel];
    if (kanaal) broadcast(kanaal, { event: 'DELETE', table: tabel });

    res.json({ data: null, error: null });

  } catch (err) {
    console.error(`[DELETE /${tabel}]`, err.message);
    res.status(500).json({ data: null, error: 'Serverfout' });
  }
});

// ── POST /api/:tabel/upsert ─────────────────────────────────────────────────
router.post('/:tabel/upsert', async (req, res) => {
  const { tabel } = req.params;
  if (!TOEGESTANE_TABELLEN.has(tabel)) {
    return res.status(400).json({ data: null, error: 'Onbekende tabel' });
  }

  const rijen = Array.isArray(req.body) ? req.body : [req.body];

  try {
    for (const rij of rijen) {
      if (!rij || Object.keys(rij).length === 0) continue;
      const kolommen     = Object.keys(rij).map(c => `\`${c}\``).join(', ');
      const placeholders = Object.keys(rij).map(() => '?').join(', ');
      const updates      = Object.keys(rij)
        .filter(c => c !== 'id')
        .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(', ');
      const waarden = Object.values(rij).map(normaliseerWaarde);

      await db.query(
        `INSERT INTO \`${tabel}\` (${kolommen}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updates}`,
        waarden
      );
    }
    res.json({ data: null, error: null });

  } catch (err) {
    console.error(`[UPSERT /${tabel}]`, err.message);
    res.status(500).json({ data: null, error: 'Serverfout' });
  }
});

// ── POST /api/upload/:bucket ─────────────────────────────────────────────────
// Vervangt Supabase Storage uploads (bug-screenshots, reparatie-geluiden)
router.post('/upload/:bucket', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen' });

  const ext      = path.extname(req.file.originalname);
  const nieuweNaam = `${req.params.bucket}/${Date.now()}${ext}`;
  const doel     = path.join(uploadDir, nieuweNaam);

  fs.mkdirSync(path.dirname(doel), { recursive: true });
  fs.renameSync(req.file.path, doel);

  // Geef publieke URL terug (zelfde patroon als Supabase publicUrl)
  const publicUrl = `${process.env.BACKEND_URL || 'http://localhost:3000'}/uploads/${nieuweNaam}`;
  res.json({ data: { publicUrl }, error: null });
});

module.exports = router;
