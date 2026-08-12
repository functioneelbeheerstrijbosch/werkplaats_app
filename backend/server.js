require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const db         = require('./db');

const authMiddleware  = require('./middleware/auth');
const authRoutes      = require('./routes/auth');
const apiRoutes       = require('./routes/api');
const { router: realtimeRouter } = require('./routes/realtime');
const planningRoutes  = require('./routes/planning');
const { startSync }   = require('./sync');

const app = express();

// ── Security headers (ISO 27001 R10) ────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", 'data:', 'blob:'],
      connectSrc:     ["'self'", 'https://apitest.strijbosch.nl'],
      fontSrc:        ["'self'"],
      objectSrc:      ["'none'"],
      frameSrc:       ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── Rate limiting op login (ISO 27001 R04) ───────────────────────
const loginLimiter = rateLimit({
  windowMs:         60 * 1000,  // 1 minuut
  max:              5,           // max 5 pogingen per IP
  standardHeaders:  true,
  legacyHeaders:    false,
  message: { error: 'Te veel loginpogingen. Probeer het over een minuut opnieuw.' },
});

// ── Rate limiting op alle API-routes ────────────────────────────
const apiLimiter = rateLimit({
  windowMs:        60 * 1000,   // 1 minuut
  max:             300,          // ruim genoeg voor normaal gebruik
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Te veel verzoeken. Probeer het later opnieuw.' },
});

const toegestaneOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://werkplaats.strijbosch.nl'
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || toegestaneOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS geblokkeerd voor origin: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// Uploads opslaan, bug-screenshots, reparatie-geluiden
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Publieke routes — login heeft strenge rate limit
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);

// Import: ontvang data van browser en sla op in reparaties
app.post('/api/sync/importeer', authMiddleware, async (req, res) => {
  const apiRijen = req.body;
  if (!Array.isArray(apiRijen) || apiRijen.length === 0) {
    return res.status(400).json({ error: 'Geen data ontvangen' });
  }

  const MAPPING = {
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
  const BESCHERMD = new Set(['monteur_id', 'in_behandeling_op', 'afgerond_op', 'toegewezen_door']);
  const fixDatum  = v => {
    if (!v || typeof v !== 'string') return v ?? null;
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 19).replace('T', ' ');
    if (/^\d{4}-\d{2}-\d{2}$/.test(v))  return v;
    if (/^\d{8}$/.test(v)) return `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`;
    return null;
  };

  try {
    let nieuw = 0, bijgewerkt = 0, fouten = 0;
    for (const apiRij of apiRijen) {
      try {
        const genorm = Object.fromEntries(Object.entries(apiRij).map(([k, v]) => [k.toLowerCase(), v]));
        const rij = {};
        for (const [van, naar] of Object.entries(MAPPING)) {
          if (genorm[van] !== undefined) rij[naar] = genorm[van];
        }
        if (!rij.opdrachtnr) continue;
        for (const k of ['aangemaakt_op', 'reden_datum', 'uiterste_datum_afdeling']) {
          if (rij[k]) rij[k] = fixDatum(rij[k]);
        }

        const [bestaand] = await db.query(
          'SELECT id FROM reparaties WHERE opdrachtnr = ? AND regelnummer = ?',
          [rij.opdrachtnr, rij.regelnummer ?? 1]
        );

        if (bestaand.length > 0) {
          const updateRij = Object.fromEntries(
            Object.entries(rij).filter(([k]) => !BESCHERMD.has(k) && k !== 'opdrachtnr' && k !== 'regelnummer')
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
        console.error('[IMPORTEER] Rij fout:', err.message);
        fouten++;
      }
    }
    res.json({ ok: true, nieuw, bijgewerkt, fouten });
  } catch (err) {
    console.error('[IMPORTEER]', err.message);
    res.status(500).json({ error: 'Serverfout bij importeren' });
  }
});

// Preview: haal API-data op zonder insert (ter controle)
app.get('/api/sync/preview', authMiddleware, async (_, res) => {
  try {
    const apiRes = await fetch(
      `${process.env.STRIJBOSCH_API_URL}?apikey=${process.env.STRIJBOSCH_API_KEY}`
    );
    if (!apiRes.ok) return res.status(502).json({ error: `API fout: HTTP ${apiRes.status}` });
    const data = await apiRes.json();
    res.json({ aantal: Array.isArray(data) ? data.length : null, voorbeeld: Array.isArray(data) ? data.slice(0, 3) : data });
  } catch (err) {
    console.error('[sync/preview]', err.message);
    res.status(500).json({ error: 'Serverfout bij ophalen preview' });
  }
});

// Beveiligde routes — JWT vereist + algemene rate limit
app.use('/api', apiLimiter, authMiddleware, apiRoutes);
app.use('/api/realtime', authMiddleware, realtimeRouter);
app.use('/api/planning', apiLimiter, authMiddleware, planningRoutes);

// Health check
app.get('/health', (_, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Werkplaats backend draait op http://localhost:${PORT}`);
  startSync();
});