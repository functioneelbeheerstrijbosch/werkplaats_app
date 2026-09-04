const router = require('express').Router();
const db     = require('../db');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const authMiddleware = require('../middleware/auth');
const { logAudit } = require('../auditLog');

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

    // Stuur wachtwoord_hash nooit terug naar de client
    const { wachtwoord_hash, ...monteurPubliek } = monteur;
    res.json({ token, monteur: monteurPubliek });

  } catch (err) {
    console.error('[auth/login]', err);
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
