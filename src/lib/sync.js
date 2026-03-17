/**
 * Sync queue manager for offline-first clock-in/clock-out submissions
 * Adapted from field-forms sync.js
 */

import db, { SYNC_STATUS } from './db';
import { submitTimeEvent } from './api';
import { getDeviceId } from './device';

const MAX_RETRIES = 5;
const RETRY_DELAYS = [1000, 5000, 15000, 60000, 300000]; // Exponential backoff

// Concurrency guard — prevents duplicate processQueue() runs
let _syncing = false;

/**
 * Add a clock event to the sync queue
 */
export async function addToQueue(eventData, eventType = 'clock_in') {
  const submission = {
    submission_uuid: crypto.randomUUID(),
    event_type: eventType,
    status: SYNC_STATUS.PENDING,
    created_at: new Date().toISOString(),
    data: eventData,
    retry_count: 0,
    device_id: getDeviceId(),
    offline_submission: !navigator.onLine
  };

  await db.pendingSubmissions.add(submission);

  // Attempt immediate sync if online
  if (navigator.onLine) {
    setTimeout(() => processQueue(), 100);
  }

  return submission.submission_uuid;
}

/**
 * Process all pending submissions in the queue
 */
export async function processQueue() {
  if (!navigator.onLine || _syncing) {
    return { synced: 0, failed: 0, pending: await getPendingCount() };
  }

  _syncing = true;

  try {
    // Recover orphaned SYNCING items (e.g. browser crashed mid-sync)
    await db.pendingSubmissions
      .where('status').equals(SYNC_STATUS.SYNCING)
      .modify({ status: SYNC_STATUS.PENDING });

    const pending = await db.pendingSubmissions
      .where('status')
      .anyOf([SYNC_STATUS.PENDING, SYNC_STATUS.FAILED])
      .toArray();

    let synced = 0;
    let failed = 0;
    let maxRetryCount = 0;

    for (const submission of pending) {
      if (submission.retry_count >= MAX_RETRIES) {
        await db.pendingSubmissions.update(submission.id, {
          status: SYNC_STATUS.ABANDONED
        });
        continue;
      }

      try {
        await db.pendingSubmissions.update(submission.id, {
          status: SYNC_STATUS.SYNCING
        });

        // Submit clock event to API
        await submitTimeEvent({
          ...submission.data,
          submission_uuid: submission.submission_uuid,
          device_id: submission.device_id,
          event_type: submission.event_type
        });

        // Move to synced table
        await db.syncedSubmissions.add({
          submission_uuid: submission.submission_uuid,
          event_type: submission.event_type,
          data: submission.data,
          created_at: submission.created_at,
          synced_at: new Date().toISOString()
        });

        // Remove from pending
        await db.pendingSubmissions.delete(submission.id);

        synced++;
      } catch (error) {
        console.error('Sync error:', error);

        const newRetryCount = submission.retry_count + 1;

        await db.pendingSubmissions.update(submission.id, {
          status: SYNC_STATUS.FAILED,
          retry_count: newRetryCount,
          last_error: error.message,
          last_retry_at: new Date().toISOString()
        });

        if (newRetryCount > maxRetryCount) {
          maxRetryCount = newRetryCount;
        }

        failed++;
      }
    }

    if (failed > 0) {
      scheduleRetry(maxRetryCount);
    }

    await cleanupOldSubmissions();

    return { synced, failed, pending: await getPendingCount() };
  } finally {
    _syncing = false;
  }
}

/**
 * Schedule a retry for failed submissions
 */
let retryTimeout = null;

function scheduleRetry(retryCount = 0) {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
  }

  const delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];

  retryTimeout = setTimeout(async () => {
    if (navigator.onLine) {
      await processQueue();
    }
  }, delay);
}

/**
 * Get count of pending submissions
 */
export async function getPendingCount() {
  return db.pendingSubmissions
    .where('status')
    .anyOf([SYNC_STATUS.PENDING, SYNC_STATUS.SYNCING, SYNC_STATUS.FAILED])
    .count();
}

/**
 * Cleanup synced submissions older than 7 days
 */
async function cleanupOldSubmissions() {
  const syncedCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.syncedSubmissions.where('synced_at').below(syncedCutoff).delete();

  const abandonedCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.pendingSubmissions
    .where('status').equals(SYNC_STATUS.ABANDONED)
    .and(sub => sub.created_at < abandonedCutoff)
    .delete();
}

/**
 * Force sync all pending submissions
 */
export async function forceSync() {
  await db.pendingSubmissions
    .where('status')
    .anyOf([SYNC_STATUS.FAILED, SYNC_STATUS.ABANDONED])
    .modify({ status: SYNC_STATUS.PENDING, retry_count: 0 });

  return processQueue();
}
