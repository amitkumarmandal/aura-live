/**
 * Aura Live - Firebase Realtime Database Service (Modular v10 SDK)
 */

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
    getDatabase,
    ref,
    get,
    child,
    set,
    update,
    onDisconnect,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import {
    getAuth,
    signInAnonymously
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

import { firebaseConfig, resolveDatabaseUrl } from '../../config.js';
import { matchPhoneNumbers, maskPhoneNumber } from './geo.js';

let appInstance = null;
let dbInstance = null;
let authInstance = null;
let activeDisconnectRef = null;

/**
 * Initializes Firebase App, Auth, and Realtime Database
 * @param {string|null} customDatabaseUrl
 */
export async function initFirebaseService(customDatabaseUrl = null) {
    const databaseUrl = resolveDatabaseUrl(customDatabaseUrl);

    if (getApps().length === 0) {
        appInstance = initializeApp({
            ...firebaseConfig,
            databaseURL: databaseUrl
        });
    } else {
        appInstance = getApp();
    }

    authInstance = getAuth(appInstance);
    dbInstance = getDatabase(appInstance, databaseUrl);

    // Perform anonymous auth sign-in gracefully if not already signed in
    try {
        if (!authInstance.currentUser) {
            await signInAnonymously(authInstance);
        }
    } catch (authErr) {
        console.warn('Anonymous auth note (rules may permit unauthenticated reads):', authErr.message);
    }

    return { app: appInstance, db: dbInstance, auth: authInstance };
}

/**
 * Fetches tour metadata and registered members from Realtime Database
 * @param {string} tourId
 * @returns {Promise<{meta: object, members: object, activeRidersCount: number}>}
 */
export async function fetchTourData(tourId) {
    if (!dbInstance) {
        await initFirebaseService();
    }

    const tourRef = ref(dbInstance, `shared_tours/${tourId}`);
    const snapshot = await get(tourRef);

    const data = snapshot.exists() ? (snapshot.val() || {}) : {};

    // Support both root-level fields and nested 'meta' child
    const metaSource = data.meta || data;
    const title = metaSource.title || data.title || `Aura Expedition #${tourId}`;
    const destination = metaSource.destination || data.destination || data.location || 'Active Expedition Route';
    const leaderName = metaSource.leaderName || data.leaderName || 'Tour Leader';
    const leaderContact = metaSource.leaderContact || data.leaderContact || '';
    const startDate = metaSource.startDate || data.startDate || '';
    const endDate = metaSource.endDate || data.endDate || '';
    const apkLink = metaSource.apkLink || data.apkLink || '';
    const expiresAt = metaSource.expiresAt || data.expiresAt || 0;
    const isExpirationEnabled = metaSource.isExpirationEnabled === true;

    // Calculate online rider count
    let activeRidersCount = 0;
    if (data.live_locations && typeof data.live_locations === 'object') {
        const riders = Object.values(data.live_locations);
        activeRidersCount = riders.filter(r => r && r.is_online === true).length;
    }

    const members = data.members || {};

    return {
        meta: {
            title,
            destination,
            leaderName,
            leaderContact,
            startDate,
            endDate,
            apkLink,
            expiresAt,
            isExpirationEnabled
        },
        members,
        activeRidersCount,
        liveLocations: data.live_locations || {}
    };
}

/**
 * Matches a user against the tour members list using phone or memberId/token override.
 * If the member is not yet in RTDB, constructs a provisional member identity from the phone number.
 * @param {object|array} membersData
 * @param {string} phone
 * @param {string|null} memberIdOverride
 * @param {string|null} tokenOverride
 * @returns {{memberId: string, memberName: string, contact: string, role: string, isActive: boolean}|null}
 */
export function findMatchingMember(membersData, phone, memberIdOverride = null, tokenOverride = null) {
    const list = !membersData
        ? []
        : (Array.isArray(membersData)
            ? membersData.filter(Boolean)
            : Object.entries(membersData).map(([key, val]) => ({ ...(val || {}), _key: key })));

    // 1. Direct match by memberId override
    if (memberIdOverride) {
        const found = list.find(m => (m.memberId === memberIdOverride || m.id === memberIdOverride || m._key === memberIdOverride));
        if (found) {
            return normalizeMemberRecord(found);
        }
    }

    // 2. Direct match by token / code override
    if (tokenOverride) {
        const found = list.find(m => m.token === tokenOverride || m.code === tokenOverride);
        if (found) {
            return normalizeMemberRecord(found);
        }
    }

    // 3. Match by phone number (last 10 digits comparison)
    if (phone) {
        const found = list.find(m => {
            const memberPhone = m.contact || m.phone || m.mobile || m.leaderContact || '';
            return matchPhoneNumbers(memberPhone, phone);
        });
        if (found) {
            return normalizeMemberRecord(found);
        }

        // 4. Provisional member identity constructed directly from phone number
        const digits = String(phone).replace(/\D/g, '').slice(-10);
        if (digits.length >= 4) {
            return {
                memberId: `member_${digits}`,
                memberName: `Member (${digits.slice(-4)})`,
                contact: digits,
                role: 'MEMBER',
                isActive: true
            };
        }
    }

    if (memberIdOverride) {
        return {
            memberId: memberIdOverride,
            memberName: `Rider (${memberIdOverride})`,
            contact: phone || '',
            role: 'MEMBER',
            isActive: true
        };
    }

    return null;
}

function normalizeMemberRecord(raw) {
    const memberId = raw.memberId || raw.id || raw._key || 'rider_web';
    const memberName = raw.memberName || raw.name || 'Expedition Member';
    const contact = raw.contact || raw.phone || raw.mobile || '';
    const role = raw.role || 'MEMBER';
    const isActive = raw.isActive !== false;

    return {
        memberId,
        memberName,
        contact,
        role,
        isActive
    };
}

/**
 * Writes member live position to Realtime Database and attaches onDisconnect handler
 * @param {string} tourId
 * @param {string} memberId
 * @param {string} memberName
 * @param {object} coords
 * @param {number} batteryLevel
 * @param {string} maskedPhone
 */
export async function writeLivePosition(tourId, memberId, memberName, coords, batteryLevel, maskedPhone) {
    if (!dbInstance) {
        await initFirebaseService();
    }

    const liveRef = ref(dbInstance, `shared_tours/${tourId}/live_locations/${memberId}`);

    const payload = {
        member_id: memberId,
        member_name: memberName,
        latitude: Number(coords.latitude.toFixed(6)),
        longitude: Number(coords.longitude.toFixed(6)),
        speed_kmh: Math.max(0, Number(((coords.speed || 0) * 3.6).toFixed(1))),
        heading: coords.heading >= 0 ? Math.round(coords.heading) : 0,
        battery_level: batteryLevel,
        is_online: true,
        timestamp: Date.now(),
        accuracy_m: Math.round(coords.accuracy || 0),
        source: 'web',
        phone_masked: maskedPhone || maskPhoneNumber(coords.phone)
    };

    // Configure onDisconnect once per session
    if (!activeDisconnectRef) {
        try {
            activeDisconnectRef = onDisconnect(liveRef);
            await activeDisconnectRef.update({
                is_online: false,
                timestamp: serverTimestamp()
            });
        } catch (discErr) {
            console.warn('onDisconnect configuration note:', discErr.message);
        }
    }

    // Set live telemetry payload
    await set(liveRef, payload);

    // Non-blocking update to member web_last_seen
    try {
        const memberPresenceRef = ref(dbInstance, `shared_tours/${tourId}/members/${memberId}`);
        await update(memberPresenceRef, {
            web_last_seen: Date.now(),
            is_active_online: true
        });
    } catch {
        // Members list may be restricted or read-only
    }

    return payload;
}

/**
 * Marks member as offline when stopping live broadcast
 * @param {string} tourId
 * @param {string} memberId
 */
export async function markMemberOffline(tourId, memberId) {
    if (!dbInstance || !tourId || !memberId) return;

    try {
        const liveRef = ref(dbInstance, `shared_tours/${tourId}/live_locations/${memberId}`);
        await update(liveRef, {
            is_online: false,
            timestamp: Date.now()
        });

        if (activeDisconnectRef) {
            try {
                await activeDisconnectRef.cancel();
            } catch {}
            activeDisconnectRef = null;
        }
    } catch (err) {
        console.warn('Failed to mark member offline:', err.message);
    }
}
