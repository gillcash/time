import { useState, useEffect, useRef } from 'preact/hooks';
import { isOnline } from '../app';
import { fetchSettings, updateSettings } from '../lib/api';
import { showToast } from '../components/Toast';

const REMINDER_OPTIONS = [
  { value: null, label: 'Off' },
  { value: '16:00', label: '4:00 PM' },
  { value: '16:15', label: '4:15 PM' },
  { value: '16:30', label: '4:30 PM' },
  { value: '16:45', label: '4:45 PM' },
  { value: '17:00', label: '5:00 PM' },
  { value: '17:15', label: '5:15 PM' },
  { value: '17:30', label: '5:30 PM' },
  { value: '17:45', label: '5:45 PM' },
  { value: '18:00', label: '6:00 PM' },
  { value: '18:15', label: '6:15 PM' },
  { value: '18:30', label: '6:30 PM' },
  { value: '18:45', label: '6:45 PM' },
  { value: '19:00', label: '7:00 PM' },
  { value: '19:15', label: '7:15 PM' },
  { value: '19:30', label: '7:30 PM' },
  { value: '19:45', label: '7:45 PM' },
  { value: '20:00', label: '8:00 PM' },
];

export function SettingsScreen() {
  const [reminderTime, setReminderTime] = useState(null);
  const [hasPhone, setHasPhone] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveSeqRef = useRef(0);

  const loadSettings = () => {
    setLoading(true);
    fetchSettings()
      .then(data => {
        setReminderTime(data.clockout_reminder_time ?? null);
        setHasPhone(!!data.has_phone);
      })
      .catch(err => {
        console.error('Failed to load settings:', err);
        showToast('Failed to load settings', 'error');
        setReminderTime(undefined); // sentinel: load failed
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!isOnline.value) {
      setLoading(false);
      return;
    }
    loadSettings();
  }, [isOnline.value]);

  const handleChange = async (e) => {
    if (reminderTime === undefined) return;
    const newValue = e.target.value === '' ? null : e.target.value;
    const previousValue = reminderTime;
    const seq = ++saveSeqRef.current;
    setReminderTime(newValue);
    setSaving(true);
    try {
      await updateSettings({ clockout_reminder_time: newValue });
      const label = newValue
        ? REMINDER_OPTIONS.find(o => o.value === newValue)?.label
        : 'Off';
      showToast(`Reminder ${newValue ? `set to ${label}` : 'turned off'}`, 'success');
    } catch (err) {
      if (saveSeqRef.current === seq) {
        setReminderTime(previousValue);
      }
      showToast(err.message || 'Failed to save', 'error');
    } finally {
      if (saveSeqRef.current === seq) {
        setSaving(false);
      }
    }
  };

  // Offline state
  if (!isOnline.value) {
    return (
      <div class="settings-screen">
        <div class="settings-offline">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          <span class="settings-offline-title">Offline</span>
          <span class="settings-offline-text">Settings require an internet connection</span>
        </div>
      </div>
    );
  }

  return (
    <div class="settings-screen">
      <div class="settings-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>Settings</span>
      </div>

      <div class="settings-card">
        <div class="settings-item">
          <div class="settings-item-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
          </div>
          <div class="settings-item-content">
            <label class="settings-item-label" for="clockout-reminder">
              Clock-Out Reminder
            </label>
            <p class="settings-item-desc">
              Get a daily SMS reminder within 15 minutes of this time if you're still clocked in (one per day)
            </p>
          </div>
        </div>

        <div class={`settings-select-wrap ${saving ? 'saving' : ''}`}>
          {loading ? (
            <div class="settings-loading">Loading...</div>
          ) : (
            <select
              id="clockout-reminder"
              class="form-input form-select settings-select"
              value={reminderTime ?? ''}
              onChange={handleChange}
              disabled={saving || reminderTime === undefined}
            >
              {REMINDER_OPTIONS.map(opt => (
                <option key={opt.value ?? 'off'} value={opt.value ?? ''}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}
          {saving && <div class="settings-saving-indicator" />}
        </div>

        <div class="settings-current-value" onClick={reminderTime === undefined ? loadSettings : undefined}
          style={reminderTime === undefined ? { cursor: 'pointer' } : undefined}>
          <span class={`settings-status-dot ${reminderTime === undefined ? 'error' : reminderTime ? 'active' : ''}`} />
          <span class="settings-status-text">
            {reminderTime === undefined
              ? 'Failed to load — tap to retry'
              : reminderTime
                ? `Active — ${REMINDER_OPTIONS.find(o => o.value === reminderTime)?.label}`
                : 'No reminder set'}
          </span>
        </div>

        {!hasPhone && reminderTime !== undefined && (
          <div class="settings-phone-warning">
            No phone number on file — contact your manager to receive SMS reminders.
          </div>
        )}
      </div>
    </div>
  );
}
