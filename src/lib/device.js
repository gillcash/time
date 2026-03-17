import { platformPrefix } from './platform';

/**
 * Get or create a device ID for tracking submissions.
 * Migrates legacy 'pwa_device_id' to 'time_device_id'.
 * New installs get AND-XXXXXXXX, IOS-XXXXXXXX, or PWA-XXXXXXXX.
 */
export function getDeviceId() {
  let id = localStorage.getItem('time_device_id');
  if (!id) {
    // Migrate from legacy key if present
    const legacy = localStorage.getItem('pwa_device_id');
    if (legacy) {
      id = legacy;
      localStorage.setItem('time_device_id', id);
      localStorage.removeItem('pwa_device_id');
    } else {
      id = platformPrefix + '-' + crypto.randomUUID().substring(0, 8).toUpperCase();
      localStorage.setItem('time_device_id', id);
    }
  }
  return id;
}
