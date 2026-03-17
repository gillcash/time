/**
 * GPS capture for time tracking — 5-reading median with mock detection.
 * Never rejects — GPS failure returns null coords + error string.
 *
 * Captures 5 readings at 1s intervals, filters out readings with
 * accuracy > 65m, then takes the median lat/lng/accuracy.
 *
 * On native (Capacitor), uses @capacitor/geolocation instead of
 * navigator.geolocation for proper native GPS access.
 */

import { isNative } from './platform';

let CapGeo = null;
async function getCapGeo() {
  if (!CapGeo) { CapGeo = (await import('@capacitor/geolocation')).Geolocation; }
  return CapGeo;
}

const SAMPLE_COUNT = 5;
const SAMPLE_INTERVAL_MS = 1000;
const MAX_ACCURACY_M = 65;
const MAX_SPEED_MS = 2.5; // 9 km/h — drive-by detection

/**
 * Capture a single GPS reading. Never rejects.
 */
async function singleReading(timeoutMs = 10000) {
  if (isNative) {
    try {
      const Geo = await getCapGeo();
      const pos = await Geo.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: timeoutMs,
      });
      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        speed: pos.coords.speed,
        timestamp: pos.timestamp,
      };
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speed: pos.coords.speed,
          timestamp: pos.timestamp
        });
      },
      () => {
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

/**
 * Wait for a specified number of milliseconds
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the median value from a sorted array of numbers
 */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Check if a position appears to be from a mock/fake GPS provider
 */
function detectMock(pos) {
  // Android: check for mock provider flag
  // This is only available through native APIs, but some browsers expose it
  if (pos && pos.isMock) return true;
  // Accuracy of exactly 0 or negative is suspicious
  if (pos && (pos.accuracy === 0 || pos.accuracy < 0)) return true;
  return false;
}

/**
 * Capture GPS location using 5-reading median.
 * Returns: { lat, lng, accuracy, speed, samples, mock_detected, flag_reasons, error }
 * Never rejects.
 */
export async function captureLocation() {
  // On native, request permissions first
  if (isNative) {
    try {
      const Geo = await getCapGeo();
      const perms = await Geo.requestPermissions();
      if (perms.location === 'denied') {
        return {
          lat: null, lng: null, accuracy: null,
          speed: null, samples: 0, mock_detected: false,
          flag_reasons: ['permission_denied'], error: 'Location permission denied'
        };
      }
    } catch {
      // Permission request failed — continue and let singleReading handle errors
    }
  }

  if (!isNative && !navigator.geolocation) {
    return {
      lat: null, lng: null, accuracy: null,
      speed: null, samples: 0, mock_detected: false,
      flag_reasons: [], error: 'Geolocation not supported'
    };
  }

  const readings = [];
  let mockDetected = false;
  const flagReasons = [];

  // Collect SAMPLE_COUNT readings at SAMPLE_INTERVAL_MS intervals.
  // Early-exit after 2 consecutive failures to avoid 54s worst-case freeze.
  let consecutiveFails = 0;

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const reading = await singleReading();

    if (reading) {
      consecutiveFails = 0;
      if (detectMock(reading)) {
        mockDetected = true;
      }
      readings.push(reading);
    } else {
      consecutiveFails++;
      if (consecutiveFails >= 2) break;
    }

    // Wait between readings (except after the last one)
    if (i < SAMPLE_COUNT - 1) {
      await wait(SAMPLE_INTERVAL_MS);
    }
  }

  if (readings.length === 0) {
    return {
      lat: null, lng: null, accuracy: null,
      speed: null, samples: 0, mock_detected: mockDetected,
      flag_reasons: ['gps_unavailable'], error: 'No GPS readings obtained'
    };
  }

  // Filter out readings with poor accuracy
  const accurate = readings.filter(r => r.accuracy <= MAX_ACCURACY_M);
  const usable = accurate.length > 0 ? accurate : readings; // Fall back to all if none pass

  if (accurate.length === 0) {
    flagReasons.push('accuracy_poor');
  }

  // Compute medians
  const lat = median(usable.map(r => r.lat));
  const lng = median(usable.map(r => r.lng));
  const accuracy = Math.round(median(usable.map(r => r.accuracy)));

  // Speed from latest reading (most current)
  const latestSpeed = readings[readings.length - 1].speed;
  const speed = latestSpeed != null ? Math.round(latestSpeed * 100) / 100 : null;

  // Flag checks
  if (mockDetected) {
    flagReasons.push('mock_location');
  }
  if (speed != null && speed > MAX_SPEED_MS) {
    flagReasons.push('high_speed');
  }

  return {
    lat, lng, accuracy,
    speed,
    samples: readings.length,
    mock_detected: mockDetected,
    flag_reasons: flagReasons,
    error: null
  };
}
