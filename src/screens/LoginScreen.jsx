import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { FormInput } from '../components/FormInput';
import { SubmitButton } from '../components/SubmitButton';
import { showToast } from '../components/Toast';
import { requestMagicLink, verifyCode } from '../lib/auth';
import { currentUser, loadActiveShift } from '../app.jsx';
import db from '../lib/db';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const activeRequestRef = useRef(0);

  // Code entry state
  const [codeDigits, setCodeDigits] = useState(['', '', '', '', '', '']);
  const [verifying, setVerifying] = useState(false);
  const [codeError, setCodeError] = useState('');
  const inputRefs = useRef([]);
  const verifyingRef = useRef(false);

  // Cooldown countdown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Auto-focus first code input when sent screen appears
  useEffect(() => {
    if (sent && inputRefs.current[0]) {
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    }
  }, [sent]);

  const sendCode = async () => {
    if (!email || !email.includes('@')) {
      showToast('Please enter a valid email address', 'error');
      return;
    }
    const requestId = ++activeRequestRef.current;
    setLoading(true);
    try {
      await requestMagicLink(email);
      if (activeRequestRef.current !== requestId) return;
      setSent(true);
      setCooldown(60);
      showToast('Sign-in code sent!', 'success');
    } catch (err) {
      if (activeRequestRef.current !== requestId) return;
      showToast(err.message || 'Failed to send sign-in code', 'error');
    } finally {
      if (activeRequestRef.current === requestId) setLoading(false);
    }
  };

  const submitCode = useCallback(async (code) => {
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    setVerifying(true);
    setCodeError('');
    try {
      const data = await verifyCode(email, code);
      if (!data.user) {
        throw new Error('No user profile was returned — reload and try again.');
      }
      currentUser.value = data.user;
      try {
        await db.preferences.put({ key: 'currentUser', value: data.user });
      } catch (e) {
        console.error('Failed to cache user:', e);
      }
      try {
        await loadActiveShift();
      } catch (e) {
        console.error('Failed to load active shift after login:', e);
      }
    } catch (err) {
      setCodeError(err.message || 'Invalid code');
      setCodeDigits(['', '', '', '', '', '']);
      setTimeout(() => inputRefs.current[0]?.focus(), 150);
    } finally {
      verifyingRef.current = false;
      setVerifying(false);
    }
  }, [email]);

  const handleCodeInput = useCallback((index, e) => {
    const value = e.target.value.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ2-9]/g, '');
    if (!value) {
      e.target.value = codeDigits[index];
      return;
    }

    // Multi-char input (e.g. browser OTP autofill): distribute across boxes
    if (value.length > 1) {
      if (verifyingRef.current) return;
      setCodeError('');
      const next = [...codeDigits];
      for (let j = 0; j < value.length && index + j < 6; j++) {
        next[index + j] = value[j];
      }
      setCodeDigits(next);
      if (next.every(d => d !== '')) {
        inputRefs.current[5]?.blur();
        submitCode(next.join(''));
      } else {
        inputRefs.current[Math.min(index + value.length, 5)]?.focus();
      }
      return;
    }

    // Single-char input
    setCodeError('');
    const char = value.slice(-1);
    const next = [...codeDigits];
    next[index] = char;
    setCodeDigits(next);

    // Auto-advance or auto-submit
    if (index < 5) {
      inputRefs.current[index + 1]?.focus();
    } else if (next.every(d => d !== '')) {
      inputRefs.current[index]?.blur();
      submitCode(next.join(''));
    }
  }, [codeDigits, submitCode]);

  const handleCodeKeyDown = useCallback((index, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      setCodeError('');
      const next = [...codeDigits];
      if (next[index]) {
        next[index] = '';
        setCodeDigits(next);
      } else if (index > 0) {
        next[index - 1] = '';
        setCodeDigits(next);
        inputRefs.current[index - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      inputRefs.current[index + 1]?.focus();
    } else if (e.key === 'Enter') {
      const code = codeDigits.join('');
      if (code.length === 6) submitCode(code);
    }
  }, [codeDigits, submitCode]);

  const handlePaste = useCallback((e) => {
    e.preventDefault();
    if (verifyingRef.current) return;
    const pasted = (e.clipboardData?.getData('text') || '')
      .toUpperCase()
      .replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ2-9]/g, '')
      .slice(0, 6);
    if (!pasted) return;

    setCodeError('');
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i];
    }
    setCodeDigits(next);

    // Focus appropriate box
    if (pasted.length >= 6) {
      inputRefs.current[5]?.blur();
      submitCode(next.join(''));
    } else {
      inputRefs.current[Math.min(pasted.length, 5)]?.focus();
    }
  }, [submitCode]);

  const handleSubmit = (e) => { e.preventDefault(); if (!loading) sendCode(); };
  const handleResend = () => { if (cooldown <= 0) { setCodeDigits(['', '', '', '', '', '']); setCodeError(''); sendCode(); } };
  const handleReset = () => {
    activeRequestRef.current++;
    setSent(false);
    setEmail('');
    setLoading(false);
    setCodeDigits(['', '', '', '', '', '']);
    setCodeError('');
    verifyingRef.current = false;
    setVerifying(false);
  };

  if (sent) {
    return (
      <div class="login-screen">
        <div class="card login-card">
          <div class="login-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
              stroke="var(--accent)" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </div>
          <h2 class="login-heading">Enter Your Code</h2>
          <p class="login-subtext">
            We sent a 6-character code to
          </p>
          <div class="login-email-display">{email}</div>

          <div class={`code-input-row ${verifying ? 'login-verifying' : ''}`} onPaste={handlePaste}>
            {codeDigits.map((digit, i) => (
              <input
                key={i}
                ref={el => { inputRefs.current[i] = el; }}
                class={`code-input-box ${codeError ? 'error' : ''} ${digit ? 'filled' : ''}`}
                type="text"
                inputMode="text"
                autocomplete={i === 0 ? 'one-time-code' : 'off'}
                maxLength={1}
                value={digit}
                onInput={(e) => handleCodeInput(i, e)}
                onKeyDown={(e) => handleCodeKeyDown(i, e)}
                disabled={verifying}
                aria-label={`Code digit ${i + 1}`}
              />
            ))}
          </div>

          {codeError && (
            <div class="code-error-message" key={codeError}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              {codeError}
            </div>
          )}

          <p class="login-expiry-notice">Code expires in 15 minutes</p>

          <button
            class="login-retry-btn"
            onClick={handleResend}
            disabled={cooldown > 0 || loading || verifying}
          >
            {loading ? 'Sending...' : cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend Code'}
          </button>

          <button class="login-alt-link" onClick={handleReset}>
            Use a different email
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="login-screen">
      <div class="card login-card">
        <div class="login-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
            stroke="var(--accent)" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <h2 class="login-heading">Sign In</h2>
        <p class="login-subtext">
          Enter your email to receive a sign-in code
        </p>
        <form onSubmit={handleSubmit}>
          <FormInput
            label="Email Address"
            name="email"
            type="email"
            value={email}
            onChange={(name, value) => setEmail(value)}
            placeholder="you@example.com"
            required
            inputMode="email"
          />
          <SubmitButton
            label="Send Sign-In Code"
            loading={loading}
            disabled={!email}
          />
        </form>
      </div>
    </div>
  );
}
