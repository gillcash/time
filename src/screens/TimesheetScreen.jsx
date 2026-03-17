import { useState, useEffect, useRef } from 'preact/hooks';
import { DateTime } from 'luxon';
import { fetchTimesheet } from '../lib/api';
import { getPayWeekStart, toLocal } from '../lib/timezone';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function TimesheetScreen() {
  const [week, setWeek] = useState(getPayWeekStart());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const latestWeekRef = useRef(week);

  useEffect(() => {
    latestWeekRef.current = week;
    loadTimesheet(week);
  }, [week]);

  const loadTimesheet = async (requestedWeek) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTimesheet(requestedWeek);
      if (latestWeekRef.current !== requestedWeek) return;
      setData(result);
    } catch (err) {
      if (latestWeekRef.current !== requestedWeek) return;
      setError(err.message);
    } finally {
      if (latestWeekRef.current === requestedWeek) setLoading(false);
    }
  };

  const weekStart = DateTime.fromISO(week);
  const weekEnd = weekStart.plus({ days: 6 });
  const weekLabel = `${weekStart.toFormat('MMM d')} – ${weekEnd.toFormat('MMM d, yyyy')}`;
  const isCurrentWeek = week === getPayWeekStart();

  const prevWeek = () => setWeek(weekStart.minus({ weeks: 1 }).toISODate());
  const nextWeek = () => {
    if (!isCurrentWeek) setWeek(weekStart.plus({ weeks: 1 }).toISODate());
  };

  // Group entries by day-of-week
  const entriesByDay = {};
  if (data?.entries) {
    for (const entry of data.entries) {
      const dow = entry.clock_in_local_dow; // 0=Sun..6=Sat
      if (dow == null || typeof dow !== 'number') continue;
      // Convert to Mon-first: Mon=1..Sun=0 → index 0..6
      const idx = dow === 0 ? 6 : dow - 1;
      if (!entriesByDay[idx]) entriesByDay[idx] = [];
      entriesByDay[idx].push(entry);
    }
  }

  const totalMinutes = data?.summary?.total_net_minutes || 0;
  const totalHours = (totalMinutes / 60).toFixed(2);
  const otMinutes = data?.overtime?.overtime_minutes || 0;
  const otHours = (otMinutes / 60).toFixed(2);
  const status = data?.summary?.approval_status;

  const fmtTime = (iso) => {
    if (!iso) return '—';
    return toLocal(iso).toFormat('h:mma').toLowerCase();
  };

  return (
    <div class="timesheet-screen">
      {/* Week navigator */}
      <div class="ts-week-nav">
        <button class="ts-nav-arrow" onClick={prevWeek} aria-label="Previous week">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div class="ts-week-label">{weekLabel}</div>
        <button
          class={`ts-nav-arrow ${isCurrentWeek ? 'disabled' : ''}`}
          onClick={nextWeek}
          disabled={isCurrentWeek}
          aria-label="Next week"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {loading ? (
        <div class="ts-loading">Loading timesheet...</div>
      ) : error ? (
        <div class="ts-error">
          <p>{error}</p>
          <button class="login-retry-btn" onClick={() => loadTimesheet(week)}>Retry</button>
        </div>
      ) : (
        <>
          {/* Daily entries card */}
          <div class="ts-card">
            {DAYS.map((day, idx) => {
              const dayEntries = entriesByDay[idx] || [];
              const dayMinutes = dayEntries.reduce((s, e) => s + (e.net_minutes || 0), 0);
              const dayHours = (dayMinutes / 60).toFixed(2);
              const hasEntries = dayEntries.length > 0;
              const isFlagged = dayEntries.some(e => e.flagged);

              return (
                <div class={`ts-day-row ${!hasEntries ? 'empty' : ''} ${isFlagged ? 'flagged' : ''}`} key={day}>
                  <span class="ts-day-abbr">{day}</span>
                  <span class="ts-day-times">
                    {hasEntries
                      ? dayEntries.map((e, i) => (
                          <span key={i}>
                            {fmtTime(e.clock_in_at)} – {fmtTime(e.clock_out_at)}
                          </span>
                        ))
                      : '—'
                    }
                  </span>
                  <span class={`ts-day-hours ${!hasEntries ? 'zero' : ''}`}>
                    {hasEntries ? `${dayHours}h` : '—'}
                  </span>
                </div>
              );
            })}

            {/* Totals */}
            <div class="ts-totals">
              <div class="ts-total-row">
                <span class="ts-total-label">Total</span>
                <span class="ts-total-value">{totalHours}h</span>
              </div>
              {otMinutes > 0 && (
                <div class="ts-total-row ts-overtime">
                  <span class="ts-total-label">Overtime</span>
                  <span class="ts-total-value">{otHours}h</span>
                </div>
              )}
            </div>
          </div>

          {/* Status badge */}
          {status && (
            <div class={`ts-status-badge ${status}`}>
              {status === 'approved' ? 'Approved' :
               status === 'closed' ? 'Closed' : 'Pending Approval'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
