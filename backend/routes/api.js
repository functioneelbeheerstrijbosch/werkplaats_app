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

// ── Beperkte set toegestane 'embeds' (Supabase-achtige geneste select,
// bv. `.select('..., monteurs(naam, initialen)')`) ─────────────────────────
// Alleen wat de frontend daadwerkelijk gebruikt; niet generiek voor elke
// tabelcombinatie. fk = kolom op de hoofdtabel, pk = kolom op de embed-tabel.
const TOEGESTANE_EMBEDS = {
  reparaties: {
    monteurs: { fk: 'monteur_id', pk: 'id' },
  },
};

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
// `tabelPrefix` is optioneel en wordt alleen meegegeven zodra de query een
// JOIN bevat (embed, zie hieronder) — voorkomt "column is ambiguous"-fouten
// tegen de embed-tabel, zonder de kolomreferenties voor de veelgebruikte
// join-loze aanroepen te wijzigen.
function buildWhere(params, tabelPrefix) {
  const conditions = [];
  const values     = [];
  const qCol = (col) => tabelPrefix ? `\`${tabelPrefix}\`.\`${col}\`` : `\`${col}\``;

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
      conditions.push(`${qCol(col)} = ?`);
      values.push(val);
    } else if (key.startsWith('neq_')) {
      conditions.push(`${qCol(col)} != ?`);
      values.push(val);
    } else if (key.startsWith('in_')) {
      const vals = val.split(',');
      conditions.push(`${qCol(col)} IN (${vals.map(() => '?').join(',')})`);
      values.push(...vals);
    } else if (key.startsWith('is_')) {
      if (val === 'null') conditions.push(`${qCol(col)} IS NULL`);
      else { conditions.push(`${qCol(col)} = ?`); values.push(val); }
    } else if (key.startsWith('not_null_')) {
      conditions.push(`${qCol(col)} IS NOT NULL`);
    } else if (key.startsWith('gte_')) {
      conditions.push(`${qCol(col)} >= ?`);
      values.push(val);
    } else if (key.startsWith('lte_')) {
      conditions.push(`${qCol(col)} <= ?`);
      values.push(val);
    } else if (key.startsWith('ilike_')) {
      conditions.push(`${qCol(col)} LIKE ?`);
      values.push(`%${val.replace(/%/g, '')}%`);
    }
  }

  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    values,
  };
}

// Parseert een select-string als 'kol1, kol2, tabel(kolA, kolB)' in platte
// kolommen + (optioneel) één toegestane embed-specificatie.
function parseSelect(select, tabel) {
  const embeds = TOEGESTANE_EMBEDS[tabel] || {};
  const embedMatch = select.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/);
  let plain = select;
  let embed = null;

  if (embedMatch && embeds[embedMatch[1]]) {
    const [, embedTabel, embedColsRaw] = embedMatch;
    const embedCols = embedColsRaw.split(',').map(c => c.trim()).filter(isGeldigeKolom);
    if (embedCols.length) {
      embed = { tabel: embedTabel, cols: embedCols, ...embeds[embedTabel] };
    }
    plain = select.slice(0, embedMatch.index) + select.slice(embedMatch.index + embedMatch[0].length);
  }

  const plainCols = plain.split(',').map(c => c.trim()).filter(c => c && isGeldigeKolom(c));
  return { plainCols, embed };
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

  // Kolommen: '*', of validated 'col1,col2,...' met eventueel één embed
  // (bv. 'monteurs(naam, initialen)' — Supabase-achtige geneste select).
  // Bewust GEEN SQL-JOIN voor de embed: een JOIN duwt de MySQL-planner naar
  // een filesort/temp-table i.p.v. de index te gebruiken voor ORDER BY (zo
  // ontstond de "Out of sort memory"-fout opnieuw, ook mét index op de
  // sorteerkolom). De hoofdquery blijft dus een kale SELECT die de index
  // kan gebruiken; de embed-tabel wordt apart en klein nabevraagd.
  let cols, embed = null, fkWasAangevraagd = true;
  if (select === '*') {
    cols = '*';
  } else {
    const parsed = parseSelect(select, tabel);
    embed = parsed.embed;
    let plainCols = parsed.plainCols;
    // FK-kolom moet altijd meekomen om de embed te kunnen matchen, ook als
    // de aanroeper 'm niet zelf in de select zette (bv. .select('monteurs(...)')
    // zonder ook 'monteur_id' te vragen) — anders niet in de output tonen.
    if (embed && !plainCols.includes(embed.fk)) {
      fkWasAangevraagd = false;
      plainCols = [...plainCols, embed.fk];
    }
    cols = plainCols.map(c => `\`${c}\``).join(', ') || '*';
  }

  const { where, values } = buildWhere(filterParams(req.query));
  const orderClause  = (order && isGeldigeKolom(order)) ? `ORDER BY \`${order}\` ${asc === '0' ? 'DESC' : 'ASC'}` : '';
  const limitClause  = limit  ? `LIMIT ${parseInt(limit)}`  : (single === '1' ? 'LIMIT 1' : '');
  const offsetClause = offset ? `OFFSET ${parseInt(offset)}` : '';

  // Bij ORDER BY + LIMIT op een brede select (veel/grote kolommen) kiest
  // MySQL vaak filesort i.p.v. de index, ook als die er staat — de
  // optimizer moet dan alsnog alle brede rijen sorteren, wat op "Out of
  // sort memory" kan lopen (gezien op /api/reparaties, 2026-08-17).
  // Fix: eerst smal sorteren/limiteren (alleen id, licht voor de sort-
  // buffer, kan de index gebruiken), dán pas de volledige rijen ophalen
  // voor die kleine subset. JOIN naar een derived table i.p.v. WHERE id IN
  // (subquery) — MySQL ondersteunt LIMIT niet binnen een IN-subquery
  // (ER_NOT_SUPPORTED_YET).
  const gebruikDeferredJoin = !!orderClause && !!limitClause;
  let query;
  if (gebruikDeferredJoin) {
    const colsVoorJoin  = cols === '*' ? 't.*' : cols.split(', ').map(c => `t.${c}`).join(', ');
    const orderVoorJoin = `ORDER BY t.\`${order}\` ${asc === '0' ? 'DESC' : 'ASC'}`;
    query = `SELECT ${colsVoorJoin} FROM \`${tabel}\` t
      JOIN (
        SELECT \`id\` FROM \`${tabel}\` ${where} ${orderClause} ${limitClause} ${offsetClause}
      ) AS _ids ON t.\`id\` = _ids.\`id\`
      ${orderVoorJoin}`;
  } else {
    query = `SELECT ${cols} FROM \`${tabel}\` ${where} ${orderClause} ${limitClause} ${offsetClause}`;
  }

  try {
    const [rows] = await db.query(
      query,
      values
    );

    // Embed: FK-waarden verzamelen en de gerelateerde rijen in één aparte,
    // kleine query ophalen — dan in JS samenvoegen. Nooit meer dan
    // aantal-unieke-FK's rijen, dus geen belasting op de hoofdquery.
    let data = rows;
    if (embed) {
      const naToevoegen = (row) => {
        if (fkWasAangevraagd) return row;
        const { [embed.fk]: _weg, ...rest } = row;
        return rest;
      };

      let embedPerPk = new Map();
      if (rows.length > 0) {
        const fkWaarden = [...new Set(rows.map(r => r[embed.fk]).filter(v => v !== null && v !== undefined))];
        if (fkWaarden.length > 0) {
          const embedCols = [embed.pk, ...embed.cols].map(c => `\`${c}\``).join(', ');
          const [embedRijen] = await db.query(
            `SELECT ${embedCols} FROM \`${embed.tabel}\` WHERE \`${embed.pk}\` IN (${fkWaarden.map(() => '?').join(',')})`,
            fkWaarden
          );
          embedPerPk = new Map(embedRijen.map(r => [r[embed.pk], r]));
        }
      }

      data = rows.map(row => {
        const matched = embedPerPk.get(row[embed.fk]);
        const nested = matched
          ? Object.fromEntries(embed.cols.map(c => [c, matched[c]]))
          : null;
        return { ...naToevoegen(row), [embed.tabel]: nested };
      });
    }

    if (single === '1') {
      if (data.length === 0) return res.status(406).json({ data: null, error: 'Niet gevonden' });
      return res.json({ data: data[0], error: null });
    }
    res.json({ data, error: null });

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
