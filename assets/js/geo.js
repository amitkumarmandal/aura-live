/**
 * Aura Live - Geolocation & Telemetry Utilities
 */

/**
 * Calculates Haversine distance between two coordinates in meters
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} distance in meters
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    if (lat1 === lat2 && lon1 === lon2) return 0;
    const R = 6371e3; // Earth radius in meters
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
        Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Formats latitude and longitude with hemisphere indicators
 * @param {number} lat
 * @param {number} lng
 * @returns {{latStr: string, lngStr: string, text: string}}
 */
export function formatCoordinates(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
        return { latStr: '--.----°', lngStr: '--.----°', text: '--' };
    }
    const latHemi = lat >= 0 ? 'N' : 'S';
    const lngHemi = lng >= 0 ? 'E' : 'W';
    const latStr = `${Math.abs(lat).toFixed(4)}° ${latHemi}`;
    const lngStr = `${Math.abs(lng).toFixed(4)}° ${lngHemi}`;
    return {
        latStr,
        lngStr,
        text: `${lat.toFixed(5)}, ${lng.toFixed(5)}`
    };
}

/**
 * Converts meters per second to km/h string
 * @param {number|null} speedMps
 * @returns {string}
 */
export function formatSpeed(speedMps) {
    if (typeof speedMps !== 'number' || isNaN(speedMps) || speedMps < 0) {
        return '0.0 km/h';
    }
    const kmh = speedMps * 3.6;
    return `${kmh.toFixed(1)} km/h`;
}

/**
 * Evaluates GPS accuracy and returns fix status descriptor
 * @param {number|null} accuracyM
 * @returns {{label: string, className: string, badgeBg: string}}
 */
export function evaluateAccuracy(accuracyM) {
    if (typeof accuracyM !== 'number' || isNaN(accuracyM) || accuracyM <= 0) {
        return {
            label: 'Searching',
            className: 'text-amber-500',
            badgeBg: 'bg-amber-50 text-amber-700 border-amber-200'
        };
    }
    if (accuracyM <= 15) {
        return {
            label: 'Optimal',
            className: 'text-emerald-600',
            badgeBg: 'bg-emerald-50 text-emerald-700 border-emerald-200'
        };
    }
    if (accuracyM <= 50) {
        return {
            label: 'Good',
            className: 'text-sky-600',
            badgeBg: 'bg-sky-50 text-sky-700 border-sky-200'
        };
    }
    return {
        label: 'Weak',
        className: 'text-amber-600',
        badgeBg: 'bg-amber-50 text-amber-700 border-amber-200'
    };
}

/**
 * Formats a timestamp into HH:MM:SS
 * @param {number|Date} dateOrTimestamp
 * @returns {string}
 */
export function formatTime(dateOrTimestamp) {
    const d = dateOrTimestamp instanceof Date ? dateOrTimestamp : new Date(dateOrTimestamp);
    return d.toTimeString().split(' ')[0];
}

/**
 * Normalizes phone number into numeric digits only
 * @param {string} raw
 * @returns {string}
 */
export function normalizePhoneNumber(raw) {
    if (!raw) return '';
    return String(raw).replace(/\D/g, '');
}

/**
 * Compares two phone numbers by comparing their last 10 digits
 * @param {string} p1
 * @param {string} p2
 * @returns {boolean}
 */
export function matchPhoneNumbers(p1, p2) {
    const n1 = normalizePhoneNumber(p1);
    const n2 = normalizePhoneNumber(p2);
    if (!n1 || !n2) return false;
    if (n1 === n2) return true;
    const sub1 = n1.length >= 10 ? n1.slice(-10) : n1;
    const sub2 = n2.length >= 10 ? n2.slice(-10) : n2;
    return sub1 === sub2;
}

/**
 * Masks phone number for user privacy (e.g., +91 ••••••3210)
 * @param {string} phone
 * @returns {string}
 */
export function maskPhoneNumber(phone) {
    if (!phone) return '••••••••';
    const digits = normalizePhoneNumber(phone);
    if (digits.length <= 4) return digits;
    const last4 = digits.slice(-4);
    const prefix = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : '';
    return `${prefix}••••••${last4}`;
}

/**
 * Creates a position throttler ensuring writes happen at most every `minIntervalMs`
 * or whenever moved distance >= `minDistanceMeters`. Always permits first fix.
 * @param {number} minIntervalMs
 * @param {number} minDistanceMeters
 */
export function createPositionThrottler(minIntervalMs = 10000, minDistanceMeters = 20) {
    let lastSentTimestamp = 0;
    let lastSentCoords = null;

    return {
        shouldSend(coords) {
            const now = Date.now();
            if (!lastSentCoords) {
                return true; // First fix is always broadcast
            }
            const timeElapsed = now - lastSentTimestamp;
            if (timeElapsed >= minIntervalMs) {
                return true;
            }
            const dist = calculateHaversineDistance(
                lastSentCoords.latitude,
                lastSentCoords.longitude,
                coords.latitude,
                coords.longitude
            );
            return dist >= minDistanceMeters;
        },
        recordSent(coords) {
            lastSentTimestamp = Date.now();
            lastSentCoords = {
                latitude: coords.latitude,
                longitude: coords.longitude
            };
        },
        reset() {
            lastSentTimestamp = 0;
            lastSentCoords = null;
        }
    };
}

/**
 * Queries device battery status if Battery API is supported
 * @returns {Promise<number>} Battery percentage 0..100
 */
export async function getBatteryLevel() {
    try {
        if ('getBattery' in navigator) {
            const battery = await navigator.getBattery();
            return Math.round(battery.level * 100);
        }
    } catch {
        // Battery Status API unsupported or restricted
    }
    return 100;
}

/**
 * Screen Wake Lock Manager keeping browser awake during active ride
 */
export class WakeLockController {
    constructor() {
        this.sentinel = null;
    }

    async acquire() {
        if ('wakeLock' in navigator) {
            try {
                this.sentinel = await navigator.wakeLock.request('screen');
                return true;
            } catch (err) {
                console.warn('Wake Lock request rejected:', err.message);
            }
        }
        return false;
    }

    release() {
        if (this.sentinel) {
            this.sentinel.release().catch(() => {});
            this.sentinel = null;
        }
    }
}
