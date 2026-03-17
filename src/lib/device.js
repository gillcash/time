/**
 * Get or create a device ID for tracking submissions
 */
export function getDeviceId() {
  let id = localStorage.getItem('pwa_device_id');
  if (!id) {
    id = 'PWA-' + crypto.randomUUID().substring(0, 8).toUpperCase();
    localStorage.setItem('pwa_device_id', id);
  }
  return id;
}
