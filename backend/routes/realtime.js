const router  = require('express').Router();

// Map van kanaalnaam → Set van SSE-responseobjecten
const clients = new Map();

// ── SSE-abonnement: GET /api/realtime/subscribe/:kanaal ─────────────────────
router.get('/subscribe/:kanaal', (req, res) => {
  const { kanaal } = req.params;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // voor nginx
  res.flushHeaders();

  // Stuur hartslag elke 25s zodat de verbinding niet time-out gaat
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  if (!clients.has(kanaal)) clients.set(kanaal, new Set());
  clients.get(kanaal).add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.get(kanaal)?.delete(res);
    if (clients.get(kanaal)?.size === 0) clients.delete(kanaal);
  });
});

// ── Broadcast vanuit andere routes ──────────────────────────────────────────
function broadcast(kanaal, event) {
  const groep = clients.get(kanaal);
  if (!groep || groep.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  groep.forEach(res => {
    try { res.write(payload); } catch { groep.delete(res); }
  });
}

module.exports = { router, broadcast };
