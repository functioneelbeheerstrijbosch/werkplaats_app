require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const authMiddleware = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const { router: realtimeRouter } = require('./routes/realtime');
const { startSync } = require('./sync');

const app = express();

const toegestaneOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
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

// Publieke routes
app.use('/api/auth', authRoutes);

// Test routes zonder login
app.get('/', (_, res) => {
  res.send('Backend draait');
});

app.get('/api/test', (_, res) => {
  res.json({ message: 'API werkt' });
});

app.get('/api/db-test', async (_, res) => {
  try {
    const [rows] = await db.query('SELECT 1 AS test');

    res.json({
      ok: true,
      message: 'Databaseverbinding werkt',
      result: rows,
    });
  } catch (error) {
    console.error('Database test mislukt:', error);

    res.status(500).json({
      ok: false,
      message: 'Databaseverbinding mislukt',
      error: error.message,
    });
  }
});

// Beveiligde routes, JWT vereist
app.use('/api', authMiddleware, apiRoutes);
app.use('/api/realtime', authMiddleware, realtimeRouter);

// Health check
app.get('/health', (_, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Werkplaats backend draait op http://localhost:${PORT}`);
  startSync();
});