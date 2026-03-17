import { useState, useEffect } from 'preact/hooks';
import { currentUser, activeShift } from '../app';
import { nowLocal, toLocal } from '../lib/timezone';
import { captureLocation } from '../lib/gps';
import { submitTimeEvent } from '../lib/api';
import { addToQueue } from '../lib/sync';
import { showToast } from '../components/Toast';
import db from '../lib/db';
import { getDeviceId } from '../lib/device';

export function ClockScreen() {
  const [currentTime, setCurrentTime] = useState(nowLocal());
  const [gpsLoading, setGpsLoading] = useState(false);
  const [showClockOutCard, setShowClockOutCard] = useState(false);
  const [lunchOverride, setLunchOverride] = useState(false);
  const [comment, setComment] = useState('');
  const user = currentUser.value;
  const shift = activeShift.value;

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(nowLocal()), 1000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (dt) => dt.toFormat('h:mm:ss a');
  const formatDate = (dt) => dt.toFormat('EEEE, MMMM d, yyyy');

  const shiftDuration = shift?.clock_in_at
    ? formatDuration(new Date(shift.clock_in_at), new Date())
    : null;

  const handleClockIn = async () => {
    setGpsLoading(true);
    try {
      const gps = await captureLocation();
      const payload = {
        lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy,
        speed: gps.speed, samples: gps.samples,
        mock_detected: gps.mock_detected,
        flag_reasons: gps.flag_reasons,
        gps_error: gps.error || null,
        device_id: getDeviceId()
      };

      let entry;
      try {
        const result = await submitTimeEvent({ ...payload, event_type: 'clock_in' });
        entry = result.entry;
        showToast('Clocked in', 'success');
      } catch (err) {
        if (err.name === 'TypeError' || !navigator.onLine) {
          await addToQueue(payload, 'clock_in');
          entry = { id: crypto.randomUUID(), clock_in_at: new Date().toISOString(), ...payload };
          showToast('Clocked in (queued for sync)', 'success');
        } else {
          throw err;
        }
      }

      activeShift.value = entry;
      try {
        await db.activeShift.clear();
        await db.activeShift.add(entry);
      } catch (e) {
        console.error('Failed to cache active shift locally:', e);
      }
    } catch (err) {
      showToast(err.message || 'Clock-in failed', 'error');
    } finally {
      setGpsLoading(false);
    }
  };

  const handleClockOut = () => setShowClockOutCard(true);
  const cancelClockOut = () => {
    setShowClockOutCard(false);
    setLunchOverride(false);
    setComment('');
  };

  const confirmClockOut = async () => {
    setGpsLoading(true);
    try {
      const gps = await captureLocation();
      const payload = {
        lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy,
        speed: gps.speed, samples: gps.samples,
        mock_detected: gps.mock_detected,
        flag_reasons: gps.flag_reasons,
        gps_error: gps.error || null,
        lunch_override_requested: lunchOverride,
        employee_comment: comment || null,
        device_id: getDeviceId()
      };

      try {
        await submitTimeEvent({ ...payload, event_type: 'clock_out' });
        showToast('Clocked out', 'success');
      } catch (err) {
        if (err.name === 'TypeError' || !navigator.onLine) {
          await addToQueue(payload, 'clock_out');
          showToast('Clocked out (queued for sync)', 'success');
        } else {
          throw err;
        }
      }

      activeShift.value = null;
      try {
        await db.activeShift.clear();
      } catch (e) {
        console.error('Failed to clear cached shift:', e);
      }
      setShowClockOutCard(false);
      setLunchOverride(false);
      setComment('');
    } catch (err) {
      showToast(err.message || 'Clock-out failed', 'error');
    } finally {
      setGpsLoading(false);
    }
  };

  // Clock-out confirmation card
  if (showClockOutCard && shift) {
    const clockInTime = toLocal(shift.clock_in_at);
    const estimatedHours = (
      (Date.now() - new Date(shift.clock_in_at).getTime()) / 3600000
    ).toFixed(1);
    const showLunchNotice = parseFloat(estimatedHours) >= 5;

    return (
      <div class="clock-screen">
        <div class="clockout-card">
          <div class="clockout-card-header">
            <h3 class="clockout-card-title">End Shift</h3>
          </div>

          <div class="clockout-summary">
            <div class="clockout-row">
              <span class="clockout-label">Clock In</span>
              <span class="clockout-value">{clockInTime.toFormat('h:mm a')}</span>
            </div>
            <div class="clockout-row">
              <span class="clockout-label">Current Time</span>
              <span class="clockout-value">{formatTime(currentTime)}</span>
            </div>
            <div class="clockout-divider" />
            <div class="clockout-row clockout-row-total">
              <span class="clockout-label">Estimated Hours</span>
              <span class="clockout-value-lg">{estimatedHours}h</span>
            </div>
            {showLunchNotice && (
              <div class="clockout-lunch-notice">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>30-min lunch will be auto-deducted</span>
              </div>
            )}
          </div>

          <div class="clockout-options">
            <button
              class={`clockout-toggle ${lunchOverride ? 'active' : ''}`}
              onClick={() => setLunchOverride(!lunchOverride)}
            >
              <span class={`clockout-toggle-track ${lunchOverride ? 'on' : ''}`}>
                <span class="clockout-toggle-thumb" />
              </span>
              <span class="clockout-toggle-label">I worked through lunch</span>
            </button>

            <div class="clockout-comment-group">
              <label class="form-label" for="clockout-comment">Comment (optional)</label>
              <textarea
                id="clockout-comment"
                class="form-input form-textarea clockout-comment"
                value={comment}
                onInput={(e) => setComment(e.target.value)}
                placeholder="Notes about this shift..."
                rows="2"
              />
            </div>
          </div>

          <div class="clockout-actions">
            <button
              class="clockout-confirm-btn"
              onClick={confirmClockOut}
              disabled={gpsLoading}
            >
              {gpsLoading ? 'Capturing GPS...' : 'Confirm Clock Out'}
            </button>
            <button
              class="clockout-cancel-btn"
              onClick={cancelClockOut}
              disabled={gpsLoading}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main clock display
  return (
    <div class="clock-screen">
      <div class="clock-display">
        <div class="clock-time">{formatTime(currentTime)}</div>
        <div class="clock-date">{formatDate(currentTime)}</div>
        <div class="clock-timezone">Atlantic Time</div>
      </div>

      {user && (
        <div class="clock-user-greeting">
          {user.displayName || user.display_name || user.employeeCode || user.employee_id}
        </div>
      )}

      {shift ? (
        <div class="clock-active-shift">
          <div class="shift-timer">
            <div class="shift-timer-label">Shift Duration</div>
            <div class="shift-timer-value">{shiftDuration}</div>
          </div>
          <button
            class={`clock-button clock-out ${gpsLoading ? 'loading' : ''}`}
            onClick={handleClockOut}
            disabled={gpsLoading}
          >
            {gpsLoading ? 'Locating...' : 'Clock Out'}
          </button>
        </div>
      ) : (
        <button
          class={`clock-button clock-in ${gpsLoading ? 'loading' : ''}`}
          onClick={handleClockIn}
          disabled={gpsLoading}
        >
          {gpsLoading ? 'Locating...' : 'Clock In'}
        </button>
      )}

      {gpsLoading && (
        <div class="gps-status">
          <div class="gps-pulse" />
          <span>Capturing GPS location...</span>
        </div>
      )}
    </div>
  );
}

function formatDuration(start, end) {
  const diff = Math.max(0, end.getTime() - start.getTime());
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
