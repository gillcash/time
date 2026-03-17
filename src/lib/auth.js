/**
 * Magic link auth client.
 * Backend endpoints not built yet (Phase 2) — these are API stubs.
 * Uses credentials: 'include' for HttpOnly session cookies.
 */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

/**
 * Request a magic link email for the given address.
 * @param {string} email — employee's email
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function requestMagicLink(email) {
  const r = await fetch(`${API_URL}/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email })
  });

  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || `Magic link request failed: ${r.status}`);
  }

  return r.json();
}
/**
 * Verify a 6-character sign-in code.
 * @param {string} email — employee's email
 * @param {string} code — 6-char code from email
 * @returns {Promise<{ ok: boolean, user: object }>}
 */
export async function verifyCode(email, code) {
  const r = await fetch(`${API_URL}/auth/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, code })
  });
  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || `Verification failed: ${r.status}`);
  }
  return r.json();
}

/**
 * Get the currently authenticated user from the session cookie.
 * @returns {Promise<object|null>} — user object or null if not authenticated
 */
export async function getMe() {
  const r = await fetch(`${API_URL}/auth/me`, {
    credentials: 'include'
  });
  if (r.status >= 500) throw new Error(`Server error: ${r.status}`);
  if (!r.ok) return null; // 4xx = genuinely unauthenticated
  const data = await r.json();
  return data.user || null;
}

/**
 * Log out — invalidates the session cookie.
 */
export async function logout() {
  try {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include'
    });
  } catch {
    // Ignore errors — local logout proceeds regardless
  }
}
