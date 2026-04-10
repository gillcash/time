/**
 * Time-tracking API routes.
 * Mounted at /auth/* and /api/time/* in server.js.
 *
 * Auth: magic link → session cookie (time_session)
 * Core: clock-in/out with GPS + rounding, timesheet, sync
 * Approval: supervisor weekly approval workflow
 * Admin: employee CRUD
 */

import { Router } from 'express';
import { DateTime } from 'luxon';
import {
  generateToken, generateCode, hashToken,
  setTimeSessionCookie, clearTimeSessionCookie,
  createRequireTimeAuth, requireTimeRole,
  sendMagicCodeEmail, auditLog
} from './time-auth.js';

const TZ = 'America/Moncton';
const TIME_APP_URL = process.env.TIME_APP_URL || 'http://localhost:3000';
const MAX_SYNC_BATCH = 100;
const IS_DEV = process.env.NODE_ENV === 'development';
const DEV_BYPASS_CODE = 'DEV999';

// ════════════════════════════════════════════════════════════════
// Pure business logic (ported from frontend lib/)
// ════════════════════════════════════════════════════════════════

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const CLOCK_IN_GRACE_MS = 5 * 60 * 1000;
const CLOCK_OUT_GRACE_MS = 10 * 60 * 1000;

function roundClockIn(timestamp, graceMs = CLOCK_IN_GRACE_MS) {
  const t = new Date(timestamp).getTime();
  const prev = Math.floor(t / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  const minutesAfterMark = t - prev;
  return minutesAfterMark <= graceMs
    ? new Date(prev)
    : new Date(prev + QUARTER_HOUR_MS);
}

function roundClockOut(timestamp, graceMs = CLOCK_OUT_GRACE_MS) {
  const t = new Date(timestamp).getTime();
  const next = Math.ceil(t / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  const adjustedNext = (t % QUARTER_HOUR_MS === 0) ? t : next;
  const minutesBeforeMark = adjustedNext - t;
  return minutesBeforeMark <= graceMs
    ? new Date(adjustedNext)
    : new Date(adjustedNext - QUARTER_HOUR_MS);
}

function elapsedMinutes(clockInRounded, clockOutRounded) {
  const inMs = new Date(clockInRounded).getTime();
  const outMs = new Date(clockOutRounded).getTime();
  return Math.round((outMs - inMs) / 60000);
}

function lunchDeduction(elapsedMins, config = {}) {
  const threshold = config.lunchThreshold ?? 300;
  const deduction = config.lunchDeductionMin ?? 30;
  if (elapsedMins >= threshold) {
    return { deducted: true, minutes: deduction };
  }
  return { deducted: false, minutes: 0 };
}

function toAtlantic(utcIso) {
  return DateTime.fromISO(utcIso, { zone: 'utc' }).setZone(TZ);
}

function getLocalDate(utcIso) {
  return toAtlantic(utcIso).toISODate();
}

function getLocalDow(utcIso) {
  return toAtlantic(utcIso).weekday % 7; // 0=Sun..6=Sat
}

function getPayWeekStart(utcIso) {
  const atlantic = toAtlantic(utcIso);
  const monday = atlantic.startOf('week'); // luxon weeks start Monday
  return monday.toISODate();
}

function calculateOvertime(totalNetMinutes, config = {}) {
  const threshold = config.thresholdMin ?? 2640;
  const nbMinWage = config.nbMinWage ?? 15.65;
  const multiplier = config.otMultiplier ?? 1.5;
  const regularMinutes = Math.min(totalNetMinutes, threshold);
  const overtimeMinutes = Math.max(totalNetMinutes - threshold, 0);
  const overtimeRate = Math.round(nbMinWage * multiplier * 100) / 100;
  return { totalNetMinutes, regularMinutes, overtimeMinutes, nbMinWage, overtimeRate };
}

/**
 * Haversine distance in meters between two lat/lng points.
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Check if a point is within the shop geofence.
 * Returns null if lat/lng are missing.
 */
function isInGeofence(lat, lng, config) {
  if (lat == null || lng == null) return null;
  const shopLat = parseFloat(config.geofence_shop_lat);
  const shopLng = parseFloat(config.geofence_shop_lng);
  const radius = parseFloat(config.geofence_shop_radius_m);
  if (isNaN(shopLat) || isNaN(shopLng) || (shopLat === 0 && shopLng === 0)) return null; // coords not configured yet
  const dist = haversineMeters(lat, lng, shopLat, shopLng);
  return dist <= radius ? 1 : 0;
}

/**
 * Load app_config as key→value map.
 */
function loadConfig(db) {
  const rows = db.prepare('SELECT key, value FROM app_config').all();
  const config = {};
  for (const row of rows) config[row.key] = row.value;
  return config;
}

/**
 * Validate :week route param is a valid ISO date.
 * Returns the DateTime if valid, or null (after sending 400).
 */
function validateWeekParam(week, res) {
  const dt = DateTime.fromISO(week);
  if (!dt.isValid) {
    res.status(400).json({ error: 'Invalid week format — expected YYYY-MM-DD' });
    return null;
  }
  if (dt.weekday !== 1) {
    res.status(400).json({ error: 'Week must start on a Monday' });
    return null;
  }
  return dt;
}

/**
 * Build flag reasons array for a clock event.
 */
function buildFlagReasons({ mockDetected, speed, accuracy, inGeofence, maxSpeed, maxAccuracy }) {
  const reasons = [];
  if (mockDetected) reasons.push('mock_location');
  if (speed != null && maxSpeed != null && speed > parseFloat(maxSpeed)) reasons.push('high_speed');
  if (accuracy != null && maxAccuracy != null && accuracy > parseFloat(maxAccuracy)) reasons.push('accuracy_poor');
  if (inGeofence === 0) reasons.push('outside_geofence');
  return reasons;
}

// ════════════════════════════════════════════════════════════════
// Router factory
// ════════════════════════════════════════════════════════════════

export function createTimeRouter(getTimeDb) {
  const router = Router();
  const requireTimeAuth = createRequireTimeAuth(getTimeDb);

  // ── Magic link rate limiter ───────────────────────────────────
  const magicLinkAttempts = new Map();
  const ML_WINDOW_MS = 15 * 60 * 1000;
  const ML_MAX_PER_EMAIL = 3;

  // ── Verify code rate limiter ──────────────────────────────────
  const verifyAttempts = new Map();
  const VERIFY_WINDOW_MS = 15 * 60 * 1000;
  const VERIFY_MAX_PER_EMAIL = 10;

  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of magicLinkAttempts) {
      if (now - record.start >= ML_WINDOW_MS) magicLinkAttempts.delete(key);
    }
    for (const [key, record] of verifyAttempts) {
      if (now - record.start >= VERIFY_WINDOW_MS) verifyAttempts.delete(key);
    }
  }, 30 * 60 * 1000);

  // ════════════════════════════════════════════════════════════════
  // AUTH ROUTES
  // ════════════════════════════════════════════════════════════════

  // POST /auth/magic-link — request a magic link email
  router.post('/auth/magic-link', async (req, res) => {
    let db;
    try {
      const { email } = req.body;
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
      }
      const normalizedEmail = email.trim().toLowerCase();

      // Rate limit per email
      const now = Date.now();
      const key = normalizedEmail;
      const record = magicLinkAttempts.get(key);
      if (record && now - record.start < ML_WINDOW_MS) {
        if (record.count >= ML_MAX_PER_EMAIL) {
          return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
        }
        record.count++;
      } else {
        magicLinkAttempts.set(key, { start: now, count: 1 });
      }

      db = getTimeDb();
      const employee = db.prepare(
        'SELECT id, email FROM employees WHERE email = ? AND active = 1'
      ).get(normalizedEmail);

      // Always return success to prevent email enumeration
      if (!employee) {
        return res.json({ ok: true, message: 'If that email exists, a sign-in code has been sent.' });
      }

      const config = loadConfig(db);
      const expiryMin = parseInt(config.magic_link_expiry_minutes) || 15;

      const rawCode = generateCode();
      const tokenHash = hashToken(rawCode);
      const expiresAt = new Date(Date.now() + expiryMin * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO magic_links (employee_id, token_hash, expires_at, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?)
      `).run(employee.id, tokenHash, expiresAt, req.ip, req.get('user-agent') || null);

      auditLog(db, {
        actorId: employee.id,
        action: 'magic_link_requested',
        targetType: 'employee',
        targetId: employee.id,
        ipAddress: req.ip
      });

      // Send email — roll back DB row + rate-limit on failure
      try {
        await sendMagicCodeEmail(normalizedEmail, rawCode);
      } catch (emailErr) {
        db.prepare('DELETE FROM magic_links WHERE token_hash = ?').run(tokenHash);
        const rl = magicLinkAttempts.get(normalizedEmail);
        if (rl && rl.count > 0) rl.count--;
        console.error('Magic code email send failed:', emailErr.message);
        return res.status(502).json({ error: 'Failed to send sign-in email. Please try again.' });
      }

      res.json({ ok: true, message: 'If that email exists, a sign-in code has been sent.' });
    } catch (err) {
      console.error('POST /auth/magic-link error:', err.message);
      res.status(500).json({ error: 'Failed to process request' });
    } finally {
      db?.close();
    }
  });

  // POST /auth/verify-code — verify 6-char code, create session
  router.post('/auth/verify-code', (req, res) => {
    let db;
    try {
      const { email, code } = req.body;
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
      }
      if (!code || typeof code !== 'string' || code.trim().length !== 6) {
        return res.status(400).json({ error: 'A 6-character code is required' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const normalizedCode = code.trim().toUpperCase();

      if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/.test(normalizedCode) && normalizedCode !== DEV_BYPASS_CODE) {
        return res.status(400).json({ error: 'A 6-character code is required' });
      }

      // ── Dev bypass: DEV999 skips magic link lookup ──────────────
      if (IS_DEV && normalizedCode === DEV_BYPASS_CODE) {
        db = getTimeDb();
        const employee = db.prepare(
          'SELECT id, active FROM employees WHERE email = ? AND active = 1'
        ).get(normalizedEmail);
        if (!employee) {
          return res.status(400).json({ error: 'No active employee with that email' });
        }
        const sessionToken = generateToken();
        const sessionHash = hashToken(sessionToken);
        const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          INSERT INTO sessions (employee_id, token_hash, ip_address, user_agent, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(employee.id, sessionHash, req.ip, req.get('user-agent') || null, sessionExpiry);
        auditLog(db, {
          actorId: employee.id, action: 'login_dev_bypass',
          targetType: 'employee', targetId: employee.id, ipAddress: req.ip
        });
        const user = db.prepare(`
          SELECT id, employee_id AS employeeCode, email, role,
                 legal_given_name AS legalGivenName, legal_surname AS legalSurname,
                 display_name AS displayName, supervisor_id AS supervisorId,
                 department, job_title AS jobTitle
          FROM employees WHERE id = ?
        `).get(employee.id);
        setTimeSessionCookie(res, sessionToken, 30);
        console.log(`[DEV] Bypass login for ${normalizedEmail} (employee #${employee.id})`);
        return res.json({ ok: true, user });
      }

      // Rate limit per email — check only (increment after outcome is known)
      const now = Date.now();
      const vKey = normalizedEmail;
      const vRecord = verifyAttempts.get(vKey);
      if (vRecord && now - vRecord.start < VERIFY_WINDOW_MS) {
        if (vRecord.count >= VERIFY_MAX_PER_EMAIL) {
          return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
        }
      }

      db = getTimeDb();

      // Entire lookup → validate → mark-used → create-session in one transaction
      // to prevent TOCTOU race (two concurrent requests both seeing used=0)
      const result = db.transaction(() => {
        // Look up employee
        const employee = db.prepare(
          'SELECT id, active FROM employees WHERE email = ? AND active = 1'
        ).get(normalizedEmail);

        if (!employee) {
          return { error: 'Invalid code', status: 400 };
        }

        const config = loadConfig(db);
        const maxAttempts = parseInt(config.magic_code_max_attempts) || 5;

        // Check lock on the latest link BEFORE code-hash lookup
        const latestLink = db.prepare(`
          SELECT id, attempts FROM magic_links
          WHERE employee_id = ? AND used = 0
          ORDER BY created_at DESC LIMIT 1
        `).get(employee.id);

        if (!latestLink) {
          return { error: 'Invalid code', status: 400 };
        }

        if (latestLink.attempts >= maxAttempts) {
          return { error: 'Code has been locked. Request a new one.', status: 400, skipRateLimit: true };
        }

        const codeHash = hashToken(normalizedCode);

        // Look up magic_links by employee_id + token_hash
        // (no JOIN needed — employee.active was already confirmed = 1 above)
        const link = db.prepare(`
          SELECT * FROM magic_links
          WHERE employee_id = ? AND token_hash = ? AND used = 0
        `).get(employee.id, codeHash);

        if (!link) {
          // Increment attempts on the latest unused link
          db.prepare(
            'UPDATE magic_links SET attempts = attempts + 1 WHERE id = ?'
          ).run(latestLink.id);
          return { error: 'Invalid code', status: 400 };
        }

        if (new Date(link.expires_at) < new Date()) {
          return { error: 'Invalid code', status: 400 };
        }

        const sessionDays = parseInt(config.session_duration_days) || 30;

        const sessionToken = generateToken();
        const sessionHash = hashToken(sessionToken);
        const sessionExpiry = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();

        db.prepare(
          "UPDATE magic_links SET used = 1, used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
        ).run(link.id);

        db.prepare(`
          INSERT INTO sessions (employee_id, token_hash, ip_address, user_agent, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(link.employee_id, sessionHash, req.ip, req.get('user-agent') || null, sessionExpiry);

        auditLog(db, {
          actorId: link.employee_id,
          action: 'login',
          targetType: 'employee',
          targetId: link.employee_id,
          ipAddress: req.ip
        });

        const user = db.prepare(`
          SELECT id, employee_id AS employeeCode, email, role,
                 legal_given_name AS legalGivenName, legal_surname AS legalSurname,
                 display_name AS displayName, supervisor_id AS supervisorId,
                 department, job_title AS jobTitle
          FROM employees WHERE id = ?
        `).get(link.employee_id);

        return { ok: true, sessionToken, sessionDays, user };
      })();

      if (result.error) {
        // Only count genuine bad attempts against the rate limit
        if (!result.skipRateLimit) {
          const vCurrent = verifyAttempts.get(vKey);
          if (vCurrent && now - vCurrent.start < VERIFY_WINDOW_MS) {
            vCurrent.count++;
          } else {
            verifyAttempts.set(vKey, { start: now, count: 1 });
          }
        }
        return res.status(result.status).json({ error: result.error });
      }

      setTimeSessionCookie(res, result.sessionToken, result.sessionDays);
      res.json({ ok: true, user: result.user });
    } catch (err) {
      console.error('POST /auth/verify-code error:', err.message);
      res.status(500).json({ error: 'Verification failed' });
    } finally {
      db?.close();
    }
  });

  // POST /auth/logout — revoke session
  router.post('/auth/logout', requireTimeAuth, (req, res) => {
    let db;
    try {
      db = getTimeDb();
      db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(req.timeUser.sessionId);

      auditLog(db, {
        actorId: req.timeUser.id,
        action: 'logout',
        targetType: 'employee',
        targetId: req.timeUser.id,
        ipAddress: req.ip
      });

      clearTimeSessionCookie(res);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /auth/logout error:', err.message);
      res.status(500).json({ error: 'Logout failed' });
    } finally {
      db?.close();
    }
  });

  // GET /auth/me — current user from session
  router.get('/auth/me', requireTimeAuth, (req, res) => {
    res.json({ user: req.timeUser });
  });

  // ════════════════════════════════════════════════════════════════
  // CORE TIME TRACKING
  // ════════════════════════════════════════════════════════════════

  // GET /api/time/status — is the employee currently clocked in?
  router.get('/api/time/status', requireTimeAuth, (req, res) => {
    let db;
    try {
      db = getTimeDb();
      const entry = db.prepare(`
        SELECT * FROM time_entries
        WHERE employee_id = ? AND status = 'open'
      `).get(req.timeUser.id);

      res.json({
        clockedIn: !!entry,
        entry: entry || null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db?.close();
    }
  });

  // POST /api/time/clock-in — clock in with GPS
  router.post('/api/time/clock-in', requireTimeAuth, (req, res) => {
    let db;
    try {
      db = getTimeDb();
      const d = req.body;
      const config = loadConfig(db);

      // Check for existing open entry (belt + suspenders with unique index)
      const existing = db.prepare(
        "SELECT id FROM time_entries WHERE employee_id = ? AND status = 'open'"
      ).get(req.timeUser.id);
      if (existing) {
        return res.status(409).json({ error: 'Already clocked in', entryId: existing.id });
      }

      const now = new Date().toISOString();
      const clockInAt = now;
      const clockInGraceMs = (parseInt(config.rounding_clock_in_grace_min) || 5) * 60_000;
      const clockInRounded = roundClockIn(clockInAt, clockInGraceMs).toISOString();

      const localDate = getLocalDate(clockInAt);
      const localDow = getLocalDow(clockInAt);
      const payWeekStart = getPayWeekStart(clockInAt);

      const inGeofence = isInGeofence(d.lat, d.lng, config);

      const flagReasons = buildFlagReasons({
        mockDetected: d.mock_detected,
        speed: d.speed,
        accuracy: d.accuracy,
        inGeofence,
        maxSpeed: config.gps_max_speed_ms,
        maxAccuracy: config.gps_max_accuracy_m
      });

      const flagged = flagReasons.length > 0 ? 1 : 0;

      const result = db.prepare(`
        INSERT INTO time_entries (
          employee_id, pay_week_start, clock_in_local_date, clock_in_local_dow,
          clock_in_at, clock_in_rounded,
          clock_in_lat, clock_in_lng, clock_in_accuracy, clock_in_speed,
          clock_in_samples, clock_in_mock_detected, clock_in_in_geofence,
          clock_in_device_id,
          flagged, flag_reasons, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(
        req.timeUser.id, payWeekStart, localDate, localDow,
        clockInAt, clockInRounded,
        d.lat ?? null, d.lng ?? null, d.accuracy ?? null, d.speed ?? null,
        d.samples ?? null, d.mock_detected ? 1 : 0, inGeofence,
        d.device_id ?? null,
        flagged, flagReasons.length > 0 ? JSON.stringify(flagReasons) : null
      );

      auditLog(db, {
        actorId: req.timeUser.id,
        action: 'clock_in',
        targetType: 'time_entry',
        targetId: result.lastInsertRowid,
        details: { clockInAt, clockInRounded, payWeekStart, localDate, flagReasons },
        ipAddress: req.ip,
        deviceId: d.device_id
      });

      const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json({ ok: true, entry });
    } catch (err) {
      if (err.message?.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'Already clocked in' });
      }
      console.error('POST /api/time/clock-in error:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      db?.close();
    }
  });

  // POST /api/time/clock-out — clock out with GPS
  router.post('/api/time/clock-out', requireTimeAuth, (req, res) => {
    let db;
    try {
      db = getTimeDb();
      const d = req.body;
      const config = loadConfig(db);

      const entry = db.prepare(
        "SELECT * FROM time_entries WHERE employee_id = ? AND status = 'open'"
      ).get(req.timeUser.id);

      if (!entry) {
        return res.status(400).json({ error: 'Not currently clocked in' });
      }

      const now = new Date().toISOString();
      const clockOutAt = now;
      const clockOutGraceMs = (parseInt(config.rounding_clock_out_grace_min) || 10) * 60_000;
      const clockOutRounded = roundClockOut(clockOutAt, clockOutGraceMs).toISOString();

      const elapsed = elapsedMinutes(entry.clock_in_rounded, clockOutRounded);
      const lunch = lunchDeduction(elapsed, {
        lunchThreshold: parseInt(config.lunch_threshold_minutes) || 300,
        lunchDeductionMin: parseInt(config.lunch_deduction_minutes) || 30
      });
      const netMin = elapsed - lunch.minutes;

      const inGeofence = isInGeofence(d.lat, d.lng, config);

      // Merge flag reasons from clock-in + clock-out
      let existingFlags = [];
      if (entry.flag_reasons) {
        try { existingFlags = JSON.parse(entry.flag_reasons); } catch {}
      }
      const outFlags = buildFlagReasons({
        mockDetected: d.mock_detected,
        speed: d.speed,
        accuracy: d.accuracy,
        inGeofence,
        maxSpeed: config.gps_max_speed_ms,
        maxAccuracy: config.gps_max_accuracy_m
      });
      const allFlags = [...new Set([...existingFlags, ...outFlags])];
      const flagged = allFlags.length > 0 ? 1 : 0;

      db.prepare(`
        UPDATE time_entries SET
          clock_out_at = ?, clock_out_rounded = ?,
          clock_out_lat = ?, clock_out_lng = ?, clock_out_accuracy = ?,
          clock_out_speed = ?, clock_out_samples = ?,
          clock_out_mock_detected = ?, clock_out_in_geofence = ?,
          clock_out_device_id = ?,
          elapsed_minutes = ?, lunch_deducted = ?, lunch_minutes_deducted = ?,
          net_minutes = ?,
          lunch_override_requested = ?,
          employee_comment = ?,
          flagged = ?, flag_reasons = ?,
          status = 'closed'
        WHERE id = ?
      `).run(
        clockOutAt, clockOutRounded,
        d.lat ?? null, d.lng ?? null, d.accuracy ?? null,
        d.speed ?? null, d.samples ?? null,
        d.mock_detected ? 1 : 0, inGeofence,
        d.device_id ?? null,
        elapsed, lunch.deducted ? 1 : 0, lunch.minutes,
        netMin,
        d.lunch_override_requested ? 1 : 0,
        d.employee_comment ?? null,
        flagged, allFlags.length > 0 ? JSON.stringify(allFlags) : null,
        entry.id
      );

      auditLog(db, {
        actorId: req.timeUser.id,
        action: 'clock_out',
        targetType: 'time_entry',
        targetId: entry.id,
        details: { clockOutAt, clockOutRounded, elapsed, netMin, lunchDeducted: lunch.deducted },
        ipAddress: req.ip,
        deviceId: d.device_id
      });

      const updated = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(entry.id);
      res.json({ ok: true, entry: updated });
    } catch (err) {
      console.error('POST /api/time/clock-out error:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      db?.close();
    }
  });

  // GET /api/time/entries?from=&to= — time entries for date range
  router.get('/api/time/entries', requireTimeAuth, (req, res) => {
    let db;
    try {
      db = getTimeDb();
      const { from, to } = req.query;

      if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
        return res.status(400).json({ error: 'Invalid "from" date — expected YYYY-MM-DD' });
      }
      if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: 'Invalid "to" date — expected YYYY-MM-DD' });
      }

      let sql = `SELECT * FROM time_entries WHERE employee_id = ?`;
      const params = [req.timeUser.id];

      if (from) {
        sql += ` AND clock_in_local_date >= ?`;
        params.push(from);
      }
      if (to) {
        sql += ` AND clock_in_local_date <= ?`;
        params.push(to);
      }
      sql += ` ORDER BY clock_in_at DESC`;

      const entries = db.prepare(sql).all(...params);
      res.json({ entries, count: entries.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db?.close();
    }
  });

  // ════════════════════════════════════════════════════════════════
  // TIMESHEET + SYNC
  // ════════════════════════════════════════════════════════════════

  // GET /api/time/timesheet/:week — weekly summary with overtime
  router.get('/api/time/timesheet/:week', requireTimeAuth, (req, res) => {
    let db;
    try {
      const week = req.params.week; // YYYY-MM-DD (Monday)
      if (!validateWeekParam(week, res)) return;

      db = getTimeDb();
      const config = loadConfig(db);

      const summary = db.prepare(
        'SELECT * FROM v_weekly_hours WHERE employee_id = ? AND pay_week_start = ?'
      ).get(req.timeUser.id, week);

      if (!summary) {
        return res.json({
          week,
          summary: null,
          overtime: calculateOvertime(0, {
            thresholdMin: parseInt(config.nb_overtime_threshold_min) || 2640,
            nbMinWage: parseFloat(config.nb_minimum_wage) || 15.65,
            otMultiplier: parseFloat(config.nb_overtime_multiplier) || 1.5
          }),
          entries: []
        });
      }

      const overtime = calculateOvertime(summary.total_net_minutes, {
        thresholdMin: parseInt(config.nb_overtime_threshold_min) || 2640,
        nbMinWage: parseFloat(config.nb_minimum_wage) || 15.65,
        otMultiplier: parseFloat(config.nb_overtime_multiplier) || 1.5
      });

      const entries = db.prepare(`
        SELECT * FROM time_entries
        WHERE employee_id = ? AND pay_week_start = ?
        ORDER BY clock_in_at ASC
      `).all(req.timeUser.id, week);

      res.json({ week, summary, overtime, entries });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db?.close();
    }
  });

  // POST /api/time/sync — batch offline clock events
  router.post('/api/time/sync', requireTimeAuth, (req, res) => {
    let db;
    try {
      db = getTimeDb();
      const { events } = req.body;
      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'events array is required' });
      }
      if (events.length > MAX_SYNC_BATCH) {
        return res.status(400).json({ error: `Batch too large — maximum ${MAX_SYNC_BATCH} events per request` });
      }

      const config = loadConfig(db);
      const results = [];

      for (const event of events) {
        const { submission_uuid, event_type, payload } = event;

        if (!submission_uuid || !event_type || !payload) {
          results.push({ submission_uuid, status: 'failed', error: 'Missing required fields' });
          continue;
        }

        try {
          const processEvent = db.transaction(() => {
            // Atomic idempotency: INSERT OR IGNORE + check changes
            const insertResult = db.prepare(`
              INSERT OR IGNORE INTO sync_queue (submission_uuid, employee_id, event_type, payload, device_id, status)
              VALUES (?, ?, ?, ?, ?, 'processing')
            `).run(
              submission_uuid, req.timeUser.id, event_type,
              JSON.stringify(payload), payload.device_id ?? null
            );

            if (insertResult.changes === 0) {
              const existing = db.prepare(
                'SELECT status FROM sync_queue WHERE submission_uuid = ?'
              ).get(submission_uuid);
              return { duplicate: true, status: existing.status };
            }

            if (event_type === 'clock_in') {
              const clockInAt = payload.clock_in_at;
              if (!clockInAt || isNaN(new Date(clockInAt).getTime())) {
                throw new Error('clock_in_at is missing or not a valid ISO timestamp');
              }
              const clockInGraceMs = (parseInt(config.rounding_clock_in_grace_min) || 5) * 60_000;
              const clockInRounded = roundClockIn(clockInAt, clockInGraceMs).toISOString();
              const localDate = getLocalDate(clockInAt);
              const localDow = getLocalDow(clockInAt);
              const payWeekStart = getPayWeekStart(clockInAt);
              const inGeofence = isInGeofence(payload.lat, payload.lng, config);
              const flagReasons = buildFlagReasons({
                mockDetected: payload.mock_detected,
                speed: payload.speed,
                accuracy: payload.accuracy,
                inGeofence,
                maxSpeed: config.gps_max_speed_ms,
                maxAccuracy: config.gps_max_accuracy_m
              });

              db.prepare(`
                INSERT INTO time_entries (
                  employee_id, pay_week_start, clock_in_local_date, clock_in_local_dow,
                  clock_in_at, clock_in_rounded,
                  clock_in_lat, clock_in_lng, clock_in_accuracy, clock_in_speed,
                  clock_in_samples, clock_in_mock_detected, clock_in_in_geofence,
                  clock_in_device_id,
                  flagged, flag_reasons, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
              `).run(
                req.timeUser.id, payWeekStart, localDate, localDow,
                clockInAt, clockInRounded,
                payload.lat ?? null, payload.lng ?? null,
                payload.accuracy ?? null, payload.speed ?? null,
                payload.samples ?? null, payload.mock_detected ? 1 : 0,
                inGeofence, payload.device_id ?? null,
                flagReasons.length > 0 ? 1 : 0,
                flagReasons.length > 0 ? JSON.stringify(flagReasons) : null
              );
            } else if (event_type === 'clock_out') {
              const entry = db.prepare(
                "SELECT * FROM time_entries WHERE employee_id = ? AND status = 'open'"
              ).get(req.timeUser.id);

              if (!entry) throw new Error('No open clock-in found for clock-out');

              const clockOutAt = payload.clock_out_at;
              if (!clockOutAt || isNaN(new Date(clockOutAt).getTime())) {
                throw new Error('clock_out_at is missing or not a valid ISO timestamp');
              }
              const clockOutGraceMs = (parseInt(config.rounding_clock_out_grace_min) || 10) * 60_000;
              const clockOutRounded = roundClockOut(clockOutAt, clockOutGraceMs).toISOString();
              const elapsed = elapsedMinutes(entry.clock_in_rounded, clockOutRounded);

              if (elapsed <= 0) {
                throw new Error(`Invalid sync: clock_out (${clockOutAt}) is not after clock_in_rounded (${entry.clock_in_rounded})`);
              }

              const lunch = lunchDeduction(elapsed, {
                lunchThreshold: parseInt(config.lunch_threshold_minutes) || 300,
                lunchDeductionMin: parseInt(config.lunch_deduction_minutes) || 30
              });
              const netMin = elapsed - lunch.minutes;
              const inGeofence = isInGeofence(payload.lat, payload.lng, config);

              let existingFlags = [];
              if (entry.flag_reasons) {
                try { existingFlags = JSON.parse(entry.flag_reasons); } catch {}
              }
              const outFlags = buildFlagReasons({
                mockDetected: payload.mock_detected,
                speed: payload.speed,
                accuracy: payload.accuracy,
                inGeofence,
                maxSpeed: config.gps_max_speed_ms,
                maxAccuracy: config.gps_max_accuracy_m
              });
              const allFlags = [...new Set([...existingFlags, ...outFlags])];

              db.prepare(`
                UPDATE time_entries SET
                  clock_out_at = ?, clock_out_rounded = ?,
                  clock_out_lat = ?, clock_out_lng = ?, clock_out_accuracy = ?,
                  clock_out_speed = ?, clock_out_samples = ?,
                  clock_out_mock_detected = ?, clock_out_in_geofence = ?,
                  clock_out_device_id = ?,
                  elapsed_minutes = ?, lunch_deducted = ?, lunch_minutes_deducted = ?,
                  net_minutes = ?,
                  lunch_override_requested = ?,
                  employee_comment = ?,
                  flagged = ?, flag_reasons = ?,
                  status = 'closed'
                WHERE id = ?
              `).run(
                clockOutAt, clockOutRounded,
                payload.lat ?? null, payload.lng ?? null, payload.accuracy ?? null,
                payload.speed ?? null, payload.samples ?? null,
                payload.mock_detected ? 1 : 0, inGeofence,
                payload.device_id ?? null,
                elapsed, lunch.deducted ? 1 : 0, lunch.minutes,
                netMin,
                payload.lunch_override_requested ? 1 : 0,
                payload.employee_comment ?? null,
                allFlags.length > 0 ? 1 : 0,
                allFlags.length > 0 ? JSON.stringify(allFlags) : null,
                entry.id
              );
            }

            // Mark sync_queue as completed
            db.prepare(
              "UPDATE sync_queue SET status = 'completed', processed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE submission_uuid = ?"
            ).run(submission_uuid);

            return { duplicate: false };
          });

          const result = processEvent();
          if (result.duplicate) {
            results.push({ submission_uuid, status: result.status, error: 'Already processed' });
          } else {
            results.push({ submission_uuid, status: 'completed' });
          }
        } catch (eventErr) {
          // Mark as failed — only if the row was inserted (avoid race with duplicate)
          try {
            db.prepare(
              "UPDATE sync_queue SET status = 'failed', last_error = ? WHERE submission_uuid = ? AND status = 'processing'"
            ).run(eventErr.message, submission_uuid);
          } catch {}
          results.push({ submission_uuid, status: 'failed', error: eventErr.message });
        }
      }

      res.json({ results, processed: results.filter(r => r.status === 'completed').length });
    } catch (err) {
      console.error('POST /api/time/sync error:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      db?.close();
    }
  });

  // ════════════════════════════════════════════════════════════════
  // APPROVAL WORKFLOW
  // ════════════════════════════════════════════════════════════════

  // GET /api/time/approval/:week — approval screen data
  router.get('/api/time/approval/:week',
    requireTimeAuth,
    requireTimeRole('supervisor', 'manager', 'admin'),
    (req, res) => {
      let db;
      try {
        const week = req.params.week;
        if (!validateWeekParam(week, res)) return;

        db = getTimeDb();
        const user = req.timeUser;

        // Supervisors see only their assigned employees; manager/admin see all
        let employeeFilter;
        if (user.role === 'supervisor') {
          employeeFilter = db.prepare(
            'SELECT id FROM employees WHERE supervisor_id = ? AND active = 1'
          ).all(user.id).map(r => r.id);

          if (employeeFilter.length === 0) {
            return res.json({ week, employees: [], approval: null });
          }
        }

        let summaryQuery = `SELECT * FROM v_weekly_hours WHERE pay_week_start = ?`;
        const params = [week];

        if (employeeFilter) {
          const placeholders = employeeFilter.map(() => '?').join(',');
          summaryQuery += ` AND employee_id IN (${placeholders})`;
          params.push(...employeeFilter);
        }

        const summaries = db.prepare(summaryQuery).all(...params);

        // Get the approval record if it exists
        const approval = db.prepare(
          'SELECT * FROM timesheet_approvals WHERE supervisor_id = ? AND pay_week_start = ?'
        ).get(user.id, week);

        // Get detailed entries for each employee
        const employees = summaries.map(s => {
          const entries = db.prepare(`
            SELECT * FROM time_entries
            WHERE employee_id = ? AND pay_week_start = ?
            ORDER BY clock_in_at ASC
          `).all(s.employee_id, week);

          return { ...s, entries };
        });

        // Find employees with zero hours (active but no entries this week)
        // Supervisors: only their team; manager/admin: all active employees
        {
          const zeroQuery = user.role === 'supervisor'
            ? 'SELECT id, employee_id AS employee_code, legal_given_name, legal_surname FROM employees WHERE supervisor_id = ? AND active = 1'
            : 'SELECT id, employee_id AS employee_code, legal_given_name, legal_surname FROM employees WHERE active = 1';
          const zeroParams = user.role === 'supervisor' ? [user.id] : [];
          const allActive = db.prepare(zeroQuery).all(...zeroParams);
          // Check all statuses (open, closed, approved) — not just summaries (closed/approved)
          // so mid-shift employees aren't falsely listed as zero-hours
          const hasEntries = new Set(
            db.prepare(
              'SELECT DISTINCT employee_id FROM time_entries WHERE pay_week_start = ?'
            ).all(week).map(r => r.employee_id)
          );
          const zeroHours = allActive
            .filter(e => !hasEntries.has(e.id))
            .map(e => ({
              employee_id: e.id,
              employee_code: e.employee_code,
              employee_name: `${e.legal_given_name} ${e.legal_surname}`,
              pay_week_start: week,
              total_net_minutes: 0,
              total_hours: 0,
              entry_count: 0,
              flagged_count: 0,
              pending_lunch_overrides: 0,
              mon_minutes: 0, tue_minutes: 0, wed_minutes: 0, thu_minutes: 0,
              fri_minutes: 0, sat_minutes: 0, sun_minutes: 0,
              entries: []
            }));
          employees.push(...zeroHours);
        }

        res.json({ week, employees, approval });
      } catch (err) {
        res.status(500).json({ error: err.message });
      } finally {
        db?.close();
      }
    }
  );

  // POST /api/time/approval/:week/approve — approve timesheet
  router.post('/api/time/approval/:week/approve',
    requireTimeAuth,
    requireTimeRole('supervisor', 'manager', 'admin'),
    (req, res) => {
      let db;
      try {
        const week = req.params.week;
        if (!validateWeekParam(week, res)) return;

        db = getTimeDb();
        const user = req.timeUser;
        const { comment, zero_hours_comments } = req.body;
        if (zero_hours_comments !== undefined && !Array.isArray(zero_hours_comments)) {
          return res.status(400).json({ error: 'zero_hours_comments must be an array' });
        }
        const config = loadConfig(db);

        // Determine which employees this supervisor is approving
        let employeeIds;
        if (user.role === 'supervisor') {
          employeeIds = db.prepare(
            'SELECT id FROM employees WHERE supervisor_id = ? AND active = 1'
          ).all(user.id).map(r => r.id);
        } else {
          // manager/admin: approve the specified employees or all
          if (req.body.employee_ids) {
            if (!Array.isArray(req.body.employee_ids)
              || !req.body.employee_ids.every(id => Number.isInteger(id) && id > 0)) {
              return res.status(400).json({ error: 'employee_ids must be an array of positive integers' });
            }
            const placeholders = req.body.employee_ids.map(() => '?').join(',');
            const found = db.prepare(
              `SELECT id FROM employees WHERE id IN (${placeholders}) AND active = 1`
            ).all(...req.body.employee_ids).map(r => r.id);
            const invalid = req.body.employee_ids.filter(id => !found.includes(id));
            if (invalid.length > 0) {
              return res.status(400).json({ error: 'Unknown or inactive employee IDs', invalid_ids: invalid });
            }
            employeeIds = found;
          } else {
            employeeIds = db.prepare('SELECT id FROM employees WHERE active = 1').all().map(r => r.id);
          }
        }

        if (employeeIds.length === 0) {
          return res.status(400).json({ error: 'No employees to approve' });
        }

        // Block approval if any lunch overrides are still pending.
        // No status filter needed — lunch_override_requested is only set at clock-out
        // (status='closed'), so open entries never carry pending overrides.
        const pendingOverrides = db.prepare(`
          SELECT COUNT(*) AS cnt FROM time_entries
          WHERE employee_id IN (${employeeIds.map(() => '?').join(',')})
            AND pay_week_start = ?
            AND lunch_override_requested = 1
            AND lunch_override_approved IS NULL
        `).get(...employeeIds, week);

        if (pendingOverrides.cnt > 0) {
          return res.status(409).json({
            error: 'Cannot approve timesheet while lunch overrides are pending',
            pending_overrides: pendingOverrides.cnt
          });
        }

        // Validate zero-hours comments
        const summaries = db.prepare(`
          SELECT employee_id, SUM(COALESCE(net_minutes, 0)) as total
          FROM time_entries
          WHERE pay_week_start = ? AND status IN ('closed', 'approved')
            AND employee_id IN (${employeeIds.map(() => '?').join(',')})
          GROUP BY employee_id
        `).all(week, ...employeeIds);

        const totalByEmployee = new Map(summaries.map(s => [s.employee_id, s.total]));
        const zeroHoursEmployees = employeeIds.filter(id => !totalByEmployee.has(id) || totalByEmployee.get(id) === 0);

        if (zeroHoursEmployees.length > 0) {
          const comments = zero_hours_comments || [];
          const missing = zeroHoursEmployees.filter(id => {
            const entry = comments.find(c => c.employee_id === id);
            return !entry || !entry.comment || !String(entry.comment).trim();
          });
          if (missing.length > 0) {
            return res.status(400).json({
              error: 'Zero-hours comments required',
              missing_employee_ids: missing
            });
          }
        }

        const payWeekEnd = DateTime.fromISO(week).plus({ days: 6 }).toISODate();

        const approve = db.transaction(() => {
          // Create or update approval record
          const existing = db.prepare(
            'SELECT id FROM timesheet_approvals WHERE supervisor_id = ? AND pay_week_start = ?'
          ).get(user.id, week);

          let approvalId;
          if (existing) {
            db.prepare(`
              UPDATE timesheet_approvals SET
                status = 'approved',
                approved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                approved_comment = ?,
                zero_hours_comments = ?
              WHERE id = ?
            `).run(comment ?? null, zero_hours_comments ? JSON.stringify(zero_hours_comments) : null, existing.id);
            approvalId = existing.id;
          } else {
            const result = db.prepare(`
              INSERT INTO timesheet_approvals (supervisor_id, pay_week_start, pay_week_end, status, approved_at, approved_comment, zero_hours_comments)
              VALUES (?, ?, ?, 'approved', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, ?)
            `).run(user.id, week, payWeekEnd, comment ?? null, zero_hours_comments ? JSON.stringify(zero_hours_comments) : null);
            approvalId = result.lastInsertRowid;
          }

          // Update all closed entries for these employees to approved
          const placeholders = employeeIds.map(() => '?').join(',');
          db.prepare(`
            UPDATE time_entries SET status = 'approved', approval_id = ?
            WHERE pay_week_start = ? AND status = 'closed'
              AND employee_id IN (${placeholders})
          `).run(approvalId, week, ...employeeIds);

          // Create overtime calculations for each employee
          const nbMinWage = parseFloat(config.nb_minimum_wage) || 15.65;
          const otMultiplier = parseFloat(config.nb_overtime_multiplier) || 1.5;
          const otThreshold = parseInt(config.nb_overtime_threshold_min) || 2640;

          for (const empId of employeeIds) {
            const total = totalByEmployee.get(empId) || 0;
            const ot = calculateOvertime(total, {
              thresholdMin: otThreshold,
              nbMinWage,
              otMultiplier
            });

            db.prepare(`
              INSERT OR REPLACE INTO overtime_calculations
                (employee_id, pay_week_start, total_net_minutes, regular_minutes,
                 overtime_minutes, nb_minimum_wage, overtime_rate)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(empId, week, ot.totalNetMinutes, ot.regularMinutes,
              ot.overtimeMinutes, ot.nbMinWage, ot.overtimeRate);
          }

          auditLog(db, {
            actorId: user.id,
            action: 'approve_timesheet',
            targetType: 'approval',
            targetId: approvalId,
            details: { week, employeeCount: employeeIds.length },
            ipAddress: req.ip
          });

          return approvalId;
        });

        const approvalId = approve();

        res.json({ ok: true, approvalId });
      } catch (err) {
        console.error('POST /api/time/approval/:week/approve error:', err.message);
        res.status(500).json({ error: err.message });
      } finally {
        db?.close();
      }
    }
  );

  // POST /api/time/approval/:week/lunch-override/:entryId — approve/reject lunch override
  router.post('/api/time/approval/:week/lunch-override/:entryId',
    requireTimeAuth,
    requireTimeRole('supervisor', 'manager', 'admin'),
    (req, res) => {
      let db;
      try {
        const week = req.params.week;
        if (!validateWeekParam(week, res)) return;

        db = getTimeDb();
        const entryId = parseInt(req.params.entryId, 10);
        if (!Number.isInteger(entryId) || entryId <= 0) {
          return res.status(400).json({ error: 'entryId must be a positive integer' });
        }
        const { approved } = req.body; // true or false

        if (typeof approved !== 'boolean') {
          return res.status(400).json({ error: '"approved" boolean is required' });
        }

        const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(entryId);
        if (!entry) {
          return res.status(404).json({ error: 'Time entry not found' });
        }

        if (entry.pay_week_start !== week) {
          return res.status(400).json({ error: 'Entry does not belong to the specified pay week' });
        }

        // Supervisors can only approve overrides for their own team
        if (req.timeUser.role === 'supervisor') {
          const team = db.prepare(
            'SELECT id FROM employees WHERE supervisor_id = ? AND active = 1'
          ).all(req.timeUser.id).map(r => r.id);
          if (!team.includes(entry.employee_id)) {
            return res.status(403).json({ error: 'Entry does not belong to your team' });
          }
        }

        if (!entry.lunch_override_requested) {
          return res.status(400).json({ error: 'No lunch override was requested for this entry' });
        }

        if (entry.lunch_override_approved !== null) {
          return res.status(409).json({ error: 'Lunch override has already been processed' });
        }

        // Recalculate net_minutes if approved (remove lunch deduction)
        let newNetMinutes = entry.net_minutes;
        let newLunchDeducted = entry.lunch_deducted;
        let newLunchMinutes = entry.lunch_minutes_deducted;

        if (approved && entry.lunch_deducted) {
          newLunchDeducted = 0;
          newLunchMinutes = 0;
          newNetMinutes = entry.elapsed_minutes; // full elapsed, no lunch deduction
        }

        const applyOverride = db.transaction(() => {
          db.prepare(`
            UPDATE time_entries SET
              lunch_override_approved = ?,
              lunch_override_approved_by = ?,
              lunch_override_approved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              lunch_deducted = ?,
              lunch_minutes_deducted = ?,
              net_minutes = ?
            WHERE id = ?
          `).run(
            approved ? 1 : 0,
            req.timeUser.id,
            newLunchDeducted,
            newLunchMinutes,
            newNetMinutes,
            entryId
          );

          // Recalculate OT only when:
          // 1. Override approved (lunch deduction removed → net_minutes increased)
          // 2. Entry is closed/approved (open entries can't have lunch overrides — set at clock-out)
          // 3. An OT record already exists (created during weekly approval)
          // If no OT record exists yet, the weekly approval handler will compute OT
          // from the updated net_minutes, so no action is needed here.
          if (approved && entry.lunch_deducted && ['closed', 'approved'].includes(entry.status)) {
            const existingOT = db.prepare(
              'SELECT id FROM overtime_calculations WHERE employee_id = ? AND pay_week_start = ?'
            ).get(entry.employee_id, week);

            if (existingOT) {
              const sumRow = db.prepare(`
                SELECT COALESCE(SUM(net_minutes), 0) AS total
                FROM time_entries
                WHERE employee_id = ? AND pay_week_start = ? AND status IN ('closed', 'approved')
              `).get(entry.employee_id, week);

              const config = loadConfig(db);
              const nbMinWage = parseFloat(config.nb_minimum_wage) || 15.65;
              const otMultiplier = parseFloat(config.nb_overtime_multiplier) || 1.5;
              const otThreshold = parseInt(config.nb_overtime_threshold_min) || 2640;

              const ot = calculateOvertime(sumRow.total, {
                thresholdMin: otThreshold,
                nbMinWage,
                otMultiplier
              });

              db.prepare(`
                UPDATE overtime_calculations SET
                  total_net_minutes = ?, regular_minutes = ?,
                  overtime_minutes = ?, nb_minimum_wage = ?, overtime_rate = ?,
                  calculated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id = ?
              `).run(ot.totalNetMinutes, ot.regularMinutes,
                ot.overtimeMinutes, ot.nbMinWage, ot.overtimeRate, existingOT.id);
            }
          }

          auditLog(db, {
            actorId: req.timeUser.id,
            action: 'override_lunch',
            targetType: 'time_entry',
            targetId: entryId,
            details: { approved, previousNet: entry.net_minutes, newNet: newNetMinutes },
            ipAddress: req.ip
          });
        });
        applyOverride();

        const updated = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(entryId);
        res.json({ ok: true, entry: updated });
      } catch (err) {
        res.status(500).json({ error: err.message });
      } finally {
        db?.close();
      }
    }
  );

  // ════════════════════════════════════════════════════════════════
  // USER SETTINGS
  // ════════════════════════════════════════════════════════════════

  const CLOCKOUT_REMINDER_RE = /^(1[6-9]:(00|15|30|45)|20:00)$/;

  // GET /api/time/settings — current user's notification settings
  router.get('/api/time/settings', requireTimeAuth, (req, res) => {
    let db;
    try {
      db = getTimeDb();
      const row = db.prepare(
        'SELECT clockout_reminder_time, phone FROM employees WHERE id = ?'
      ).get(req.timeUser.id);

      res.json({
        clockout_reminder_time: row?.clockout_reminder_time ?? null,
        has_phone: !!row?.phone
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db?.close();
    }
  });

  // PUT /api/time/settings — update user's notification settings
  router.put('/api/time/settings', requireTimeAuth, (req, res) => {
    let db;
    try {
      const { clockout_reminder_time } = req.body;

      // Validate: must be null or a valid HH:MM in the 16:00–20:00 range
      if (clockout_reminder_time === undefined) {
        return res.status(400).json({
          error: 'clockout_reminder_time is required (use null to disable)'
        });
      }
      if (clockout_reminder_time !== null) {
        if (typeof clockout_reminder_time !== 'string' || !CLOCKOUT_REMINDER_RE.test(clockout_reminder_time)) {
          return res.status(400).json({
            error: 'clockout_reminder_time must be null or HH:MM between 16:00 and 20:00 in 15-minute increments'
          });
        }
      }

      db = getTimeDb();
      db.transaction(() => {
        db.prepare(
          'UPDATE employees SET clockout_reminder_time = ? WHERE id = ?'
        ).run(clockout_reminder_time ?? null, req.timeUser.id);

        auditLog(db, {
          actorId: req.timeUser.id,
          action: 'update_settings',
          targetType: 'employee',
          targetId: req.timeUser.id,
          details: { clockout_reminder_time: clockout_reminder_time ?? null },
          ipAddress: req.ip
        });
      })();

      res.json({ ok: true, clockout_reminder_time: clockout_reminder_time ?? null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db?.close();
    }
  });

  // ════════════════════════════════════════════════════════════════
  // NOTIFICATIONS — history for debugging
  // ════════════════════════════════════════════════════════════════

  const NOTIFICATION_TYPES = new Set([
    'missed_clock_out',
    'clockout_reminder',
    'approaching_overtime',
    'approaching_overtime_sup',
    'timesheet_reminder',
    'timesheet_escalation'
  ]);

  // GET /api/time/notifications — recent notification history
  router.get('/api/time/notifications',
    requireTimeAuth,
    requireTimeRole('manager', 'admin'),
    (req, res) => {
      let db;
      try {
        db = getTimeDb();
        const rawType = Array.isArray(req.query.type) ? req.query.type[0] : req.query.type;
        const type = (rawType && typeof rawType === 'string') ? rawType : null;
        const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
        const limit = Math.min(Math.max(parseInt(rawLimit) || 50, 1), 200);

        if (type && !NOTIFICATION_TYPES.has(type)) {
          return res.status(400).json({
            error: `Unknown notification type: ${type}. Valid: ${[...NOTIFICATION_TYPES].join(', ')}`
          });
        }

        let query = `
          SELECT n.id, n.employee_id, n.type, n.channel, n.payload, n.sent_at,
                 n.acknowledged_at, n.delivery_status, n.external_id, n.error,
                 n.reference_type, n.reference_id,
                 e.employee_id AS employee_code,
                 COALESCE(e.display_name, e.legal_given_name || ' ' || e.legal_surname, 'Employee ' || e.id) AS employee_name
          FROM notifications_sent n
          LEFT JOIN employees e ON e.id = n.employee_id
        `;
        const params = [];

        if (type) {
          query += ' WHERE n.type = ?';
          params.push(type);
        }

        query += ' ORDER BY n.sent_at DESC LIMIT ?';
        params.push(limit);

        const rows = db.prepare(query).all(...params);
        res.json({ notifications: rows, count: rows.length });
      } catch (err) {
        res.status(500).json({ error: err.message });
      } finally {
        db?.close();
      }
    }
  );

  // ════════════════════════════════════════════════════════════════
  // ADMIN — Employee management
  // ════════════════════════════════════════════════════════════════

  // GET /api/time/employees — active employees with supervisor info
  router.get('/api/time/employees',
    requireTimeAuth,
    requireTimeRole('supervisor', 'manager', 'admin'),
    (req, res) => {
      let db;
      try {
        db = getTimeDb();
        const isSupervisor = req.timeUser.role === 'supervisor';
        const columns = isSupervisor
          ? `e.id, e.employee_id, e.email, e.legal_given_name, e.legal_surname,
             e.display_name, e.role, e.supervisor_id, e.department, e.job_title, e.active`
          : 'e.*';
        const whereClause = isSupervisor
          ? 'WHERE e.active = 1 AND e.supervisor_id = ?'
          : 'WHERE e.active = 1';
        const queryParams = isSupervisor ? [req.timeUser.id] : [];
        const employees = db.prepare(`
          SELECT ${columns},
                 s.legal_given_name || ' ' || s.legal_surname AS supervisor_name,
                 s.employee_id AS supervisor_code
          FROM employees e
          LEFT JOIN employees s ON s.id = e.supervisor_id
          ${whereClause}
          ORDER BY e.legal_surname, e.legal_given_name
        `).all(...queryParams);

        res.json({ employees, count: employees.length });
      } catch (err) {
        res.status(500).json({ error: err.message });
      } finally {
        db?.close();
      }
    }
  );

  // PUT /api/time/employees/:id — partial update
  router.put('/api/time/employees/:id',
    requireTimeAuth,
    requireTimeRole('manager', 'admin'),
    (req, res) => {
      let db;
      try {
        db = getTimeDb();
        const empId = parseInt(req.params.id, 10);
        if (!Number.isInteger(empId) || empId <= 0) {
          return res.status(400).json({ error: 'Employee ID must be a positive integer' });
        }

        const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
        if (!existing) {
          return res.status(404).json({ error: 'Employee not found' });
        }

        const d = req.body;

        // Validate no self-supervisor
        const newSupervisorId = d.supervisor_id !== undefined ? d.supervisor_id : existing.supervisor_id;
        if (newSupervisorId === empId) {
          return res.status(400).json({ error: 'Employee cannot be their own supervisor' });
        }

        // Validate supervisor_id references an active employee
        if (newSupervisorId !== null && newSupervisorId !== existing.supervisor_id) {
          const supExists = db.prepare(
            'SELECT id FROM employees WHERE id = ? AND active = 1'
          ).get(newSupervisorId);
          if (!supExists) {
            return res.status(400).json({ error: 'supervisor_id does not refer to an active employee' });
          }
        }

        // Validate role if provided
        const validRoles = ['employee', 'supervisor', 'manager', 'accountant', 'admin'];
        if (d.role && !validRoles.includes(d.role)) {
          return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
        }

        db.prepare(`
          UPDATE employees SET
            email = ?, phone = ?,
            legal_given_name = ?, legal_surname = ?, display_name = ?,
            role = ?, supervisor_id = ?, department = ?, job_title = ?,
            hourly_rate = ?, active = ?
          WHERE id = ?
        `).run(
          d.email != null ? d.email.trim().toLowerCase() : existing.email,
          d.phone !== undefined ? d.phone : existing.phone,
          d.legal_given_name ?? existing.legal_given_name,
          d.legal_surname ?? existing.legal_surname,
          d.display_name !== undefined ? d.display_name : existing.display_name,
          d.role ?? existing.role,
          newSupervisorId,
          d.department !== undefined ? d.department : existing.department,
          d.job_title !== undefined ? d.job_title : existing.job_title,
          d.hourly_rate !== undefined ? d.hourly_rate : existing.hourly_rate,
          d.active !== undefined ? (d.active ? 1 : 0) : existing.active,
          empId
        );

        auditLog(db, {
          actorId: req.timeUser.id,
          action: 'edit_employee',
          targetType: 'employee',
          targetId: empId,
          details: { changes: d },
          ipAddress: req.ip
        });

        const updated = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
        res.json({ ok: true, employee: updated });
      } catch (err) {
        if (err.message?.includes('UNIQUE constraint failed: employees.email')) {
          return res.status(400).json({ error: 'That email address is already in use' });
        }
        res.status(500).json({ error: err.message });
      } finally {
        db?.close();
      }
    }
  );

  return router;
}
