/**
 * Aura Live - Firebase Realtime Database Service (Fast Non-Blocking REST + Timeout)
 *
 * Uses Firebase RTDB REST endpoints (.json) with AbortController timeouts so that:
 * 1. The page NEVER hangs on "Loading tour telemetry..." if RTDB is unreachable or unconfigured.
 * 2. No failed identitytoolkit (400) or @firebase/database WebSocket warnings pollute the console.
 * 3. Remains 100% compatible with AuraIOS TourSharingService & RideMapViewModel paths:
 *    - shared_tours/{tourId}/meta
 *    - shared_tours/{tourId}/members/{memberId}
 *    - shared_tours/{tourId}/live_locations/{memberId}
 */

import { resolveDatabaseUrl } from '../../config.js';
import { matchPhoneNumbers, maskPhoneNumber } from './geo.js';

let activeDatabaseUrl = resolveDatabaseUrl(null);

/**
 * Fetches JSON with a strict timeout so network/Firebase issues never block the UI
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Resolves the canonical Firebase member key ("member_<10digitPhone>" or "member_<id>")
 * matching AuraIOS TourSharingService.canonicalMemberId(phone:fallbackId:)
 */
export function resolveCanonicalMemberKey(memberIdParam = null, phoneParam = null) {
    const cleanPhone = phoneParam ? String(phoneParam).replace(/\D/g, '').slice(-10) : '';
    if (cleanPhone.length === 10) {
        return `member_${cleanPhone}`;
    }
    if (memberIdParam) {
        const trimmed = String(memberIdParam).trim();
        const embeddedDigits = trimmed.replace(/\D/g, '').slice(-10);
        if (embeddedDigits.length === 10) {
            return `member_${embeddedDigits}`;
        }
        if (trimmed.toLowerCase().startsWith('member_')) {
            return trimmed;
        }
        if (trimmed.length > 0) {
            return `member_${trimmed}`;
        }
    }
    return 'member_lead_1';
}

/**
 * Initializes the active RTDB base URL (no blocking auth or WebSocket calls)
 * @param {string|null} customDatabaseUrl
 */
export async function initFirebaseService(customDatabaseUrl = null) {
    activeDatabaseUrl = resolveDatabaseUrl(customDatabaseUrl).replace(/\/+$/, '');
    return { databaseUrl: activeDatabaseUrl };
}

/**
 * Fetches tour metadata and registered members from Realtime Database via fast REST call.
 * Never throws or hangs if RTDB is unconfigured/404; returns sensible defaults instead.
 * @param {string} tourId
 */
export async function fetchTourData(tourId) {
    const fallbackResult = {
        meta: {
            title: `Aura Expedition #${tourId}`,
            destination: 'Live Expedition Route',
            leaderName: 'Tour Leader',
            leaderContact: '',
            startDate: '',
            endDate: '',
            durationDays: 0,
            durationNights: 0,
            addedMembersCount: 0,
            memberCapacity: 0,
            totalEstimate: 0,
            perPersonEstimate: 0,
            lodgingAmount: 0,
            lodgingPct: 0,
            foodAmount: 0,
            foodPct: 0,
            travelAmount: 0,
            travelPct: 0,
            otherAmount: 0,
            otherPct: 0,
            webDisplayFlags: null,
            webDisplayOptions: null,
            apkLink: '',
            expiresAt: 0,
            isExpirationEnabled: false
        },
        members: {},
        activeRidersCount: 0,
        liveLocations: {},
        syncedFromCloud: false
    };

    if (!tourId) return fallbackResult;

    try {
        const url = `${activeDatabaseUrl}/shared_tours/${encodeURIComponent(tourId)}.json`;
        const resp = await fetchWithTimeout(url, { method: 'GET' }, 3000);
        if (!resp.ok) {
            return fallbackResult;
        }

        const data = (await resp.json()) || {};
        const metaSource = data.meta || data;

        const title = metaSource.title || data.title || `Aura Expedition #${tourId}`;
        const destination = metaSource.destination || data.destination || data.location || 'Live Expedition Route';
        const leaderName = metaSource.leaderName || data.leaderName || 'Tour Leader';
        const leaderContact = metaSource.leaderContact || data.leaderContact || '';
        const startDate = metaSource.startDate || data.startDate || '';
        const endDate = metaSource.endDate || data.endDate || '';
        const apkLink = metaSource.apkLink || data.apkLink || '';
        const expiresAt = Number(metaSource.expiresAt || data.expiresAt || 0);
        const isExpirationEnabled = metaSource.isExpirationEnabled === true;

        let activeRidersCount = 0;
        if (data.live_locations && typeof data.live_locations === 'object') {
            const riders = Object.values(data.live_locations);
            activeRidersCount = riders.filter(r => r && r.is_online === true).length;
        }

        const membersObj = data.members || {};
        const cloudMembersCount = typeof membersObj === 'object' ? Object.keys(membersObj).length : 0;

        return {
            meta: {
                title,
                destination,
                leaderName,
                leaderContact,
                startDate,
                endDate,
                durationDays: Number(metaSource.durationDays || 0),
                durationNights: Number(metaSource.durationNights || 0),
                addedMembersCount: Number(metaSource.addedMembersCount || cloudMembersCount || 0),
                memberCapacity: Number(metaSource.memberCapacity || cloudMembersCount || 0),
                totalEstimate: Number(metaSource.totalEstimate || 0),
                perPersonEstimate: Number(metaSource.perPersonEstimate || 0),
                lodgingAmount: Number(metaSource.lodgingAmount || 0),
                lodgingPct: Number(metaSource.lodgingPct || 0),
                foodAmount: Number(metaSource.foodAmount || 0),
                foodPct: Number(metaSource.foodPct || 0),
                travelAmount: Number(metaSource.travelAmount || 0),
                travelPct: Number(metaSource.travelPct || 0),
                otherAmount: Number(metaSource.otherAmount || 0),
                otherPct: Number(metaSource.otherPct || 0),
                webDisplayFlags: metaSource.webDisplayFlags || null,
                webDisplayOptions: metaSource.webDisplayOptions || null,
                apkLink,
                expiresAt,
                isExpirationEnabled
            },
            members: membersObj,
            activeRidersCount,
            liveLocations: data.live_locations || {},
            syncedFromCloud: true
        };
    } catch {
        return fallbackResult;
    }
}

/**
 * Matches a user against the tour members list using memberid, phonenumber/phone, or token.
 * Always returns a valid member object when memberIdOverride or phone is provided so the URL always works.
 * @param {object|array} membersData
 * @param {string|null} phone
 * @param {string|null} memberIdOverride
 * @param {string|null} tokenOverride
 * @param {string|null} memberNameOverride
 */
export function findMatchingMember(
    membersData,
    phone,
    memberIdOverride = null,
    tokenOverride = null,
    memberNameOverride = null
) {
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

    // 1. Direct match by memberId override
    if (lowerOverrideId && list.length > 0) {
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
    if (tokenOverride && list.length > 0) {
        const found = list.find(m => m.token === tokenOverride || m.code === tokenOverride);
        if (found) {
            return normalizeMemberRecord(found, memberNameOverride, phone);
        }
    }

    // 3. Match by phone number (last 10 digits comparison)
    if (phone && list.length > 0) {
        const found = list.find(m => {
            const memberPhone = m.contact || m.phone || m.mobile || m.leaderContact || '';
            return matchPhoneNumbers(memberPhone, phone);
        });
        if (found) {
            return normalizeMemberRecord(found, memberNameOverride, phone);
        }
    }

    // 4. Construct valid member identity from phonenumber / phone or memberid query parameter
    const cleanPhoneDigits = phone ? String(phone).replace(/\D/g, '').slice(-10) : '';
    const embeddedPhoneDigits = cleanOverrideId ? cleanOverrideId.replace(/\D/g, '').slice(-10) : '';
    const resolvedPhone = cleanPhoneDigits.length === 10
        ? cleanPhoneDigits
        : (embeddedPhoneDigits.length === 10 ? embeddedPhoneDigits : cleanPhoneDigits);

    const canonicalKey = resolveCanonicalMemberKey(cleanOverrideId, resolvedPhone);
    const shortIdDisplay = cleanOverrideId
        ? cleanOverrideId.replace(/^member_/i, '')
        : (resolvedPhone ? resolvedPhone.slice(-4) : '1');

    const displayName = memberNameOverride
        || (resolvedPhone.length >= 4 ? `Rider (${resolvedPhone.slice(-4)})` : `Member #${shortIdDisplay}`);

    return {
        memberId: canonicalKey,
        rawMemberId: cleanOverrideId || canonicalKey,
        memberName: displayName,
        contact: resolvedPhone,
        role: 'MEMBER',
        isActive: true
    };
}

function normalizeMemberRecord(raw, nameFallback = null, phoneFallback = null) {
    const contact = raw.contact || raw.phone || raw.mobile || phoneFallback || '';
    const memberId = resolveCanonicalMemberKey(raw.memberId || raw._key || raw.rawMemberId || raw.id, contact);
    const memberName = raw.memberName || raw.name || nameFallback || 'Expedition Member';
    const role = raw.role || 'MEMBER';
    const isActive = raw.isActive !== false;

    return {
        memberId,
        rawMemberId: raw.rawMemberId || raw.id || memberId,
        memberName,
        contact,
        role,
        isActive
    };
}

/**
 * Writes member live position to Realtime Database via REST PUT
 */
export async function writeLivePosition(tourId, memberId, memberName, coords, batteryLevel, maskedPhone) {
    const canonicalId = resolveCanonicalMemberKey(memberId, coords.phone);
    const payload = {
        member_id: canonicalId,
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

    const liveUrl = `${activeDatabaseUrl}/shared_tours/${encodeURIComponent(tourId)}/live_locations/${encodeURIComponent(canonicalId)}.json`;
    const memberUrl = `${activeDatabaseUrl}/shared_tours/${encodeURIComponent(tourId)}/members/${encodeURIComponent(canonicalId)}.json`;

    await Promise.allSettled([
        fetchWithTimeout(
            liveUrl,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            },
            3500
        ),
        fetchWithTimeout(
            memberUrl,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    memberId: canonicalId,
                    memberName,
                    web_last_seen: Date.now(),
                    is_active_online: true
                })
            },
            3500
        )
    ]);

    return payload;
}

/**
 * Records that a member opened their tracking link
 */
export async function recordMemberLinkOpened(tourId, memberOrId) {
    if (!tourId || !memberOrId) return;
    const rawId = typeof memberOrId === 'string' ? memberOrId : memberOrId.memberId;
    const rawPhone = typeof memberOrId === 'object' ? memberOrId.contact : null;
    const canonicalId = resolveCanonicalMemberKey(rawId, rawPhone);

    const payload = {
        memberId: canonicalId,
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

    try {
        const memberUrl = `${activeDatabaseUrl}/shared_tours/${encodeURIComponent(tourId)}/members/${encodeURIComponent(canonicalId)}.json`;
        await fetchWithTimeout(
            memberUrl,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            },
            2500
        );
    } catch {
        // Non-blocking
    }
}

/**
 * Marks member as offline when stopping live broadcast or closing tab
 */
export async function markMemberOffline(tourId, memberId) {
    if (!tourId || !memberId) return;
    const canonicalId = resolveCanonicalMemberKey(memberId, null);
    try {
        const liveUrl = `${activeDatabaseUrl}/shared_tours/${encodeURIComponent(tourId)}/live_locations/${encodeURIComponent(canonicalId)}.json`;
        await fetchWithTimeout(
            liveUrl,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    is_online: false,
                    timestamp: Date.now()
                }),
                keepalive: true
            },
            2500
        );
    } catch {
        // Non-blocking
    }
}
