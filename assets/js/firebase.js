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
 * Matches a user against the tour members list using memberId, phone, or token override.
 * If the member is not yet in RTDB, constructs a provisional member identity from memberId/phone/name.
 * @param {object|array} membersData
 * @param {string|null} phone
 * @param {string|null} memberIdOverride
 * @param {string|null} tokenOverride
 * @param {string|null} memberNameOverride
 * @returns {{memberId: string, memberName: string, contact: string, role: string, isActive: boolean}|null}
 */
export function findMatchingMember(membersData, phone, memberIdOverride = null, tokenOverride = null, memberNameOverride = null) {
    const list = !membersData
        ? []
        : (Array.isArray(membersData)
            ? membersData.filter(Boolean)
            : Object.entries(membersData).map(([key, val]) => ({ ...(val || {}), _key: key })));

    const cleanOverrideId = memberIdOverride ? String(memberIdOverride).trim() : null;
    const lowerOverrideId = cleanOverrideId ? cleanOverrideId.toLowerCase() : null;
    const prefixedOverrideId = lowerOverrideId && !lowerOverrideId.startsWith('member_')
        ? `member_${lowerOverrideId}`
        : lowerOverrideId;

    // 1. Direct match by memberId override (case-insensitive & prefix-resilient)
    if (lowerOverrideId) {
        const found = list.find(m => {
            const candidates = [
                m.memberId,
                m.rawMemberId,
                m.id,
                m._key,
                m.id ? `member_${m.id}` : null,
                m.rawMemberId ? `member_${m.rawMemberId}` : null
            ]
                .filter(Boolean)
                .map(x => String(x).toLowerCase());
            return candidates.includes(lowerOverrideId) || (prefixedOverrideId && candidates.includes(prefixedOverrideId));
        });
        if (found) {
            return normalizeMemberRecord(found, memberNameOverride, phone);
        }

        // Also check if memberIdOverride embeds a 10-digit phone (e.g. "member_9876543210")
        const embeddedDigits = cleanOverrideId.replace(/\D/g, '').slice(-10);
        if (embeddedDigits.length === 10) {
            const foundByEmbeddedPhone = list.find(m => {
                const memberPhone = m.contact || m.phone || m.mobile || m.leaderContact || '';
                return matchPhoneNumbers(memberPhone, embeddedDigits);
            });
            if (foundByEmbeddedPhone) {
                return normalizeMemberRecord(foundByEmbeddedPhone, memberNameOverride, embeddedDigits);
            }
        }
    }

    // 2. Direct match by token / code override
    if (tokenOverride) {
        const found = list.find(m => m.token === tokenOverride || m.code === tokenOverride);
        if (found) {
            return normalizeMemberRecord(found, memberNameOverride, phone);
        }
    }

    // 3. Match by phone number (last 10 digits comparison)
    if (phone) {
        const found = list.find(m => {
            const memberPhone = m.contact || m.phone || m.mobile || m.leaderContact || '';
            return matchPhoneNumbers(memberPhone, phone);
        });
        if (found) {
            return normalizeMemberRecord(found, memberNameOverride, phone);
        }

        // 4. Provisional member identity constructed directly from phone number
        const digits = String(phone).replace(/\D/g, '').slice(-10);
        if (digits.length >= 4) {
            const canonicalId = cleanOverrideId
                ? (cleanOverrideId.startsWith('member_') ? cleanOverrideId : `member_${cleanOverrideId}`)
                : `member_${digits}`;
            return {
                memberId: canonicalId,
                memberName: memberNameOverride || `Member (${digits.slice(-4)})`,
                contact: digits,
                role: 'MEMBER',
                isActive: true
            };
        }
    }

    // 5. Provisional member identity constructed from memberIdOverride (works even when member has no phone)
    if (cleanOverrideId) {
        const canonicalId = cleanOverrideId.startsWith('member_') ? cleanOverrideId : `member_${cleanOverrideId}`;
        const embeddedDigits = cleanOverrideId.replace(/\D/g, '').slice(-10);
        const inferredPhone = embeddedDigits.length === 10 ? embeddedDigits : (phone || '');
        const fallbackLabel = embeddedDigits.length >= 4
            ? `Member (${embeddedDigits.slice(-4)})`
            : `Rider (${cleanOverrideId.replace(/^member_/i, '')})`;
        return {
            memberId: canonicalId,
            memberName: memberNameOverride || fallbackLabel,
            contact: inferredPhone,
            role: 'MEMBER',
            isActive: true
        };
    }

    return null;
}

function normalizeMemberRecord(raw, nameFallback = null, phoneFallback = null) {
    const memberId = raw.memberId || raw._key || (raw.id ? `member_${raw.id}` : 'rider_web');
    const memberName = raw.memberName || raw.name || nameFallback || 'Expedition Member';
    const contact = raw.contact || raw.phone || raw.mobile || phoneFallback || '';
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
            memberId,
            memberName,
            web_last_seen: Date.now(),
            is_active_online: true
        });
    } catch {
        // Members list may be restricted or read-only
    }

    return payload;
}

/**
 * Records that a member opened their tracking link (even before GPS fix is acquired)
 * @param {string} tourId
 * @param {object|string} memberOrId
 */
export async function recordMemberLinkOpened(tourId, memberOrId) {
    if (!dbInstance || !tourId || !memberOrId) return;
    const memberId = typeof memberOrId === 'string' ? memberOrId : memberOrId.memberId;
    if (!memberId) return;

    try {
        const memberPresenceRef = ref(dbInstance, `shared_tours/${tourId}/members/${memberId}`);
        const payload = {
            memberId,
            web_last_seen: Date.now()
        };
        if (typeof memberOrId === 'object') {
            if (memberOrId.memberName) payload.memberName = memberOrId.memberName;
            if (memberOrId.contact) {
                payload.phone = memberOrId.contact;
                payload.contact = memberOrId.contact;
            }
            if (memberOrId.role) payload.role = memberOrId.role;
        }
        await update(memberPresenceRef, payload);
    } catch {
        // Non-blocking if members node is restricted
    }
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
