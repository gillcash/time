/**
 * Time-app session auth — magic link flow with Resend email delivery.
 *
 * Uses:
 *   - crypto.randomBytes(32) for token generation (no Fizzy)
 *   - SHA-256 hash before storage (raw token only in email/cookie)
 *   - `time_session` cookie (30 days, HttpOnly)
 *   - Resend API via native fetch (console fallback when RESEND_API_KEY unset)
 */

import crypto from 'node:crypto';

const COOKIE_NAME = 'time_session';
const IS_DEV = process.env.NODE_ENV === 'development';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: !IS_DEV,
  sameSite: 'Lax',
  domain: process.env.COOKIE_DOMAIN || undefined,
  path: '/'
};

// ── Token helpers ──────────────────────────────────────────────

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 chars, no 0/O/1/I/L

export function generateCode(length = 6) {
  const limit = 256 - (256 % CODE_ALPHABET.length); // 248 for 31 chars
  let code = '';
  for (let i = 0; i < length; i++) {
    let byte;
    do { byte = crypto.randomBytes(1)[0]; } while (byte >= limit);
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

// ── Cookie helpers ─────────────────────────────────────────────

export function setTimeSessionCookie(res, rawToken, durationDays = 30) {
  res.cookie(COOKIE_NAME, rawToken, {
    ...COOKIE_OPTIONS,
    maxAge: durationDays * 24 * 60 * 60 * 1000
  });
}

export function clearTimeSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: 0 });
}

// ── Auth middleware ────────────────────────────────────────────

/**
 * Factory: creates middleware that reads the time_session cookie,
 * hashes it, looks up the session + employee, and sets req.timeUser.
 */
export function createRequireTimeAuth(getTimeDb) {
  return (req, res, next) => {
    const rawToken = req.cookies?.[COOKIE_NAME];
    if (!rawToken) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let db;
    try {
      const tokenHash = hashToken(rawToken);
      db = getTimeDb();

      const row = db.prepare(`
        SELECT s.id AS session_id, s.employee_id, s.expires_at, s.revoked,
               e.id, e.employee_id AS employee_code, e.email, e.role,
               e.legal_given_name, e.legal_surname, e.display_name,
               e.supervisor_id, e.department, e.job_title, e.active
        FROM sessions s
        JOIN employees e ON e.id = s.employee_id
        WHERE s.token_hash = ? AND s.revoked = 0
      `).get(tokenHash);

      if (!row) {
        return res.status(401).json({ error: 'Invalid or revoked session' });
      }

      if (new Date(row.expires_at) < new Date()) {
        return res.status(401).json({ error: 'Session expired' });
      }

      if (!row.active) {
        return res.status(401).json({ error: 'Account deactivated' });
      }

      // Update last_active_at (fire-and-forget)
      db.prepare(
        "UPDATE sessions SET last_active_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
      ).run(row.session_id);

      req.timeUser = {
        id: row.employee_id,
        sessionId: row.session_id,
        employeeCode: row.employee_code,
        email: row.email,
        role: row.role,
        legalGivenName: row.legal_given_name,
        legalSurname: row.legal_surname,
        displayName: row.display_name,
        supervisorId: row.supervisor_id,
        department: row.department,
        jobTitle: row.job_title
      };

      next();
    } catch (err) {
      console.error('requireTimeAuth error:', err.message);
      return res.status(500).json({ error: 'Authentication check failed' });
    } finally {
      db?.close();
    }
  };
}

/**
 * Role gate middleware — must be placed after requireTimeAuth.
 */
export function requireTimeRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.timeUser?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ── Resend email ───────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAILER_FROM = process.env.TIME_MAILER_FROM || 'noreply@example.com';

/**
 * Send a magic code email via Resend. Falls back to console.log when
 * RESEND_API_KEY is unset (dev/staging).
 */
export async function sendMagicCodeEmail(email, code) {
  if (!RESEND_API_KEY) {
    console.log('=== MAGIC CODE (no RESEND_API_KEY — console only) ===');
    console.log(`  To: ${email}`);
    console.log(`  Code: ${code}`);
    console.log('=====================================================');
    return { ok: true, fallback: true };
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: MAILER_FROM,
      to: [email],
      subject: `${process.env.APP_NAME || 'Time'} — Sign In Code`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h2 style="color: #181A1D; margin-bottom: 8px;">${process.env.APP_NAME || 'Time'}</h2>
          <p style="color: #555; margin-bottom: 24px;">Enter this code in the app to sign in. It expires in 15 minutes.</p>
          <div style="background: #f7f8fa; border: 2px solid #d8dce4; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #181A1D;">${code}</span>
          </div>
          <p style="color: #999; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error('Resend API error:', resp.status, body);
    throw new Error(`Failed to send sign-in code email: ${resp.status}`);
  }

  const data = await resp.json();
  return { ok: true, messageId: data.id };
}

// ── Audit log ──────────────────────────────────────────────────

/**
 * Insert an audit log entry.
 * @param {Database} db — open better-sqlite3 connection
 * @param {object} opts
 */
export function auditLog(db, { actorId, action, targetType, targetId, details, ipAddress, deviceId }) {
  db.prepare(`
    INSERT INTO audit_log (actor_id, action, target_type, target_id, details, ip_address, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorId ?? null,
    action,
    targetType ?? null,
    targetId ?? null,
    details ? JSON.stringify(details) : null,
    ipAddress ?? null,
    deviceId ?? null
  );
}
