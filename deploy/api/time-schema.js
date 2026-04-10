/**
 * Time-tracking database schema (SQLite).
 * Embeds the full schema SQL from docs/time-app-schema.sql (v1.1.0).
 * ensureTimeSchema() checks for the `employees` table — if absent, runs
 * the full schema DDL. Safe to call on every startup.
 */

// ── View DDL constants ─────────────────────────────────────────
// Single source of truth — used in SCHEMA_SQL and idempotent migrations.

// NOTE: This view intentionally includes ALL employees (active and terminated)
// so the approval endpoint can surface terminated employees' final approved
// timesheets for payroll. Consumers needing only active employees (e.g.
// notification-engine) filter at the query level with JOIN employees ... AND active = 1.
const V_WEEKLY_HOURS_SQL = `CREATE VIEW v_weekly_hours AS
SELECT
    te.employee_id,
    e.employee_id   AS employee_code,
    COALESCE(e.display_name, e.legal_given_name || ' ' || e.legal_surname, 'Employee ' || e.id) AS employee_name,
    e.supervisor_id,
    te.pay_week_start,
    COUNT(te.id)                                    AS entry_count,
    SUM(CASE WHEN te.net_minutes IS NOT NULL THEN te.net_minutes ELSE 0 END) AS total_net_minutes,
    ROUND(SUM(CASE WHEN te.net_minutes IS NOT NULL THEN te.net_minutes ELSE 0 END) / 60.0, 2) AS total_hours,
    SUM(CASE WHEN te.flagged = 1 THEN 1 ELSE 0 END) AS flagged_count,
    SUM(CASE WHEN te.lunch_override_requested = 1 AND te.lunch_override_approved IS NULL THEN 1 ELSE 0 END)
                                                    AS pending_lunch_overrides,
    SUM(CASE WHEN te.clock_in_local_dow = 1 THEN COALESCE(te.net_minutes, 0) ELSE 0 END) AS mon_minutes,
    SUM(CASE WHEN te.clock_in_local_dow = 2 THEN COALESCE(te.net_minutes, 0) ELSE 0 END) AS tue_minutes,
    SUM(CASE WHEN te.clock_in_local_dow = 3 THEN COALESCE(te.net_minutes, 0) ELSE 0 END) AS wed_minutes,
    SUM(CASE WHEN te.clock_in_local_dow = 4 THEN COALESCE(te.net_minutes, 0) ELSE 0 END) AS thu_minutes,
    SUM(CASE WHEN te.clock_in_local_dow = 5 THEN COALESCE(te.net_minutes, 0) ELSE 0 END) AS fri_minutes,
    SUM(CASE WHEN te.clock_in_local_dow = 6 THEN COALESCE(te.net_minutes, 0) ELSE 0 END) AS sat_minutes,
    SUM(CASE WHEN te.clock_in_local_dow = 0 THEN COALESCE(te.net_minutes, 0) ELSE 0 END) AS sun_minutes
FROM time_entries te
JOIN employees e ON e.id = te.employee_id
WHERE te.status IN ('closed', 'approved')
GROUP BY te.employee_id, te.pay_week_start`;

const V_ACTIVE_CLOCKS_SQL = `CREATE VIEW v_active_clocks AS
SELECT
    te.id           AS entry_id,
    te.employee_id,
    e.employee_id   AS employee_code,
    COALESCE(e.display_name, e.legal_given_name || ' ' || e.legal_surname, 'Employee ' || e.id) AS employee_name,
    te.clock_in_at,
    te.clock_in_rounded,
    te.clock_in_in_geofence,
    te.clock_in_lat,
    te.clock_in_lng,
    CAST((julianday('now') - julianday(te.clock_in_at)) * 24 * 60 AS INTEGER) AS minutes_elapsed,
    te.flagged,
    te.flag_reasons
FROM time_entries te
JOIN employees e ON e.id = te.employee_id
WHERE te.status = 'open' AND e.active = 1`;

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

-- 1. EMPLOYEES
CREATE TABLE employees (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id         TEXT    NOT NULL UNIQUE,
    email               TEXT    NOT NULL UNIQUE,
    phone               TEXT,
    legal_given_name    TEXT    NOT NULL,
    legal_surname       TEXT    NOT NULL,
    display_name        TEXT,
    role                TEXT    NOT NULL DEFAULT 'employee'
                        CHECK (role IN ('employee', 'supervisor', 'manager', 'accountant', 'admin')),
    supervisor_id       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    department          TEXT,
    job_title           TEXT,
    hourly_rate         REAL,
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    CHECK (supervisor_id IS NULL OR supervisor_id != id)
);

CREATE INDEX idx_employees_supervisor   ON employees(supervisor_id) WHERE active = 1;
CREATE INDEX idx_employees_role         ON employees(role)          WHERE active = 1;
CREATE INDEX idx_employees_email        ON employees(email);

-- 2. MAGIC LINKS
CREATE TABLE magic_links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    token_hash      TEXT    NOT NULL,
    expires_at      TEXT    NOT NULL,
    used            INTEGER NOT NULL DEFAULT 0,
    used_at         TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    ip_address      TEXT,
    user_agent      TEXT
);

CREATE INDEX idx_magic_links_employee_token ON magic_links(employee_id, token_hash) WHERE used = 0;
CREATE INDEX idx_magic_links_employee       ON magic_links(employee_id);

-- 3. SESSIONS
CREATE TABLE sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    token_hash      TEXT    NOT NULL UNIQUE,
    device_id       TEXT,
    ip_address      TEXT,
    user_agent      TEXT,
    expires_at      TEXT    NOT NULL,
    revoked         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_active_at  TEXT
);

CREATE INDEX idx_sessions_token     ON sessions(token_hash) WHERE revoked = 0;
CREATE INDEX idx_sessions_employee  ON sessions(employee_id) WHERE revoked = 0;

-- 4. TIME ENTRIES
CREATE TABLE time_entries (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id                 INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    pay_week_start              TEXT    NOT NULL CHECK (strftime('%w', pay_week_start) = '1'),
    clock_in_local_date         TEXT    NOT NULL,
    clock_in_local_dow          INTEGER NOT NULL,

    clock_in_at                 TEXT    NOT NULL,
    clock_in_rounded            TEXT    NOT NULL,
    clock_in_lat                REAL,
    clock_in_lng                REAL,
    clock_in_accuracy           REAL,
    clock_in_speed              REAL,
    clock_in_samples            INTEGER,
    clock_in_mock_detected      INTEGER DEFAULT 0,
    clock_in_in_geofence        INTEGER,
    clock_in_device_id          TEXT,

    clock_out_at                TEXT,
    clock_out_rounded           TEXT,
    clock_out_lat               REAL,
    clock_out_lng               REAL,
    clock_out_accuracy          REAL,
    clock_out_speed             REAL,
    clock_out_samples           INTEGER,
    clock_out_mock_detected     INTEGER,
    clock_out_in_geofence       INTEGER,
    clock_out_device_id         TEXT,

    elapsed_minutes             INTEGER,
    lunch_deducted              INTEGER NOT NULL DEFAULT 0,
    lunch_minutes_deducted      INTEGER NOT NULL DEFAULT 0,
    net_minutes                 INTEGER,

    lunch_override_requested    INTEGER NOT NULL DEFAULT 0,
    lunch_override_approved     INTEGER,
    lunch_override_approved_by  INTEGER REFERENCES employees(id),
    lunch_override_approved_at  TEXT,

    employee_comment            TEXT,
    supervisor_comment          TEXT,
    supervisor_edited           INTEGER NOT NULL DEFAULT 0,
    supervisor_edited_by        INTEGER REFERENCES employees(id),
    supervisor_edited_at        TEXT,

    flagged                     INTEGER NOT NULL DEFAULT 0,
    flag_reasons                TEXT,

    approval_id                 INTEGER REFERENCES timesheet_approvals(id),

    status                      TEXT    NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'closed', 'approved', 'disputed')),
    created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_time_entries_employee_week  ON time_entries(employee_id, pay_week_start);
CREATE INDEX idx_time_entries_status         ON time_entries(status, pay_week_start);
CREATE INDEX idx_time_entries_open           ON time_entries(employee_id, status) WHERE status = 'open';
CREATE INDEX idx_time_entries_week           ON time_entries(pay_week_start);
CREATE UNIQUE INDEX idx_one_open_entry ON time_entries(employee_id) WHERE status = 'open';

-- 5. TIMESHEET APPROVALS
CREATE TABLE timesheet_approvals (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    supervisor_id       INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    pay_week_start      TEXT    NOT NULL CHECK (strftime('%w', pay_week_start) = '1'),
    pay_week_end        TEXT    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'escalated')),
    approved_at         TEXT,
    approved_comment    TEXT,
    escalated_at        TEXT,
    escalated_to        INTEGER REFERENCES employees(id),
    escalated_approved_at TEXT,
    escalated_approved_by INTEGER REFERENCES employees(id),
    csv_sent_at         TEXT,
    pdf_sent_at         TEXT,
    zero_hours_comments TEXT,
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(supervisor_id, pay_week_start)
);

CREATE INDEX idx_approvals_week     ON timesheet_approvals(pay_week_start, status);
CREATE INDEX idx_approvals_pending  ON timesheet_approvals(status) WHERE status = 'pending';

-- 6. OVERTIME CALCULATIONS
CREATE TABLE overtime_calculations (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id             INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    pay_week_start          TEXT    NOT NULL,
    total_net_minutes       INTEGER NOT NULL,
    regular_minutes         INTEGER NOT NULL,
    overtime_minutes        INTEGER NOT NULL DEFAULT 0,
    nb_minimum_wage         REAL    NOT NULL,
    overtime_rate           REAL    NOT NULL,
    calculated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(employee_id, pay_week_start)
);

CREATE INDEX idx_overtime_week ON overtime_calculations(pay_week_start);

-- 7. NOTIFICATIONS SENT
CREATE TABLE notifications_sent (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id     INTEGER REFERENCES employees(id),
    type            TEXT    NOT NULL,
    channel         TEXT    NOT NULL
                    CHECK (channel IN ('push', 'sms', 'email')),
    recipient       TEXT,
    payload         TEXT,
    sent_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    acknowledged_at TEXT,
    delivery_status TEXT    CHECK (delivery_status IN ('delivered', 'failed', 'pending', 'console')),
    external_id     TEXT,
    error           TEXT,
    reference_type  TEXT,
    reference_id    INTEGER
);

CREATE INDEX idx_notifications_employee ON notifications_sent(employee_id, type, sent_at);
CREATE INDEX idx_notifications_type     ON notifications_sent(type, sent_at);
CREATE INDEX idx_notifications_dedup    ON notifications_sent(employee_id, type, reference_type, reference_id);

-- 8. SYNC QUEUE
CREATE TABLE sync_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_uuid TEXT    NOT NULL UNIQUE,
    employee_id     INTEGER NOT NULL REFERENCES employees(id),
    event_type      TEXT    NOT NULL
                    CHECK (event_type IN ('clock_in', 'clock_out')),
    payload         TEXT    NOT NULL,
    device_id       TEXT,
    status          TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    retry_count     INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    processed_at    TEXT
);

CREATE INDEX idx_sync_queue_status ON sync_queue(status) WHERE status IN ('pending', 'failed');

-- 9. AUDIT LOG
CREATE TABLE audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id        INTEGER REFERENCES employees(id),
    action          TEXT    NOT NULL,
    target_type     TEXT,
    target_id       INTEGER,
    details         TEXT,
    ip_address      TEXT,
    device_id       TEXT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_audit_log_actor    ON audit_log(actor_id, created_at);
CREATE INDEX idx_audit_log_target   ON audit_log(target_type, target_id);
CREATE INDEX idx_audit_log_action   ON audit_log(action, created_at);
CREATE INDEX idx_audit_log_created  ON audit_log(created_at);

-- 10. APP CONFIG
CREATE TABLE app_config (
    key             TEXT    PRIMARY KEY,
    value           TEXT    NOT NULL,
    description     TEXT,
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_by      INTEGER REFERENCES employees(id)
);

INSERT INTO app_config (key, value, description) VALUES
('geofence_shop_lat',           '45.763042153388085', 'Shop geofence center latitude'),
('geofence_shop_lng',           '-64.74843858746247', 'Shop geofence center longitude'),
('geofence_shop_radius_m',      '150',              'Shop geofence radius in meters'),
('gps_sample_count',            '5',                'Number of GPS readings to capture per event'),
('gps_sample_interval_ms',      '1000',             'Milliseconds between GPS readings'),
('gps_max_accuracy_m',          '65',               'Max accuracy threshold'),
('gps_max_speed_ms',            '2.5',              'Speed threshold (m/s) for drive-by detection'),
('rounding_clock_in_grace_min', '5',                'Clock-in grace period'),
('rounding_clock_out_grace_min','10',               'Clock-out grace period'),
('lunch_threshold_minutes',     '300',              'Elapsed minutes threshold for auto lunch deduction'),
('lunch_deduction_minutes',     '30',               'Minutes deducted for lunch'),
('nb_overtime_threshold_min',   '2640',             'Weekly overtime threshold in minutes (44 hours)'),
('nb_minimum_wage',             '15.65',            'NB minimum wage (CAD/hr) as of Apr 2025'),
('nb_overtime_multiplier',      '1.5',              'Overtime rate multiplier'),
('approval_deadline_day',       'tuesday',          'Day of week for approval deadline'),
('approval_deadline_hour',      '11',               'Hour (24h) for approval deadline'),
('approval_reminder_hour',      '10',               'Hour (24h) for supervisor SMS reminder'),
('approval_escalation_hour',    '12',               'Hour (24h) for manager escalation SMS'),
('session_duration_days',       '30',               'Magic link session duration in days'),
('magic_link_expiry_minutes',   '15',               'Magic link token expiry in minutes'),
('open_entry_alert_hours',      '10',               'Hours before open clock-in triggers missed clock-out alert'),
('overtime_warning_minutes',    '2400',             'Minutes (40 hrs) approaching OT threshold'),
('company_name',                'Time', 'Company name for reports'),
('accountant_email',            '',                  'Email for payroll delivery (UPDATE)'),
('timezone',                    'America/Moncton',  'IANA timezone for local date/time calculations');

-- VIEWS

${V_WEEKLY_HOURS_SQL};

${V_ACTIVE_CLOCKS_SQL};

-- TRIGGERS

CREATE TRIGGER trg_employees_updated_at
AFTER UPDATE ON employees
WHEN OLD.updated_at = NEW.updated_at
BEGIN
    UPDATE employees SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER trg_time_entries_updated_at
AFTER UPDATE ON time_entries
WHEN OLD.updated_at = NEW.updated_at
BEGIN
    UPDATE time_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER trg_approvals_updated_at
AFTER UPDATE ON timesheet_approvals
WHEN OLD.updated_at = NEW.updated_at
BEGIN
    UPDATE timesheet_approvals SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = NEW.id;
END;
`;

// ── View migration helper ────────────────────────────────────
// Drops and recreates a view if any required fragment is missing from its DDL.

function ensureViewCurrent(db, viewName, viewSQL, requiredFragments, label) {
  const info = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='view' AND name=?"
  ).get(viewName);
  if (info && requiredFragments.some(frag => !info.sql.includes(frag))) {
    db.transaction(() => {
      db.exec(`DROP VIEW IF EXISTS ${viewName}`);
      db.exec(viewSQL);
    })();
    console.log(`ensureTimeSchema: migrated ${viewName} view (${label})`);
  }
}

/**
 * Ensure the time-tracking schema exists in time.db.
 * Checks for the app_config table (last table in DDL) — if absent, runs the
 * full schema in an explicit transaction so a crash can't leave partial state.
 * @param {function} getTimeDb — factory that returns a better-sqlite3 Database
 */
export function ensureTimeSchema(getTimeDb) {
  const db = getTimeDb();
  try {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='app_config'"
    ).get();

    if (!exists) {
      db.transaction(() => db.exec(SCHEMA_SQL))();
      console.log('ensureTimeSchema: time.db schema created (v1.1.0)');
    } else {
      console.log('ensureTimeSchema: time.db schema already exists');
    }

    // Seed dev admin if NODE_ENV=development and no employees exist yet
    if (process.env.NODE_ENV === 'development') {
      const count = db.prepare('SELECT COUNT(*) AS c FROM employees').get();
      if (count.c === 0) {
        db.prepare(`
          INSERT INTO employees (employee_id, email, legal_given_name, legal_surname, display_name, role, department, job_title, hourly_rate)
          VALUES ('DEV-001', 'admin@dev.local', 'Dev', 'Admin', 'Dev Admin', 'admin', 'Development', 'Administrator', 25.00)
        `).run();
        console.log('ensureTimeSchema: seeded dev admin (admin@dev.local)');
      }
    }

    // Idempotent migration: ensure notifications_sent exists even on DBs
    // created before Phase 6 (where app_config exists but this table doesn't)
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications_sent (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id     INTEGER REFERENCES employees(id),
        type            TEXT    NOT NULL,
        channel         TEXT    NOT NULL CHECK (channel IN ('push', 'sms', 'email')),
        recipient       TEXT,
        payload         TEXT,
        sent_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        acknowledged_at TEXT,
        delivery_status TEXT    CHECK (delivery_status IN ('delivered', 'failed', 'pending', 'console')),
        external_id     TEXT,
        error           TEXT,
        reference_type  TEXT,
        reference_id    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_employee ON notifications_sent(employee_id, type, sent_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_type     ON notifications_sent(type, sent_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_dedup    ON notifications_sent(employee_id, type, reference_type, reference_id);
    `);

    // Idempotent migration: add 'console' to delivery_status CHECK constraint
    // for DBs created before this fix (SQLite requires table recreation to alter CHECK).
    // CREATE TABLE IF NOT EXISTS above ensures the table exists for new databases
    // (with 'console' already in the CHECK constraint). For existing databases where
    // the table predates the 'console' status, the IF NOT EXISTS is a no-op and the
    // migration below detects the missing constraint and recreates the table.
    const tableInfo = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications_sent'"
    ).get();
    if (tableInfo && !tableInfo.sql.includes("'console'")) {
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS notifications_sent_new;');
        db.exec(`
          CREATE TABLE notifications_sent_new (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id     INTEGER REFERENCES employees(id),
            type            TEXT    NOT NULL,
            channel         TEXT    NOT NULL CHECK (channel IN ('push', 'sms', 'email')),
            recipient       TEXT,
            payload         TEXT,
            sent_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            acknowledged_at TEXT,
            delivery_status TEXT    CHECK (delivery_status IN ('delivered', 'failed', 'pending', 'console')),
            external_id     TEXT,
            error           TEXT,
            reference_type  TEXT,
            reference_id    INTEGER
          );
          INSERT INTO notifications_sent_new
            (id, employee_id, type, channel, recipient, payload, sent_at,
             acknowledged_at, delivery_status, external_id, error,
             reference_type, reference_id)
          SELECT
             id, employee_id, type, channel, recipient, payload, sent_at,
             acknowledged_at, delivery_status, external_id, error,
             reference_type, reference_id
          FROM notifications_sent;
          DROP TABLE notifications_sent;
          ALTER TABLE notifications_sent_new RENAME TO notifications_sent;
          CREATE INDEX IF NOT EXISTS idx_notifications_employee ON notifications_sent(employee_id, type, sent_at);
          CREATE INDEX IF NOT EXISTS idx_notifications_type     ON notifications_sent(type, sent_at);
          CREATE INDEX IF NOT EXISTS idx_notifications_dedup    ON notifications_sent(employee_id, type, reference_type, reference_id);
        `);
      })();
      console.log('ensureTimeSchema: migrated notifications_sent CHECK constraint (added console)');
    }

    // Idempotent migration: add attempts column to magic_links + compound index for code auth
    try {
      db.exec('ALTER TABLE magic_links ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
      console.log('ensureTimeSchema: added attempts column to magic_links');
    } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
    // Drop old token-only index, create compound employee+token index
    db.exec('DROP INDEX IF EXISTS idx_magic_links_token');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_magic_links_employee_token
      ON magic_links(employee_id, token_hash) WHERE used = 0
    `);
    // Config key for max code verification attempts
    db.prepare(`
      INSERT OR IGNORE INTO app_config (key, value, description)
      VALUES ('magic_code_max_attempts', '5', 'Max wrong code guesses before a code is locked')
    `).run();

    // Idempotent migration: rebuild magic_links to drop column-level UNIQUE on token_hash.
    // Pre-code-auth schema had "token_hash TEXT NOT NULL UNIQUE"; fresh CREATE TABLE (line 90)
    // no longer has it, but the earlier migration only added columns/indexes. SQLite can't
    // ALTER TABLE DROP CONSTRAINT, so we rebuild the table.
    // Regex is anchored to token_hash so a UNIQUE on any other column won't false-positive.
    const mlInfo = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='magic_links'"
    ).get();
    if (mlInfo && /token_hash\s+TEXT[^,)]*\bUNIQUE\b/i.test(mlInfo.sql)) {
      db.transaction(() => {
        db.exec('ALTER TABLE magic_links RENAME TO magic_links_old');
        db.exec(`
          CREATE TABLE magic_links (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            token_hash      TEXT    NOT NULL,
            expires_at      TEXT    NOT NULL,
            used            INTEGER NOT NULL DEFAULT 0,
            used_at         TEXT,
            attempts        INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            ip_address      TEXT,
            user_agent      TEXT
          )
        `);
        db.exec(`
          INSERT INTO magic_links
            (id, employee_id, token_hash, expires_at, used, used_at, attempts, created_at, ip_address, user_agent)
          SELECT
            id, employee_id, token_hash, expires_at, used, used_at, attempts, created_at, ip_address, user_agent
          FROM magic_links_old
        `);
        db.exec('DROP TABLE magic_links_old');
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_magic_links_employee_token
          ON magic_links(employee_id, token_hash) WHERE used = 0
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_magic_links_employee
          ON magic_links(employee_id)
        `);
      })();
      console.log('ensureTimeSchema: rebuilt magic_links to drop UNIQUE on token_hash');
    }

    // Idempotent migration: add clockout_reminder_time column to employees
    // Stores HH:MM (24h) for per-employee daily clock-out reminder, NULL = disabled
    try {
      db.exec('ALTER TABLE employees ADD COLUMN clockout_reminder_time TEXT');
      console.log('ensureTimeSchema: added clockout_reminder_time column to employees');
    } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }

    ensureViewCurrent(db, 'v_active_clocks', V_ACTIVE_CLOCKS_SQL,
      ['e.active', "'Employee '"], 'added active = 1 filter');
    ensureViewCurrent(db, 'v_weekly_hours', V_WEEKLY_HOURS_SQL,
      ['display_name', "'Employee '"], 'COALESCE display_name');
  } finally {
    db.close();
  }
}
