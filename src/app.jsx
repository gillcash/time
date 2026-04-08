import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Header } from './components/Header';
import { Toast, dismissToast } from './components/Toast';
import { LoginScreen } from './screens/LoginScreen';
import { ClockScreen } from './screens/ClockScreen';
import { TimesheetScreen } from './screens/TimesheetScreen';
import { ApprovalScreen } from './screens/ApprovalScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { processQueue, getPendingCount } from './lib/sync';
import { getMe, logout } from './lib/auth';
import { fetchTimeStatus } from './lib/api';
import { isNative } from './lib/platform';
import db from './lib/db';

// Global app state
export const isOnline = signal(navigator.onLine);
export const pendingCount = signal(0);
export const currentUser = signal(null);
export const currentView = signal('clock'); // 'clock' | 'timesheet' | 'approval' | 'settings'
export const activeShift = signal(null);

// Navigation
export function navigateHome() {
  dismissToast();
  currentView.value = 'clock';
}

export function navigateTo(view) {
  dismissToast();
  currentView.value = view;
}

export function App() {
  useEffect(() => {
    // Initialize database
    db.open().catch((err) => {
      console.error('Failed to open database:', err);
    });

    // Sync queue first so server state is authoritative, then load user and shift
    (async () => {
      if (navigator.onLine) {
        try {
          await processQueue();
        } catch (err) {
          console.error('Startup sync failed:', err);
        }
      }
      updatePendingCount();
      await loadCurrentUser();
      loadActiveShift().catch(err => console.error('Failed to load active shift:', err));
    })();

    // Online/offline listeners — native uses @capacitor/network, web uses window events
    let cleanupNetwork = () => {};

    if (isNative) {
      let networkListener = null;
      import('@capacitor/network').then(({ Network }) => {
        Network.getStatus().then(status => {
          isOnline.value = status.connected;
        });
        Network.addListener('networkStatusChange', (status) => {
          isOnline.value = status.connected;
          if (status.connected) {
            processQueue()
              .then(() => { updatePendingCount(); })
              .catch(err => console.error('Online sync failed:', err));
          }
        }).then(handle => { networkListener = handle; });
      });
      cleanupNetwork = () => { if (networkListener) networkListener.remove(); };
    } else {
      const handleOnline = () => {
        isOnline.value = true;
        processQueue()
          .then(() => { updatePendingCount(); })
          .catch(err => console.error('Online sync failed:', err));
      };
      const handleOffline = () => { isOnline.value = false; };
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      cleanupNetwork = () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      };
    }

    // Periodic sync check (every 30 seconds)
    const syncInterval = setInterval(() => {
      if (isOnline.value) {
        processQueue()
          .then(() => { updatePendingCount(); })
          .catch(err => console.error('Periodic sync failed:', err));
      }
    }, 30000);

    return () => {
      cleanupNetwork();
      clearInterval(syncInterval);
    };
  }, []);

  // Show login screen if not authenticated
  if (!currentUser.value) {
    return (
      <div class="app">
        <Header />
        <main class="main-content">
          <LoginScreen />
        </main>
      </div>
    );
  }

  // Render current view
  const renderView = () => {
    switch (currentView.value) {
      case 'timesheet':
        return <TimesheetScreen />;
      case 'approval':
        return <ApprovalScreen />;
      case 'settings':
        return <SettingsScreen />;
      case 'clock':
      default:
        return <ClockScreen />;
    }
  };

  return (
    <div class="app">
      <Header />
      <main class="main-content">
        {renderView()}
      </main>
      <nav class="bottom-nav">
        <button
          class={`nav-btn ${currentView.value === 'clock' ? 'active' : ''}`}
          onClick={() => navigateTo('clock')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span>Clock</span>
        </button>
        <button
          class={`nav-btn ${currentView.value === 'timesheet' ? 'active' : ''}`}
          onClick={() => navigateTo('timesheet')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <span>Timesheet</span>
        </button>
        {['supervisor', 'manager', 'admin'].includes(currentUser.value?.role) && (
          <button
            class={`nav-btn ${currentView.value === 'approval' ? 'active' : ''}`}
            onClick={() => navigateTo('approval')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>Approvals</span>
          </button>
        )}
        <button
          class={`nav-btn ${currentView.value === 'settings' ? 'active' : ''}`}
          onClick={() => navigateTo('settings')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>Settings</span>
        </button>
      </nav>
      <Toast />
    </div>
  );
}

// Load current user — try server first (online), fall back to Dexie (offline)
async function loadCurrentUser() {
  if (navigator.onLine) {
    try {
      const user = await getMe();
      if (user) {
        currentUser.value = user;
        try {
          await db.preferences.put({ key: 'currentUser', value: user });
        } catch (e) {
          console.error('Failed to cache current user:', e);
        }
      } else {
        // Server explicitly said unauthenticated — clear stale cache
        currentUser.value = null;
        try {
          await db.preferences.delete('currentUser');
        } catch (e) {
          console.error('Failed to clear cached user:', e);
        }
      }
      return;
    } catch {
      // Network error — fall through to Dexie cache
    }
  }
  // Offline or network error — try Dexie cache
  try {
    const stored = await db.preferences.get('currentUser');
    if (stored?.value) currentUser.value = stored.value;
  } catch (e) {
    console.error('Failed to read cached user from Dexie:', e);
  }
}

// Handle logout
export async function handleLogout() {
  await logout();
  currentUser.value = null;
  activeShift.value = null;
  try {
    await db.preferences.delete('currentUser');
    await db.activeShift.clear();
  } catch (e) {
    console.error('Failed to clear logout cache:', e);
  }
}

async function updatePendingCount() {
  try {
    const count = await getPendingCount();
    pendingCount.value = count;
  } catch (e) {
    console.error('Failed to get pending count:', e);
  }
}

// Load active shift — try server first (online), fall back to Dexie (offline)
export async function loadActiveShift() {
  if (navigator.onLine && currentUser.value) {
    try {
      const status = await fetchTimeStatus();
      if (status.clockedIn && status.entry) {
        activeShift.value = status.entry;
        try {
          await db.activeShift.clear();
          await db.activeShift.add(status.entry);
        } catch (e) {
          console.error('Failed to cache active shift:', e);
        }
      } else {
        activeShift.value = null;
        try {
          await db.activeShift.clear();
        } catch (e) {
          console.error('Failed to clear cached shift:', e);
        }
      }
      return;
    } catch {
      // fetchTimeStatus() failed — fall through to Dexie cache
    }
  }
  // Offline or server error — try Dexie cache
  const shifts = await db.activeShift.toArray();
  activeShift.value = shifts.length > 0 ? shifts[0] : null;
}
