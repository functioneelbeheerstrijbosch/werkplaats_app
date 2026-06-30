require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');

const authMiddleware    = require('./middleware/auth');
const authRoutes        = require('./routes/auth');
const apiRoutes         = require('./routes/api');
const { router: realtimeRouter } = require('./routes/realtime');

const app = express();

if (!process.env.FRONTEND_URL) {
  console.error('FATAL: FRONTEND_URL is niet ingesteld in .env');
  process.exit(1);
}

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Uploads opslaan (bug-screenshots, reparatie-geluiden)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Publieke routes
app.use('/api/auth', authRoutes);

// Beveiligde routes (JWT vereist)
app.use('/api', authMiddleware, apiRoutes);
app.use('/api/realtime', authMiddleware, realtimeRouter);

// Health check
app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Werkplaats backend draait op http://localhost:${PORT}`);
});
