# Time Tracking PWA

> **This document is the single source of truth for building the time tracking app.**
> Every architecture decision, business rule, and technical constraint has been finalized.
> Do not re-derive or second-guess these decisions — build to spec.

## What We're Building

A mobile-first PWA for GPS-verified clock-in/clock-out time tracking for hourly employees. The app connects to a backend API and supports offline-first operation.

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | Preact 10 + Vite 5 | Lightweight React alternative |
| State | @preact/signals | Global signals, no router |
| Offline storage | Dexie 3 (IndexedDB) | DB name: `TimeAppDB` |
| PWA | vite-plugin-pwa + Workbox | Service worker with runtime caching |
| Backend | Express + better-sqlite3 | API server (separate repo) |
| Database | SQLite + Litestream | WAL mode, replicated |
| Auth | Magic link (passwordless) | Email-based code verification |
| Timezone | luxon | Configurable via `TZ` constant in `src/lib/timezone.js` |
| CSS | Vanilla CSS with CSS variables | Industrial design system |

## Project Structure

```
src/
├── app.jsx                 # Global state (signals), sync orchestration, navigation
├── main.jsx                # Entry point, service worker registration
├── index.css               # Industrial design system + time-app extensions
├── components/
│   ├── Header.jsx          # App header with version, online/offline badge, logout
│   ├── Toast.jsx           # Signal-based toast notifications
│   ├── FormInput.jsx       # Reusable text input
│   └── SubmitButton.jsx    # Submit with loading state
├── screens/
│   ├── LoginScreen.jsx     # Magic link email login
│   ├── ClockScreen.jsx     # Clock-in/out with shift timer
│   ├── TimesheetScreen.jsx # Weekly hours summary
│   └── ApprovalScreen.jsx  # Supervisor approval workflow
└── lib/
    ├── db.js               # Dexie TimeAppDB schema
    ├── api.js              # Backend API time endpoints client
    ├── sync.js             # Offline queue for clock events
    ├── gps.js              # 5-reading median GPS capture
    ├── timezone.js         # Configurable timezone helpers (local date, DOW, pay week)
    ├── rounding.js         # Quarter-hour rounding with grace periods
    ├── overtime.js         # Configurable overtime calculation (default: 44 hr/week)
    └── auth.js             # Magic link client (request, verify, session)
```

## Key Patterns

### Version Management

When bumping versions, update BOTH:
1. `package.json` → `"version": "x.y.z"`
2. `src/components/Header.jsx` → `const APP_VERSION = 'x.y.z'`

### Navigation

Uses Preact signals (`currentView` signal), **not** a router. Views:
- `'clock'` — Clock-in/out home screen (default)
- `'timesheet'` — Weekly hours summary
- `'approval'` — Supervisor approval (role-gated)

Navigation functions exported from `app.jsx`: `navigateHome()`, `navigateTo(view)`.

### Authentication

Magic link flow:
1. Employee enters email → `POST /auth/magic-link`
2. Employee receives 6-character code via email
3. Employee enters code → `POST /auth/verify-code`
4. Server creates HttpOnly session cookie (~30 days)
5. `currentUser` signal populated from `GET /auth/me`

Session persisted in Dexie `preferences` table. Logout via double-tap on user badge in Header.

### Timezone Handling — CRITICAL

**All timestamps stored as UTC.** Day-of-week and pay week derivation happen in app code using luxon with a configurable timezone (default: `America/Moncton`). Change the `TZ` constant in `src/lib/timezone.js` for your region.

- `clock_in_local_date` and `clock_in_local_dow` computed before INSERT
- `pay_week_start` is always a Monday (CHECK constraint in schema)
- DOW: `weekday % 7` → 0=Sun, 1=Mon, ..., 6=Sat

### GPS Capture

5-reading median (not single-shot):
- 5 readings at 1s intervals
- Filter accuracy > 65m
- Median lat/lng/accuracy from remaining readings
- Mock location detection, speed flagging (> 2.5 m/s)
- Never-reject pattern (returns null coords on failure)

### Rounding Rules

- **Clock-in:** ≤5 min after 15-min mark → round back; >5 min → round forward
- **Clock-out:** ≤10 min before next 15-min mark → round forward; >10 min → round back
- Both raw and rounded times stored

### Lunch Deduction

- Elapsed (rounded) ≥ 5 hours → auto-deduct 30 minutes
- Employee can flag "I worked through lunch" → supervisor reviews
- Deduction stays until supervisor approves override

### Overtime

- Default: 44 hours/week (2,640 minutes) threshold
- Excess at configurable multiplier × minimum wage (default: 1.5× $15.65/hr)
- Configure in `src/lib/overtime.js` or pass overrides via `config` param

## Business Rules

### Pay Period
- **Monday–Sunday** pay week
- Approval deadline: Tuesday 11:59 AM

### Daily Employee Flow
1. Open app (already authenticated, ~30 day session)
2. Tap "Clock In" → GPS captured, timestamp recorded
3. Shift timer runs → "Clock Out" button shown
4. Tap "Clock Out" → GPS captured, post-clock-out summary shown
5. Tap "Done" → shift queued for sync

## Database Schema

See `docs/time-app-schema.sql` (v1.1.0). 10 tables, 2 views, 3 triggers.
Backend uses SQLite `time.db` (separate from `assets.db`).

## API Endpoints

All requests use `credentials: 'include'` for HttpOnly cookies.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/auth/magic-link` | Request magic link email |
| POST | `/auth/verify-code` | Verify code, create session |
| POST | `/auth/logout` | Kill session |
| GET | `/auth/me` | Current user from session |
| POST | `/api/time/clock-in` | Clock in with GPS |
| POST | `/api/time/clock-out` | Clock out with GPS |
| GET | `/api/time/status` | Current clock-in status |
| GET | `/api/time/entries?from=&to=` | Time entries for range |
| POST | `/api/time/sync` | Batch offline events |
| GET | `/api/time/employees` | Employee list |

Base URL: `VITE_API_URL` env var (default: `http://localhost:3000`).

## Environment Variables

```
VITE_API_URL=http://localhost:3000
VITE_APP_NAME=Time
```

## Dexie Database Schema

Database name: `TimeAppDB` (v1)

| Table | Indexes | Purpose |
|-------|---------|---------|
| `pendingSubmissions` | `++id, submission_uuid, event_type, status, created_at` | Offline queue |
| `syncedSubmissions` | `++id, submission_uuid, event_type, synced_at` | Sync history (7-day retention) |
| `referenceData` | `key, updated_at` | Sync metadata |
| `preferences` | `key` | User session, app preferences |
| `refEmployees` | `id, employee_id, active` | Cached employee list |
| `activeShift` | `id` | At most one row — current open clock-in |

## Common Commands

```bash
# Local development
npm run dev

# Production build
npm run build

# Lint
npm run lint
```

## What NOT to Build

- **No real-time GPS tracking** — only at clock-in and clock-out
- **No break tracking** — single clock-in/out per shift, lunch auto-deducted
- **No scheduling** — time capture only
- **No payroll integration** — CSV + PDF to accountant
