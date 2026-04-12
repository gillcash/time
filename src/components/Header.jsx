import { useState, useEffect, useRef } from 'preact/hooks';
import { isOnline, pendingCount, currentUser, handleLogout, navigateHome } from '../app';

// Must match package.json version — update both when bumping
const APP_VERSION = '0.4.0';

const LogoutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

export function Header() {
  const user = currentUser.value;
  const [confirmLogout, setConfirmLogout] = useState(false);
  const timeoutRef = useRef(null);

  // Reset confirm state after 2 seconds
  useEffect(() => {
    if (confirmLogout) {
      timeoutRef.current = setTimeout(() => {
        setConfirmLogout(false);
      }, 2000);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [confirmLogout]);

  const handleUserClick = () => {
    if (confirmLogout) {
      clearTimeout(timeoutRef.current);
      setConfirmLogout(false);
      handleLogout().catch(err => console.error('Logout failed:', err));
    } else {
      setConfirmLogout(true);
    }
  };

  return (
    <header class="header">
      <button class="header-home" onClick={navigateHome} title="Go to home">
        <span class="header-title">Time</span>
        <span class="header-version">v{APP_VERSION}</span>
      </button>
      <div class="header-right">
        {user && (
          <button
            class={`header-user ${confirmLogout ? 'confirm-logout' : ''}`}
            onClick={handleUserClick}
            title={confirmLogout ? 'Tap again to sign out' : 'Tap to sign out'}
          >
            <span class="header-user-name">{user.employeeCode}</span>
            {confirmLogout && <LogoutIcon />}
          </button>
        )}
        <button
          class={`status-badge ${isOnline.value ? 'online' : 'offline'}`}
          onClick={navigateHome}
          title="Go to home"
        >
          <span class="status-dot" />
          <span>{isOnline.value ? 'Online' : 'Offline'}</span>
          {pendingCount.value > 0 && (
            <span>({pendingCount.value})</span>
          )}
        </button>
      </div>
    </header>
  );
}
