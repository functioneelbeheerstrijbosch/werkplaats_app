const db = require('./db');

// Schrijft een audit-regel weg voor gevoelige beheershandelingen
// (rolwijzigingen, wachtwoord-resets). Maakt de tabel bij de eerste
// aanroep automatisch aan als die nog niet bestaat.
// Faalt bewust nooit naar de aanroeper toe — een audit-log die niet
// weggeschreven kan worden mag de eigenlijke actie niet blokkeren.
async function logAudit({ monteurId, actie, doelMonteurId = null, details = null }) {
  const insert = () => db.query(
    'INSERT INTO audit_log (monteur_id, actie, doel_monteur_id, details) VALUES (?, ?, ?, ?)',
    [monteurId, actie, doelMonteurId, details ? JSON.stringify(details) : null]
  );

  try {
    await insert();
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      try {
        await db.query(`CREATE TABLE IF NOT EXISTS audit_log (
          id INT AUTO_INCREMENT PRIMARY KEY,
          monteur_id INT NOT NULL,
          actie VARCHAR(100) NOT NULL,
          doel_monteur_id INT NULL,
          details JSON NULL,
          aangemaakt_op DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await insert();
      } catch (err2) {
        console.error('[AUDIT] Kon audit_log niet aanmaken/wegschrijven:', err2.message);
      }
      return;
    }
    console.error('[AUDIT] Kon audit-regel niet wegschrijven:', err.message);
  }
}

module.exports = { logAudit };
