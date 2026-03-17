import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { DateTime } from 'luxon';
import { fetchApprovalData, approveTimesheet, reviewLunchOverride } from '../lib/api';
import { getPayWeekStart, toLocal } from '../lib/timezone';
import { isOnline } from '../app';
import { showToast } from '../components/Toast';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_KEYS = ['mon_minutes', 'tue_minutes', 'wed_minutes', 'thu_minutes', 'fri_minutes', 'sat_minutes', 'sun_minutes'];
const FLAG_LABELS = { mock_location: 'Mock GPS', high_speed: 'High Speed', outside_geofence: 'Off-site', accuracy_poor: 'Low Accuracy' };
const FLAG_CLASSES = { mock_location: 'mock-gps', high_speed: 'high-speed', outside_geofence: 'off-site', accuracy_poor: 'low-accuracy' };

function parseFlags(flagReasons) {
  if (!flagReasons) return [];
  try {
    const parsed = JSON.parse(flagReasons);
    return Array.isArray(parsed) ? parsed.filter(f => typeof f === 'string') : [];
  } catch { return []; }
}

function fmtTime(iso) {
  if (!iso) return '\u2014';
  return toLocal(iso).toFormat('h:mma').toLowerCase();
}

function fmtMinutes(min) {
  if (min == null || min === 0) return '0h';
  return (min / 60).toFixed(2) + 'h';
}

// Chevron SVG
function Chevron({ open }) {
  return (
    <svg class={`ap-emp-chevron ${open ? 'open' : ''}`} width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// Single entry detail row
function EntryDetail({ entry, overrideLoading, onOverride }) {
  const flags = parseFlags(entry.flag_reasons);
  const entryDate = entry.clock_in_local_date
    ? DateTime.fromISO(entry.clock_in_local_date).toFormat('EEE, MMM d')
    : '\u2014';
  const hasFlags = flags.length > 0;
  const hasPendingOverride = !!entry.lunch_override_requested && entry.lunch_override_approved === null;
  const overrideResolved = !!entry.lunch_override_requested && entry.lunch_override_approved !== null;
  const isLoading = overrideLoading[entry.id];

  return (
    <div class={`ap-entry ${hasFlags ? 'has-flags' : ''}`}>
      <div class="ap-entry-date">{entryDate}</div>

      <div class="ap-entry-times">
        <div class="ap-entry-time-pair">
          <span class="ap-entry-label">Raw</span>
          <span class="ap-entry-value">{fmtTime(entry.clock_in_at)} – {fmtTime(entry.clock_out_at)}</span>
        </div>
        <div class="ap-entry-time-pair">
          <span class="ap-entry-label">Rounded</span>
          <span class="ap-entry-value">{fmtTime(entry.rounded_clock_in)} – {fmtTime(entry.rounded_clock_out)}</span>
        </div>
      </div>

      <div class="ap-entry-hours">
        <span>
          <span class="ap-entry-label">Elapsed</span>
          <span class="ap-entry-value">{fmtMinutes(entry.elapsed_minutes)}</span>
        </span>
        <span class="ap-entry-divider">·</span>
        <span>
          <span class="ap-entry-label">Lunch</span>
          <span class="ap-entry-value">{entry.lunch_deducted ? `-${entry.lunch_minutes_deducted || 30}m` : 'None'}</span>
        </span>
        <span class="ap-entry-divider">·</span>
        <span>
          <span class="ap-entry-label">Net</span>
          <span class="ap-entry-net">{fmtMinutes(entry.net_minutes)}</span>
        </span>
      </div>

      {entry.employee_comment && (
        <div class="ap-entry-comment">
          <span class="ap-entry-label">Note</span>
          <span class="ap-entry-comment-text">{entry.employee_comment}</span>
        </div>
      )}

      {hasFlags && (
        <div class="ap-entry-flags">
          {flags.map((flag, i) => (
            <span key={i} class={`ap-flag ${FLAG_CLASSES[flag] || ''}`}>
              {FLAG_LABELS[flag] || flag}
            </span>
          ))}
        </div>
      )}

      {(entry.clock_in_in_geofence === 0 || entry.clock_out_in_geofence === 0) && (
        <div class="ap-entry-coords">
          {entry.clock_in_in_geofence === 0 && entry.clock_in_lat && entry.clock_in_lng && (
            <a
              class="ap-coord-link"
              href={`https://www.google.com/maps?q=${entry.clock_in_lat},${entry.clock_in_lng}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span class="ap-entry-label">In</span>
              {entry.clock_in_lat.toFixed(5)}, {entry.clock_in_lng.toFixed(5)}
            </a>
          )}
          {entry.clock_out_in_geofence === 0 && entry.clock_out_lat && entry.clock_out_lng && (
            <a
              class="ap-coord-link"
              href={`https://www.google.com/maps?q=${entry.clock_out_lat},${entry.clock_out_lng}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span class="ap-entry-label">Out</span>
              {entry.clock_out_lat.toFixed(5)}, {entry.clock_out_lng.toFixed(5)}
            </a>
          )}
        </div>
      )}

      {hasPendingOverride && (
        <div class="ap-lunch-override">
          <span class="ap-override-label">Lunch override requested</span>
          <button
            class="ap-override-btn approve"
            disabled={isLoading}
            onClick={() => onOverride(entry.id, true)}
            aria-label="Approve lunch override"
          >
            {isLoading ? '\u2026' : '\u2713'}
          </button>
          <button
            class="ap-override-btn reject"
            disabled={isLoading}
            onClick={() => onOverride(entry.id, false)}
            aria-label="Reject lunch override"
          >
            {isLoading ? '\u2026' : '\u2717'}
          </button>
        </div>
      )}

      {overrideResolved && (
        <div class={`ap-override-resolved ${entry.lunch_override_approved ? 'approved' : 'rejected'}`}>
          Lunch override {entry.lunch_override_approved ? 'approved' : 'rejected'}
        </div>
      )}
    </div>
  );
}

// Employee accordion card
function EmployeeRow({ emp, expanded, onToggle, zeroComment, onZeroComment, overrideLoading, onOverride, isApproved }) {
  const isZero = emp.total_net_minutes === 0;
  const isFlagged = emp.flagged_count > 0;
  const hasPendingOverrides = emp.pending_lunch_overrides > 0;

  return (
    <div class={`ap-emp-card ${isZero ? 'zero-hours' : ''} ${isFlagged ? 'flagged' : ''}`}>
      <button class="ap-emp-header" onClick={onToggle} aria-expanded={expanded}>
        <div class="ap-emp-header-left">
          <span class="ap-emp-name">{emp.employee_name || `Employee ${emp.employee_id}`}</span>
          <div class="ap-emp-badges">
            {isFlagged && <span class="ap-badge flags">{emp.flagged_count} flag{emp.flagged_count !== 1 ? 's' : ''}</span>}
            {hasPendingOverrides && <span class="ap-badge overrides">{emp.pending_lunch_overrides} override{emp.pending_lunch_overrides !== 1 ? 's' : ''}</span>}
          </div>
        </div>

        {/* Desktop day cells */}
        <div class="ap-emp-days">
          {DAY_KEYS.map((key, i) => {
            const mins = emp[key] || 0;
            return (
              <div key={i} class={`ap-day-cell ${mins === 0 ? 'zero' : ''}`}>
                <div class="ap-day-label">{DAYS[i]}</div>
                <div>{fmtMinutes(mins)}</div>
              </div>
            );
          })}
        </div>

        <span class="ap-emp-total">{fmtMinutes(emp.total_net_minutes)}</span>
        <Chevron open={expanded} />
      </button>

      {/* Zero hours warning — always visible */}
      {isZero && !isApproved && (
        <div class="ap-zero-hours">
          <div class="ap-zero-label">Zero hours — comment required</div>
          <input
            type="text"
            class="form-input ap-zero-input"
            placeholder="Reason for zero hours (e.g. vacation, leave)..."
            value={zeroComment || ''}
            onInput={(e) => onZeroComment(emp.employee_id, e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Expanded entries */}
      {expanded && emp.entries && emp.entries.length > 0 && (
        <div class="ap-entries">
          {/* Mobile day summary */}
          <div class="ap-emp-days-mobile">
            {DAY_KEYS.map((key, i) => {
              const mins = emp[key] || 0;
              return (
                <div key={i} class={`ap-day-cell ${mins === 0 ? 'zero' : ''}`}>
                  <div class="ap-day-label">{DAYS[i]}</div>
                  <div>{fmtMinutes(mins)}</div>
                </div>
              );
            })}
          </div>
          {emp.entries.map(entry => (
            <EntryDetail
              key={entry.id}
              entry={entry}
              overrideLoading={overrideLoading}
              onOverride={onOverride}
            />
          ))}
        </div>
      )}

      {expanded && (!emp.entries || emp.entries.length === 0) && (
        <div class="ap-entries">
          <div class="ap-entry">
            <span class="ap-entry-label">No entries this week</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Main screen
export function ApprovalScreen() {
  const [week, setWeek] = useState(getPayWeekStart());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [zeroComments, setZeroComments] = useState({});
  const [generalComment, setGeneralComment] = useState('');
  const [approving, setApproving] = useState(false);
  const [overrideLoading, setOverrideLoading] = useState({});

  const latestWeekRef = useRef(week);

  const loadData = useCallback(async (requestedWeek) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchApprovalData(requestedWeek);
      if (latestWeekRef.current !== requestedWeek) return;
      setData(result);
    } catch (err) {
      if (latestWeekRef.current !== requestedWeek) return;
      setError(err.message);
    } finally {
      if (latestWeekRef.current === requestedWeek) setLoading(false);
    }
  }, []);

  useEffect(() => {
    latestWeekRef.current = week;
    setExpandedId(null);
    setZeroComments({});
    setGeneralComment('');
    loadData(week);
  }, [week, loadData]);

  const refreshData = useCallback(async (requestedWeek) => {
    try {
      const result = await fetchApprovalData(requestedWeek);
      if (latestWeekRef.current !== requestedWeek) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (latestWeekRef.current !== requestedWeek) return;
      showToast('Failed to refresh — tap Retry or reload', 'error');
    }
  }, []);

  const weekStart = DateTime.fromISO(week);
  const weekEnd = weekStart.plus({ days: 6 });
  const weekLabel = `${weekStart.toFormat('MMM d')} – ${weekEnd.toFormat('MMM d, yyyy')}`;
  const isCurrentWeek = week === getPayWeekStart();
  const isNavigationDisabled = loading || approving || Object.values(overrideLoading).some(Boolean);

  const prevWeek = () => { if (!isNavigationDisabled) setWeek(weekStart.minus({ weeks: 1 }).toISODate()); };
  const nextWeek = () => {
    if (!isCurrentWeek && !isNavigationDisabled) setWeek(weekStart.plus({ weeks: 1 }).toISODate());
  };

  // Derived state
  const employees = data?.employees || [];
  const approval = data?.approval;
  const isAlreadyApproved = approval?.status === 'approved';
  const zeroHoursEmployees = employees.filter(e => e.total_net_minutes === 0);
  const allZeroHoursHaveComments = zeroHoursEmployees.every(e => (zeroComments[e.employee_id] || '').trim().length > 0);
  const totalFlaggedEntries = employees.reduce((s, e) => s + (e.flagged_count || 0), 0);
  const flaggedEmployeeCount = employees.filter(e => (e.flagged_count || 0) > 0).length;
  const totalOverrides = employees.reduce((s, e) => s + (e.pending_lunch_overrides || 0), 0);
  const canApprove = !approving && !isAlreadyApproved && allZeroHoursHaveComments && employees.length > 0 && totalOverrides === 0;

  const handleToggle = (empId) => {
    setExpandedId(expandedId === empId ? null : empId);
  };

  const handleZeroComment = (empId, value) => {
    setZeroComments(prev => ({ ...prev, [empId]: value }));
  };

  const handleLunchOverride = async (entryId, approved) => {
    setOverrideLoading(prev => ({ ...prev, [entryId]: true }));
    try {
      await reviewLunchOverride(week, entryId, approved);
      showToast(approved ? 'Override approved' : 'Override rejected', 'success');
      await refreshData(week);
    } catch (err) {
      showToast(err.message, 'error');
      // 409 = override already processed by another supervisor — refresh to clear stale buttons
      if (err.status === 409) await refreshData(week);
    } finally {
      setOverrideLoading(prev => ({ ...prev, [entryId]: false }));
    }
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      const body = {};
      if (generalComment.trim()) body.comment = generalComment.trim();
      if (zeroHoursEmployees.length > 0) {
        body.zero_hours_comments = zeroHoursEmployees.map(e => ({
          employee_id: e.employee_id,
          comment: (zeroComments[e.employee_id] || '').trim()
        }));
      }
      await approveTimesheet(week, body);
      showToast('Week approved', 'success');
      await refreshData(week);
    } catch (err) {
      showToast(err.message, 'error');
      // Refresh only on 409 (server state diverged, e.g. new pending override)
      // Other errors (400 validation) don't change data — avoid overwriting error state
      if (err.status === 409) await refreshData(week);
    } finally {
      setApproving(false);
    }
  };

  return (
    <div class="approval-screen">
      {/* Week navigator — reuse timesheet pattern */}
      <div class="ts-week-nav">
        <button class="ts-nav-arrow" onClick={prevWeek} disabled={isNavigationDisabled} aria-label="Previous week">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div class="ts-week-label">{weekLabel}</div>
        <button
          class={`ts-nav-arrow ${isCurrentWeek || isNavigationDisabled ? 'disabled' : ''}`}
          onClick={nextWeek}
          disabled={isCurrentWeek || isNavigationDisabled}
          aria-label="Next week"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {!isOnline.value ? (
        <div class="ap-offline">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          <span>Approvals require an internet connection</span>
        </div>
      ) : loading ? (
        <div class="ts-loading">Loading approval data...</div>
      ) : error ? (
        <div class="ts-error">
          <p>{error}</p>
          <button class="login-retry-btn" onClick={() => loadData(week)}>Retry</button>
        </div>
      ) : (
        <>
          {/* Approved status */}
          {isAlreadyApproved && (
            <div class="ap-approved-banner">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>Week Approved</span>
              {approval.approved_at && (
                <span class="ap-approved-date">
                  {toLocal(approval.approved_at).toFormat('MMM d, h:mma').toLowerCase()}
                </span>
              )}
            </div>
          )}

          {/* Summary */}
          <div class="ap-summary">
            {employees.length} employee{employees.length !== 1 ? 's' : ''}
            {totalFlaggedEntries > 0 && (
              <> &middot; <span class="ap-summary-flags">
                {flaggedEmployeeCount} flagged ({totalFlaggedEntries} {totalFlaggedEntries === 1 ? 'entry' : 'entries'})
              </span></>
            )}
            {totalOverrides > 0 && <> &middot; <span class="ap-summary-overrides">{totalOverrides} pending override{totalOverrides !== 1 ? 's' : ''}</span></>}
          </div>

          {/* Employee list */}
          <div class="ap-employee-list">
            {employees.map(emp => (
              <EmployeeRow
                key={emp.employee_id}
                emp={emp}
                expanded={expandedId === emp.employee_id}
                onToggle={() => handleToggle(emp.employee_id)}
                zeroComment={zeroComments[emp.employee_id]}
                onZeroComment={handleZeroComment}
                overrideLoading={overrideLoading}
                onOverride={handleLunchOverride}
                isApproved={isAlreadyApproved}
              />
            ))}

            {employees.length === 0 && (
              <div class="ap-empty">No employees found for this week</div>
            )}
          </div>

          {/* Approval form */}
          {!isAlreadyApproved && employees.length > 0 && (
            <div class="ap-approval-form">
              <div class="ap-comment-group">
                <label class="form-label" for="ap-comment">Comment (optional)</label>
                <textarea
                  id="ap-comment"
                  class="form-input form-textarea"
                  value={generalComment}
                  onInput={(e) => setGeneralComment(e.target.value)}
                  placeholder="Approval notes..."
                  rows="2"
                />
              </div>
              <button
                class="ap-approve-btn"
                disabled={!canApprove}
                onClick={handleApprove}
              >
                {approving ? 'Approving...' : 'Approve Week'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
