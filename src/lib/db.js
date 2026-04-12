import Dexie from 'dexie';

const db = new Dexie('TimeAppDB');

// Schema v1 — future version bumps MUST include .upgrade() handlers
// e.g. db.version(2).stores({...}).upgrade(tx => { ... })
db.version(1).stores({
  // Pending clock-in/out events awaiting sync
  pendingSubmissions: '++id, submission_uuid, event_type, status, created_at',

  // Successfully synced submissions (7-day retention)
  syncedSubmissions: '++id, submission_uuid, event_type, synced_at',

  // Reference data cache (sync timestamps, versions)
  referenceData: 'key, updated_at',

  // User preferences (currentUser session, app settings)
  preferences: 'key',

  // Cached employee list for reference
  refEmployees: 'id, employee_id, active',

  // At most one row — the current open clock-in
  activeShift: 'id'
});

export default db;

// Submission status enum
export const SYNC_STATUS = {
  PENDING: 'pending',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  FAILED: 'failed',
  ABANDONED: 'abandoned'
};
