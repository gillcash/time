/**
 * API client for time-app
 * All requests include credentials for HttpOnly session cookies
 */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

/**
 * Check API connectivity
 */
export async function checkApiConnection() {
  try {
    const r = await fetch(`${API_URL}/api/health`);
    if (!r.ok) return false;
    const d = await r.json();
    return d.ok === true;
  } catch {
    return false;
  }
}

/**
 * Submit a clock-in event
 */
export async function submitTimeEvent(eventData) {
  const endpoint = eventData.event_type === 'clock_in'
    ? '/api/time/clock-in'
    : '/api/time/clock-out';

  const r = await fetch(`${API_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(eventData)
  });

  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || `Time event failed: ${r.status}`);
  }

  return r.json();
}

/**
 * Fetch current clock-in status
 */
export async function fetchTimeStatus() {
  const r = await fetch(`${API_URL}/api/time/status`, {
    credentials: 'include'
  });

  if (!r.ok) throw new Error(`Failed to fetch status: ${r.status}`);
  return r.json();
}

/**
 * Fetch time entries for a date range
 */
export async function fetchTimeEntries(from, to) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const r = await fetch(`${API_URL}/api/time/entries?${params}`, {
    credentials: 'include'
  });

  if (!r.ok) throw new Error(`Failed to fetch entries: ${r.status}`);
  return r.json();
}

/**
 * Fetch employee list
 */
export async function fetchEmployees() {
  const r = await fetch(`${API_URL}/api/time/employees`, {
    credentials: 'include'
  });

  if (!r.ok) throw new Error(`Failed to fetch employees: ${r.status}`);
  const data = await r.json();

  return (data.results ?? []).map(row => ({
    id: row.id,
    employee_id: row.employee_id || '',
    display_name: row.display_name ||
      `${row.legal_given_name || ''} ${row.legal_surname || ''}`.trim() ||
      row.employee_id || `Employee ${row.id}`,
    legal_given_name: row.legal_given_name || '',
    legal_surname: row.legal_surname || '',
    email: row.email || '',
    role: row.role || 'employee',
    active: row.active !== false
  }));
}

/**
 * Fetch weekly timesheet summary with overtime
 */
export async function fetchTimesheet(week) {
  const r = await fetch(`${API_URL}/api/time/timesheet/${encodeURIComponent(week)}`, {
    credentials: 'include'
  });
  if (!r.ok) throw new Error(`Failed to fetch timesheet: ${r.status}`);
  return r.json();
}

/**
 * Fetch supervisor approval data for a pay week
 */
export async function fetchApprovalData(week) {
  const r = await fetch(`${API_URL}/api/time/approval/${encodeURIComponent(week)}`, {
    credentials: 'include'
  });

  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || `Failed to fetch approval data: ${r.status}`);
  }
  return r.json();
}

/**
 * Approve a weekly timesheet
 */
export async function approveTimesheet(week, body) {
  const r = await fetch(`${API_URL}/api/time/approval/${encodeURIComponent(week)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    const err = new Error(error.error || `Approval failed: ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/**
 * Approve or reject a lunch override for a specific entry
 */
export async function reviewLunchOverride(week, entryId, approved) {
  const r = await fetch(`${API_URL}/api/time/approval/${encodeURIComponent(week)}/lunch-override/${entryId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ approved })
  });

  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    const err = new Error(error.error || `Lunch override failed: ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/**
 * Batch sync offline clock events
 */
export async function syncTimeEvents(events) {
  const r = await fetch(`${API_URL}/api/time/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ events })
  });

  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || `Sync failed: ${r.status}`);
  }

  return r.json();
}

/**
 * Fetch current user's notification settings
 */
export async function fetchSettings() {
  const r = await fetch(`${API_URL}/api/time/settings`, {
    credentials: 'include'
  });
  if (!r.ok) throw new Error(`Failed to fetch settings: ${r.status}`);
  return r.json();
}

/**
 * Update current user's notification settings
 */
export async function updateSettings(body) {
  const r = await fetch(`${API_URL}/api/time/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || `Failed to update settings: ${r.status}`);
  }
  return r.json();
}
