const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const header = req.headers.authorization || '';
  // EventSource kan geen headers sturen — token ook via query-param accepteren
  const token  = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || header);

  if (!token || token === 'null') return res.status(401).json({ data: null, error: 'Niet ingelogd' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ data: null, error: 'Sessie verlopen, log opnieuw in' });
  }
};
