const router = require('express').Router();
const db     = require('../db');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const { logAudit } = require('../auditLog');

// Eén JWT + publieke monteur-vorm voor elke inlogmethode (wachtwoord, NFC, ...)
// — wachtwoord_hash/nfc_token_hash gaan nooit mee naar de client.
function sessieVoor(monteur) {
  const token = jwt.sign(
    {
      id:                  monteur.id,
      email:               monteur.email,
      naam:                monteur.naam,
      is_admin:            !!monteur.is_admin,
      werkplaats_planning: !!monteur.werkplaats_planning,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );
  const { wachtwoord_hash, nfc_token_hash, ...monteurPubliek } = monteur;
  return { token, monteur: monteurPubliek };
}

// POST /api/auth/login
// Body: { email, password }
// Returns: { token, monteur }
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail en wachtwoord zijn verplicht' });
  }

  try {
    const [rows] = await db.query(
      'SELECT * FROM monteurs WHERE email = ? AND actief = 1 LIMIT 1',
      [email]
    );

    const monteur = rows[0];
    if (!monteur) {
      return res.status(401).json({ error: 'Onjuist e-mailadres of wachtwoord' });
    }

    const geldig = await bcrypt.compare(password, monteur.wachtwoord_hash);
    if (!geldig) {
      return res.status(401).json({ error: 'Onjuist e-mailadres of wachtwoord' });
    }

    res.json(sessieVoor(monteur));

  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Serverfout bij inloggen' });
  }
});

// POST /api/auth/nfc-login
// Body: { token } — het fabrieks-serienummer (UID) van de tag, lowercase
// met dubbele punt (bv. "04:40:0a:ba:cb:14:90"), exact zoals de frontend
// `event.serialNumber` normaliseert (zie signInMetNfc() in frontend/app.js)
// — geen kale tag hoeft dus vooraf beschreven te worden. Koppelen aan een
// monteur gebeurt buiten deze app om, rechtstreeks in MySQL met SHA2(),
// zie internal-docs/architectuur-en-audit.md.
// Returns: { token, monteur } — zelfde vorm als POST /login.
//
// nfc_token_hash is SHA-256 (niet bcrypt): dit token is zelf al identificerende,
// niet-geheime hardwaredata (geen door een mens bedacht wachtwoord) — geen
// reden voor bcrypt's trage, gesalte hashing, en een directe lookup op de
// hash (`WHERE nfc_token_hash = ?`) kan sowieso niet met bcrypt (niet-
// deterministisch). Zelfde patroon als API-keys/sessietokens.
router.post('/nfc-login', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is verplicht' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const [rows] = await db.query(
      'SELECT * FROM monteurs WHERE nfc_token_hash = ? AND actief = 1 LIMIT 1',
      [tokenHash]
    );

    const monteur = rows[0];
    if (!monteur) {
      return res.status(401).json({ error: 'Tag niet herkend' });
    }

    res.json(sessieVoor(monteur));

  } catch (err) {
    console.error('[auth/nfc-login]', err);
    res.status(500).json({ error: 'Serverfout bij inloggen' });
  }
});

// POST /api/auth/wachtwoord-instellen
// Alleen toegankelijk voor ingelogde admins (is_admin = 1)
router.post('/wachtwoord-instellen', authMiddleware, async (req, res) => {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Geen toegang' });
  }
  const { monteur_id, wachtwoord } = req.body;
  if (!monteur_id || !wachtwoord) {
    return res.status(400).json({ error: 'monteur_id en wachtwoord zijn verplicht' });
  }
  try {
    const hash = await bcrypt.hash(wachtwoord, 12);
    await db.query('UPDATE monteurs SET wachtwoord_hash = ? WHERE id = ?', [hash, monteur_id]);
    logAudit({ monteurId: req.user.id, actie: 'wachtwoord_reset', doelMonteurId: monteur_id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/wachtwoord-instellen]', err);
    res.status(500).json({ error: 'Serverfout' });
  }
});

module.exports = router;
