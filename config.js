/**
 * Aura Live - Firebase Client Configuration
 *
 * NOTE: Firebase Web API keys identify your project and are intended to be public
 * in client-side single-page applications. Security is enforced entirely via
 * Firebase Realtime Database Security Rules (see `firebase.rules.json`).
 */

export const firebaseConfig = {
    apiKey: "AIzaSyC3JawTYDuhl93supzmlW9xIv8dkXE8lsw",
    authDomain: "myplanner-5694d.firebaseapp.com",
    databaseURL: "https://myplanner-5694d-default-rtdb.firebaseio.com",
    projectId: "myplanner-5694d",
    storageBucket: "myplanner-5694d.firebasestorage.app",
    messagingSenderId: "1050750438539",
    appId: "1:1050750438539:web:a6d62554a06034de67188e"
};

/**
 * Resolves Realtime Database URL allowing dynamic override via URL parameter (&db=...)
 * or base64 fragment (#cfg=...)
 *
 * @param {string|null} overrideUrl
 * @returns {string}
 */
export function resolveDatabaseUrl(overrideUrl) {
    if (overrideUrl && overrideUrl.trim().startsWith("https://")) {
        return overrideUrl.trim();
    }
    return firebaseConfig.databaseURL;
}
