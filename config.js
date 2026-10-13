/**
 * Aura Live - Hardened Firebase RTDB Endpoint Resolver & Telemetry Config
 *
 * Security Enhancements:
 * 1. Stripped unused client keys (storageBucket, messagingSenderId, appId, authDomain).
 * 2. Obfuscated default RTDB cluster endpoint to prevent casual scraping and DevTools reconnaissance.
 * 3. Strict SSRF protection: validates & whitelists database URLs against trusted Firebase domains.
 */

// Obfuscated default cluster endpoint (assembled and decoded dynamically at runtime)
const _0xrt = ['aHR0cHM6Ly9teXBsYW5uZXItNTY5', 'NGQtZGVmYXVsdC1ydGRiLmZpcmVi', 'YXNlaW8uY29t'];

function getDefaultDatabaseUrl() {
    try {
        return atob(_0xrt.join(''));
    } catch {
        return '';
    }
}

// Strict whitelist pattern for valid Firebase Realtime Database hosts
const TRUSTED_RTDB_REGEX = /^https:\/\/[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)\/?$/i;

/**
 * Resolves Realtime Database URL with strict origin validation to prevent SSRF / exfiltration
 * @param {string|null} overrideUrl
 * @returns {string}
 */
export function resolveDatabaseUrl(overrideUrl) {
    if (overrideUrl && typeof overrideUrl === 'string') {
        const trimmed = overrideUrl.trim().replace(/\/+$/, '');
        if (TRUSTED_RTDB_REGEX.test(trimmed)) {
            return trimmed;
        }
        console.warn('[Aura Security] Rejected untrusted database URL override:', overrideUrl);
    }
    return getDefaultDatabaseUrl();
}

/**
 * Minimal sealed configuration object (only provides databaseURL required by REST client)
 */
export const firebaseConfig = Object.freeze({
    get databaseURL() {
        return getDefaultDatabaseUrl();
    }
});
