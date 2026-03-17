/**
 * Notification Engine — outbound SMS via Twilio for time-tracking alerts.
 *
 * Checks run every 15 minutes (via setInterval in server.js):
 *   1. Missed clock-outs (open entries exceeding open_entry_alert_hours)
 *   2. Approaching overtime (weekly hours ≥ overtime_warning_minutes)
 *   3. Timesheet approval reminders (Tuesday morning for supervisors)
 *   4. Timesheet approval escalations (Tuesday noon for managers/admins)
 *
 * Each check is deduped via the notifications_sent table to prevent repeat SMS.
 * Console fallback when TWILIO_ACCOUNT_SID is unset (dev/staging).
 */

import { DateTime } from 'luxon';

const TZ = 'America/Moncton';
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || '';

// ── Twilio SMS wrapper ────────────────────────────────────────

async function sendSms(to, body) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    const missing = !TWILIO_SID ? 'TWILIO_ACCOUNT_SID' : !TWILIO_TOKEN ? 'TWILIO_AUTH_TOKEN' : 'TWILIO_PHONE_NUMBER';
    console.log(`=== SMS (missing ${missing} — console only) ===`);
    console.log(`  To: ${to.replace(/\d(?=\d{4})/g, '*')}`);
    console.log(`  Body: ${body}`);
    console.log('===================================================');
    return { ok: true, sid: null, fallback: true };
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000)
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('Twilio API error:', resp.status, data.message || data);
      return { ok: false, sid: null, error: data.message || `HTTP ${resp.status}` };
    }

    return { ok: true, sid: data.sid, error: null };
  } catch (err) {
    console.error('Twilio send failed:', err.message);
    return { ok: false, sid: null, error: err.message };
  }
}

// ── Dedup helper ──────────────────────────────────────────────

function isDuplicate(db, employeeId, type, refType, refId) {
  // Check for a prior successful (or pending) send with the same dedup key
  // 'console' = logged to console only (no Twilio creds) — non-blocking like 'failed'
  const existing = db.prepare(`
    SELECT id FROM notifications_sent
    WHERE employee_id = ? AND type = ? AND reference_type = ? AND reference_id = ?
      AND delivery_status NOT IN ('failed', 'console')
  `).get(employeeId, type, refType, refId);

  if (existing) return true;

  // Allow up to 3 failed retries per dedup key in 24h to prevent infinite loops
  const failedCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM notifications_sent
    WHERE employee_id = ? AND type = ? AND reference_type = ? AND reference_id = ?
      AND delivery_status IN ('failed', 'console')
      AND sent_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours')
  `).get(employeeId, type, refType, refId);

  return failedCount.cnt >= 3;
}

// ── Record helper ─────────────────────────────────────────────

function recordNotification(db, { employeeId, type, channel, recipient, payload, deliveryStatus, externalId, error, referenceType, referenceId }) {
  db.prepare(`
    INSERT INTO notifications_sent
      (employee_id, type, channel, recipient, payload, delivery_status, external_id, error, reference_type, reference_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    employeeId, type, channel ?? 'sms', recipient, payload,
    deliveryStatus, externalId ?? null, error ?? null,
    referenceType ?? null, referenceId ?? null
  );
}

// ── Config helpers ────────────────────────────────────────────

function configInt(val, fallback) {
  const n = parseInt(val);
  return Number.isFinite(n) ? n : fallback;
}

function configFloat(val, fallback) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(db) {
  const rows = db.prepare('SELECT key, value FROM app_config').all();
  const config = {};
  for (const row of rows) config[row.key] = row.value;
  return config;
}

// ── Formatting helpers ────────────────────────────────────────

function minutesToHours(mins) {
  return Math.round(mins / 60 * 10) / 10;
}

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function isDeadlineDay(config, now) {
  const deadlineDay = (config.approval_deadline_day || 'tuesday').toLowerCase();
  const targetDow = DAY_NAMES.indexOf(deadlineDay) + 1;
  if (targetDow === 0) {
    console.warn(
      `[notifications] Invalid approval_deadline_day: "${deadlineDay}". Expected: ${DAY_NAMES.join(', ')}`
    );
    return false;
  }
  return now.weekday === targetDow;
}

// ── Date/epoch helpers ───────────────────────────────────────

function getWeekEpoch(isoDate) {
  return Math.floor(DateTime.fromISO(isoDate, { zone: TZ }).toMillis() / 1000);
}

function formatWeekLabel(isoDate) {
  return DateTime.fromISO(isoDate, { zone: TZ }).toFormat('LLL d');
}

// ── Unapproved-supervisors query ─────────────────────────────

function getUnapprovedSupervisors(db, payWeekStart) {
  return db.prepare(`
    SELECT id, phone,
           COALESCE(display_name, legal_given_name || ' ' || legal_surname, 'Supervisor ' || id) AS name
    FROM employees
    WHERE role = 'supervisor' AND active = 1
      AND id IN (
        SELECT DISTINCT supervisor_id FROM employees
        WHERE supervisor_id IS NOT NULL AND active = 1
      )
      AND id NOT IN (
        SELECT supervisor_id FROM timesheet_approvals
        WHERE pay_week_start = ? AND status = 'approved'
          AND supervisor_id IS NOT NULL
      )
  `).all(payWeekStart);
}

// ── Send + Record helper ──────────────────────────────────────

async function sendAndRecord(db, { employeeId, phone, type, body, referenceType, referenceId, error: errorOverride }) {
  if (isDuplicate(db, employeeId, type, referenceType, referenceId)) return;

  if (!phone) {
    recordNotification(db, {
      employeeId, type, recipient: null, payload: null,
      deliveryStatus: 'failed', error: errorOverride || 'no_phone',
      referenceType, referenceId
    });
    return;
  }

  const result = await sendSms(phone, body);
  recordNotification(db, {
    employeeId, type, recipient: phone, payload: body,
    deliveryStatus: result.ok ? (result.fallback ? 'console' : 'delivered') : 'failed',
    externalId: result.sid, error: result.error,
    referenceType, referenceId
  });
}

// ── Check: Missed clock-outs ──────────────────────────────────

async function checkMissedClockOuts(getTimeDb) {
  let db;
  try {
    db = getTimeDb();
    const config = loadConfig(db);
    const alertHours = configFloat(config.open_entry_alert_hours, 10);
    const alertMinutes = alertHours * 60;

    const openEntries = db.prepare(`
      SELECT entry_id, employee_id, employee_name, minutes_elapsed
      FROM v_active_clocks
      WHERE minutes_elapsed > ?
    `).all(alertMinutes);

    // Group by employee, keeping the longest-elapsed entry (defense-in-depth;
    // idx_one_open_entry prevents duplicates at the DB level)
    const byEmployee = new Map();
    for (const entry of openEntries) {
      if (!byEmployee.has(entry.employee_id) ||
          entry.minutes_elapsed > byEmployee.get(entry.employee_id).minutes_elapsed) {
        byEmployee.set(entry.employee_id, entry);
      }
    }

    for (const entry of byEmployee.values()) {
      const emp = db.prepare('SELECT phone FROM employees WHERE id = ?').get(entry.employee_id);
      const hours = minutesToHours(entry.minutes_elapsed);
      await sendAndRecord(db, {
        employeeId: entry.employee_id,
        phone: emp?.phone,
        type: 'missed_clock_out',
        body: `${process.env.APP_NAME || 'Time'}: You've been clocked in for ${hours}h. Forgot to clock out?`,
        referenceType: 'time_entry',
        referenceId: entry.entry_id
      });
    }
  } finally {
    db?.close();
  }
}

// ── Check: Approaching overtime ───────────────────────────────

async function checkApproachingOvertime(getTimeDb) {
  let db;
  try {
    db = getTimeDb();
    const config = loadConfig(db);
    const warningMinutes = configInt(config.overtime_warning_minutes, 2400);
    const otThresholdHours = Math.round(configInt(config.nb_overtime_threshold_min, 2640) / 60);
    const now = DateTime.now().setZone(TZ);
    const payWeekStart = now.startOf('week').toISODate(); // Monday

    // Get completed hours from v_weekly_hours
    const weeklyRows = db.prepare(`
      SELECT wh.employee_id, wh.employee_name, wh.supervisor_id, wh.total_net_minutes,
             e.phone AS employee_phone,
             s.phone AS supervisor_phone
      FROM v_weekly_hours wh
      JOIN employees e ON e.id = wh.employee_id
      LEFT JOIN employees s ON s.id = wh.supervisor_id
      WHERE wh.pay_week_start = ?
        AND e.active = 1
    `).all(payWeekStart);

    // Also check for currently open entries to add in-progress time
    // Query time_entries directly (not v_active_clocks) to filter by pay week —
    // stale open entries from prior weeks would inflate this week's hours
    const openEntries = db.prepare(`
      SELECT employee_id,
             CAST((julianday('now') - julianday(clock_in_at)) * 24 * 60 AS INTEGER) AS minutes_elapsed
      FROM time_entries
      WHERE status = 'open' AND pay_week_start = ?
        AND employee_id IN (SELECT id FROM employees WHERE active = 1)
    `).all(payWeekStart);
    const openMinutesByEmployee = new Map();
    for (const oe of openEntries) {
      openMinutesByEmployee.set(oe.employee_id, (openMinutesByEmployee.get(oe.employee_id) || 0) + oe.minutes_elapsed);
    }

    // Disputed entries have net_minutes but aren't in v_weekly_hours (which only counts closed/approved)
    const disputedEntries = db.prepare(`
      SELECT employee_id, net_minutes AS minutes_elapsed
      FROM time_entries
      WHERE status = 'disputed' AND net_minutes IS NOT NULL AND pay_week_start = ?
        AND employee_id IN (SELECT id FROM employees WHERE active = 1)
    `).all(payWeekStart);
    const disputedMinutesByEmployee = new Map();
    for (const de of disputedEntries) {
      disputedMinutesByEmployee.set(de.employee_id, (disputedMinutesByEmployee.get(de.employee_id) || 0) + de.minutes_elapsed);
    }

    // Use the epoch seconds of the pay week start as the dedup reference_id
    const weekEpoch = getWeekEpoch(payWeekStart);

    for (const row of weeklyRows) {
      const openExtra = openMinutesByEmployee.get(row.employee_id) || 0;
      const disputedExtra = disputedMinutesByEmployee.get(row.employee_id) || 0;
      const effectiveMinutes = row.total_net_minutes + openExtra + disputedExtra;

      if (effectiveMinutes < warningMinutes) continue;

      const hours = minutesToHours(effectiveMinutes);
      const empBody = `${process.env.APP_NAME || 'Time'}: You are at ${hours}h this week, approaching ${otThresholdHours}h OT threshold.`;
      const supBody = `${process.env.APP_NAME || 'Time'}: ${row.employee_name} is at ${hours}h this week, approaching ${otThresholdHours}h OT threshold.`;

      // SMS to employee
      await sendAndRecord(db, {
        employeeId: row.employee_id,
        phone: row.employee_phone,
        type: 'approaching_overtime',
        body: empBody,
        referenceType: 'pay_week',
        referenceId: weekEpoch
      });

      // SMS to supervisor (skip if employee is their own supervisor)
      if (row.supervisor_id && row.supervisor_id !== row.employee_id) {
        await sendAndRecord(db, {
          employeeId: row.supervisor_id,
          phone: row.supervisor_phone,
          type: 'approaching_overtime_sup',
          body: supBody,
          referenceType: `pay_week:${row.employee_id}`,
          referenceId: weekEpoch
        });
      }
    }

    // Also check employees with only open entries (no closed/approved entries yet this week)
    // NOTE: employees with ONLY disputed entries (no open/closed/approved) are not covered —
    // that edge case (all entries disputed, zero other entries) is extremely rare
    const weeklyEmployeeIds = new Set(weeklyRows.map(r => r.employee_id));
    for (const [employeeId, openMins] of openMinutesByEmployee) {
      if (weeklyEmployeeIds.has(employeeId)) continue; // already checked
      const disputedMins = disputedMinutesByEmployee.get(employeeId) || 0;
      const totalMins = openMins + disputedMins;
      if (totalMins < warningMinutes) continue;

      const emp = db.prepare(
        `SELECT id, phone, COALESCE(display_name, legal_given_name || ' ' || legal_surname, 'Employee ' || id) AS name, supervisor_id
         FROM employees WHERE id = ?`
      ).get(employeeId);
      if (!emp) {
        console.warn(`[notifications] approaching_overtime: employee ${employeeId} not found in employees table`);
        await sendAndRecord(db, {
          employeeId, phone: null,
          type: 'approaching_overtime',
          body: '',
          referenceType: 'pay_week', referenceId: weekEpoch,
          error: 'employee_not_found'
        });
        continue;
      }
      const hours = minutesToHours(totalMins);

      const empBody = `${process.env.APP_NAME || 'Time'}: You are at ${hours}h this week, approaching ${otThresholdHours}h OT threshold.`;
      const supBody = `${process.env.APP_NAME || 'Time'}: ${emp.name} is at ${hours}h this week, approaching ${otThresholdHours}h OT threshold.`;

      // SMS to employee
      await sendAndRecord(db, {
        employeeId, phone: emp?.phone,
        type: 'approaching_overtime',
        body: empBody,
        referenceType: 'pay_week', referenceId: weekEpoch
      });

      // SMS to supervisor (skip if employee is their own supervisor)
      if (emp?.supervisor_id && emp.supervisor_id !== employeeId) {
        const sup = db.prepare('SELECT id, phone FROM employees WHERE id = ?').get(emp.supervisor_id);
        await sendAndRecord(db, {
          employeeId: sup?.id ?? emp.supervisor_id,
          phone: sup?.phone,
          type: 'approaching_overtime_sup',
          body: supBody,
          referenceType: `pay_week:${employeeId}`, referenceId: weekEpoch,
          ...(sup === undefined ? { error: 'supervisor_not_found' } : {})
        });
      }
    }
  } finally {
    db?.close();
  }
}

// ── Check: Timesheet approval reminder (Tuesday morning) ──────

async function checkTimesheetReminder(getTimeDb) {
  let db;
  try {
    db = getTimeDb();
    const config = loadConfig(db);
    const now = DateTime.now().setZone(TZ);

    if (!isDeadlineDay(config, now)) return;

    const reminderHour = configInt(config.approval_reminder_hour, 10);
    const escalationHour = configInt(config.approval_escalation_hour, 12);
    if (reminderHour >= escalationHour) {
      console.warn(`[notifications] approval_reminder_hour (${reminderHour}) must be < approval_escalation_hour (${escalationHour}). Skipping reminder.`);
      return;
    }
    if (now.hour < reminderHour || now.hour >= escalationHour) return;

    // Previous pay week = last Monday
    const prevWeekStart = now.startOf('week').minus({ weeks: 1 }).toISODate();
    const weekEpoch = getWeekEpoch(prevWeekStart);

    const supervisors = getUnapprovedSupervisors(db, prevWeekStart);
    const weekLabel = formatWeekLabel(prevWeekStart);

    for (const sup of supervisors) {
      await sendAndRecord(db, {
        employeeId: sup.id,
        phone: sup.phone,
        type: 'timesheet_reminder',
        body: `${process.env.APP_NAME || 'Time'}: Timesheets for week of ${weekLabel} need your approval by noon today.`,
        referenceType: 'pay_week',
        referenceId: weekEpoch
      });
    }
  } finally {
    db?.close();
  }
}

// ── Check: Timesheet approval escalation (Tuesday noon) ───────

async function checkTimesheetEscalation(getTimeDb) {
  let db;
  try {
    db = getTimeDb();
    const config = loadConfig(db);
    const now = DateTime.now().setZone(TZ);

    if (!isDeadlineDay(config, now)) return;

    const escalationHour = configInt(config.approval_escalation_hour, 12);
    const escalationCutoffHour = 18;
    if (escalationHour >= escalationCutoffHour) {
      console.warn(`[notifications] approval_escalation_hour (${escalationHour}) must be < ${escalationCutoffHour}. Skipping escalation.`);
      return;
    }
    if (now.hour < escalationHour || now.hour >= escalationCutoffHour) return;

    const prevWeekStart = now.startOf('week').minus({ weeks: 1 }).toISODate();
    const weekEpoch = getWeekEpoch(prevWeekStart);

    const unapproved = getUnapprovedSupervisors(db, prevWeekStart);

    if (unapproved.length === 0) return;

    const nameList = unapproved.map(s => s.name).join(', ');
    const weekLabel = formatWeekLabel(prevWeekStart);

    // SMS to all managers and admins
    const managers = db.prepare(`
      SELECT id, phone FROM employees
      WHERE role IN ('manager', 'admin') AND active = 1
    `).all();

    for (const mgr of managers) {
      // Keep under 160 chars (1 SMS segment) where possible
      const shortBody = `${process.env.APP_NAME || 'Time'}: Unapproved timesheets (${weekLabel}): ${nameList}. Please follow up.`;
      const longBody = `${process.env.APP_NAME || 'Time'}: ${unapproved.length} supervisors have unapproved timesheets for week of ${weekLabel}.`;
      const body = shortBody.length <= 160 ? shortBody : longBody;

      await sendAndRecord(db, {
        employeeId: mgr.id,
        phone: mgr.phone,
        type: 'timesheet_escalation',
        body,
        referenceType: 'pay_week',
        referenceId: weekEpoch
      });
    }
  } finally {
    db?.close();
  }
}

// ── Orchestrator ──────────────────────────────────────────────

export async function runNotificationCycle(getTimeDb) {
  console.log(`[notifications] cycle starting at ${new Date().toISOString()}`);
  const checks = [
    ['missed_clock_out', checkMissedClockOuts],
    ['approaching_overtime', checkApproachingOvertime],
    ['timesheet_reminder', checkTimesheetReminder],
    ['timesheet_escalation', checkTimesheetEscalation]
  ];

  for (const [name, fn] of checks) {
    try {
      await fn(getTimeDb);
    } catch (err) {
      console.error(`[notifications] ${name} check failed:`, err.message);
    }
  }

  console.log(`[notifications] cycle complete at ${new Date().toISOString()}`);
}
