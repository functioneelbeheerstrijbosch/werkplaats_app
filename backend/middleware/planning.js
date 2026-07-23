module.exports = function planningMiddleware(req, res, next) {
  if (!req.user?.werkplaats_planning) {
    return res.status(403).json({ error: 'Geen toegang tot de planningsmodule' });
  }
  next();
};
