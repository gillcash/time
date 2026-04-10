import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import cookieParser from 'cookie-parser';
import { ensureTimeSchema } from './time-schema.js';
import { createTimeRouter } from './time-routes.js';
import { runNotificationCycle } from './notification-engine.js';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3400;
const TIME_DB = process.env.TIME_DB || '/data/time.db';

const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://localhost:4173', 'http://100.104.242.54:3000'];

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json());
app.use(cookieParser());

function getTimeDb() {
  const db = new Database(TIME_DB);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

// GET /api/health
app.get('/api/health', (req, res) => {
  try {
    const db = getTimeDb();
    const row = db.prepare('SELECT COUNT(*) as c FROM employees').get();
    db.close();
    res.json({ ok: true, employees: row.c, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Initialize time.db schema + mount time routes
try {
  ensureTimeSchema(getTimeDb);
} catch (err) {
  console.warn('Time schema init skipped (time.db may not be writable yet):', err.message);
}
app.use(createTimeRouter(getTimeDb));

// Notification checks: chained setTimeout prevents overlapping cycles
async function scheduleNotifications() {
  await runNotificationCycle(getTimeDb).catch(err =>
    console.warn('Notification cycle failed:', err.message));
  setTimeout(scheduleNotifications, 15 * 60 * 1000);
}

// Initial notification run 30s after startup
setTimeout(scheduleNotifications, 30_000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Time API :${PORT} | time.db: ${TIME_DB}`);
});
