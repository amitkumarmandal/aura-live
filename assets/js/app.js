/**
 * Aura Live - Web Application State Machine & Dynamic Telemetry Controller
 */

import {
    initFirebaseService,
    fetchTourData,
    fetchMemberById,
    decryptAuraToken,
    findMatchingMember,
    writeLivePosition,
    recordMemberLinkOpened,
    markMemberOffline
} from './firebase.js';

import {
    formatCoordinates,
    formatSpeed,
    evaluateAccuracy,
    formatTime,
    maskPhoneNumber,
    createPositionThrottler,
    getBatteryLevel,
    WakeLockController
} from './geo.js';

// Application State
const state = {
    tourId: null,
    phone: null,
    memberIdParam: null,
    memberNameParam: null,
    tokenParam: null,
    customDbUrl: null,
    urlTourParams: {
        flags: null,
        title: null,
        dest: null,
        duration: null,
        start: null,
        end: null,
        host: null,
        members: null,
        est: null,
        pp: null,
        exp: null
    },
    matchedMember: null,
    tourMeta: null,
    isTracking: false,
    watchId: null,
    wakeLock: new WakeLockController(),
    throttler: createPositionThrottler(10000, 20),
    currentCoords: null,
    currentBattery: 100,
    map: null,
    mapMarker: null,
    accuracyCircle: null
};

// DOM Element References
const elements = {
    appContent: document.getElementById('appContent'),
    tourIdChip: document.getElementById('tourIdChip'),
    errorCard: document.getElementById('errorCard'),
    errorMessage: document.getElementById('errorMessage'),
    statusBadge: document.getElementById('statusBadge'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    welcomeMember: document.getElementById('welcomeMember'),
    memberPhoneMasked: document.getElementById('memberPhoneMasked'),
    tourSummarySection: document.getElementById('tourSummarySection'),
    tourTitleBlock: document.getElementById('tourTitleBlock'),
    dynamicStatsGrid: document.getElementById('dynamicStatsGrid'),
    tourTitle: document.getElementById('tourTitle'),
    tourDestination: document.getElementById('tourDestination'),
    durationInlineBadge: document.getElementById('durationInlineBadge'),
    durationInlineText: document.getElementById('durationInlineText'),
    cardDates: document.getElementById('cardDates'),
    tourDates: document.getElementById('tourDates'),
    cardDuration: document.getElementById('cardDuration'),
    tourDuration: document.getElementById('tourDuration'),
    cardMembers: document.getElementById('cardMembers'),
    tourMembers: document.getElementById('tourMembers'),
    cardHost: document.getElementById('cardHost'),
    tourHost: document.getElementById('tourHost'),
    cardEstimate: document.getElementById('cardEstimate'),
    tourTotalEst: document.getElementById('tourTotalEst'),
    tourPerPersonEst: document.getElementById('tourPerPersonEst'),
    expenseBreakdownSection: document.getElementById('expenseBreakdownSection'),
    expenseBadgeLabel: document.getElementById('expenseBadgeLabel'),
    barLodging: document.getElementById('barLodging'),
    barFood: document.getElementById('barFood'),
    barTravel: document.getElementById('barTravel'),
    barOther: document.getElementById('barOther'),
    pctLodging: document.getElementById('pctLodging'),
    amtLodging: document.getElementById('amtLodging'),
    pctFood: document.getElementById('pctFood'),
    amtFood: document.getElementById('amtFood'),
    pctTravel: document.getElementById('pctTravel'),
    amtTravel: document.getElementById('amtTravel'),
    pctOther: document.getElementById('pctOther'),
    amtOther: document.getElementById('amtOther'),
    onlineRidersBadge: document.getElementById('onlineRidersBadge'),
    phaseBadge: document.getElementById('phaseBadge'),
    radarIcon: document.getElementById('radarIcon'),
    updateTimer: document.getElementById('updateTimer'),
    latVal: document.getElementById('latVal'),
    lngVal: document.getElementById('lngVal'),
    accVal: document.getElementById('accVal'),
    spdVal: document.getElementById('spdVal'),
    fixVal: document.getElementById('fixVal'),
    logTicker: document.getElementById('logTicker'),
    toggleBtn: document.getElementById('toggleBtn'),
    btnIcon: document.getElementById('btnIcon'),
    btnText: document.getElementById('btnText'),
    mapContainer: document.getElementById('mapContainer'),
    mapActions: document.getElementById('mapActions'),
    openMapsLink: document.getElementById('openMapsLink'),
    copyCoordsBtn: document.getElementById('copyCoordsBtn'),
    customModal: document.getElementById('customModal'),
    modalTitle: document.getElementById('modalTitle'),
    modalDesc: document.getElementById('modalDesc'),
    skeletonLoader: document.getElementById('skeletonLoader'),
    mainView: document.getElementById('mainView')
};

/**
 * Case-insensitive lookup across URLSearchParams for any matching key alias
 */
function getQueryParamCaseInsensitive(params, candidateKeys) {
    const lowerCandidates = candidateKeys.map(k => k.toLowerCase());
    for (const [key, value] of params.entries()) {
        if (lowerCandidates.includes(key.toLowerCase()) && value && value.trim() !== '') {
            return value.trim();
        }
    }
    return null;
}

/**
 * Parses query parameters from URL supporting encrypted tokens and plain tourid, memberid, phonenumber,
 * and dynamic Tour Sharing Hub display options without modifying the browser address bar.
 */
async function parseUrlParameters() {
    const params = new URLSearchParams(window.location.search);

    const rawTourId = getQueryParamCaseInsensitive(params, [
        'tourid',
        'tour_id',
        'tour',
        'tid',
        't',
        'id'
    ]);
    const rawMemberId = getQueryParamCaseInsensitive(params, [
        'memberid',
        'member_id',
        'mid',
        'm'
    ]);
    const rawPhone = getQueryParamCaseInsensitive(params, [
        'phonenumber',
        'phone_number',
        'phone',
        'mobile',
        'contact',
        'p'
    ]);
    const rawToken = getQueryParamCaseInsensitive(params, ['token', 'k', 'code']);

    state.tourId = rawTourId ? await decryptAuraToken(rawTourId) : null;
    state.memberIdParam = rawMemberId ? await decryptAuraToken(rawMemberId) : null;
    state.phone = rawPhone ? await decryptAuraToken(rawPhone) : null;
    state.tokenParam = rawToken ? await decryptAuraToken(rawToken) : null;
    state.memberNameParam = getQueryParamCaseInsensitive(params, [
        'name',
        'membername',
        'member_name'
    ]);
    state.customDbUrl = getQueryParamCaseInsensitive(params, ['db', 'database', 'rtdb']);

    // Dynamic Tour Sharing Hub display parameters
    state.urlTourParams = {
        flags: getQueryParamCaseInsensitive(params, ['flags', 'display', 'show']),
        title: getQueryParamCaseInsensitive(params, ['title', 'tourtitle']),
        dest: getQueryParamCaseInsensitive(params, ['dest', 'destination', 'location']),
        duration: getQueryParamCaseInsensitive(params, ['duration', 'dur']),
        start: getQueryParamCaseInsensitive(params, ['start', 'startdate']),
        end: getQueryParamCaseInsensitive(params, ['end', 'enddate']),
        host: getQueryParamCaseInsensitive(params, ['host', 'leader']),
        members: getQueryParamCaseInsensitive(params, ['members', 'pax', 'totalmembers']),
        est: getQueryParamCaseInsensitive(params, ['est', 'estimate', 'totalestimate']),
        pp: getQueryParamCaseInsensitive(params, ['pp', 'perperson']),
        exp: getQueryParamCaseInsensitive(params, ['exp', 'expenses', 'breakdown'])
    };
}

/**
 * Resolves which tour info sections are enabled based on Tour Sharing Hub flags
 */
function resolveDisplayVisibility(meta = {}) {
    const rawFlags = meta.webDisplayFlags || state.urlTourParams.flags;
    const opts = meta.webDisplayOptions;

    if (opts && typeof opts === 'object' && !state.urlTourParams.flags) {
        return {
            title: opts.showTourTitle !== false,
            duration: opts.showDuration !== false,
            dates: opts.showDates !== false,
            host: opts.showHost !== false,
            members: opts.showTotalMembers !== false,
            estimate: opts.showTotalEstimate !== false,
            expenses: opts.showExpenseBreakdown !== false
        };
    }

    if (rawFlags) {
        const lower = String(rawFlags).toLowerCase();
        if (lower === 'none') {
            return {
                title: false,
                duration: false,
                dates: false,
                host: false,
                members: false,
                estimate: false,
                expenses: false
            };
        }
        const tokens = lower.split(',').map(s => s.trim()).filter(Boolean);
        return {
            title: tokens.includes('title'),
            duration: tokens.includes('duration'),
            dates: tokens.includes('dates'),
            host: tokens.includes('host'),
            members: tokens.includes('members'),
            estimate: tokens.includes('estimate'),
            expenses: tokens.includes('expenses')
        };
    }

    // Default when opened via basic URL without explicit flags: show all available sections
    return {
        title: true,
        duration: true,
        dates: true,
        host: true,
        members: true,
        estimate: Boolean(meta.totalEstimate > 0 || state.urlTourParams.est),
        expenses: Boolean(
            meta.lodgingPct > 0 ||
            meta.foodPct > 0 ||
            meta.travelPct > 0 ||
            meta.otherPct > 0 ||
            state.urlTourParams.exp
        )
    };
}

/**
 * Formats Indian Rupee currency cleanly
 */
function formatINR(amount) {
    const num = Number(amount) || 0;
    return '₹' + Math.round(num).toLocaleString('en-IN');
}

/**
 * Formats tour date string e.g. "14 Mar – 17 Mar 2026"
 */
function formatTourDates(startStr, endStr) {
    if (!startStr && !endStr) return 'Dates Flexible';
    const parse = (str) => {
        if (!str) return null;
        const d = new Date(str);
        return isNaN(d) ? null : d;
    };
    const s = parse(startStr);
    const e = parse(endStr);
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };

    if (s && e) {
        return `${s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('en-GB', opts)}`;
    }
    if (s) return `Departs ${s.toLocaleDateString('en-GB', opts)}`;
    return 'Active Schedule';
}

/**
 * Calculates phase badge (Upcoming, Live Active, Completed)
 */
function evaluateTourPhase(startStr, endStr) {
    if (!startStr || !endStr) return { label: 'Active Expedition', color: 'indigo' };
    const now = new Date();
    const s = new Date(startStr);
    const e = new Date(endStr);
    e.setHours(23, 59, 59, 999);

    if (now < s) {
        return { label: 'Upcoming Tour', color: 'sky' };
    }
    if (now > e) {
        return { label: 'Tour Completed', color: 'slate' };
    }
    return { label: 'Live Expedition', color: 'emerald' };
}

/**
 * Parses URL expense string "lodgingPct:lodgingAmt,foodPct:foodAmt,travelPct:travelAmt,otherPct:otherAmt"
 */
function parseExpenseBreakdown(meta = {}) {
    const rawExp = state.urlTourParams.exp;
    if (rawExp) {
        const parts = rawExp.split(',');
        const parsePair = (str, defaultPct) => {
            if (!str) return { pct: defaultPct, amt: 0 };
            const [p, a] = str.split(':');
            return {
                pct: Math.max(0, Math.min(100, Number(p) || 0)),
                amt: Math.max(0, Number(a) || 0)
            };
        };
        const lodging = parsePair(parts[0], 40);
        const food = parsePair(parts[1], 20);
        const travel = parsePair(parts[2], 30);
        const other = parsePair(parts[3], 10);
        return { lodging, food, travel, other };
    }

    const hasCloudBreakdown =
        (meta.lodgingPct || 0) + (meta.foodPct || 0) + (meta.travelPct || 0) + (meta.otherPct || 0) > 0;

    if (hasCloudBreakdown) {
        return {
            lodging: { pct: Number(meta.lodgingPct || 0), amt: Number(meta.lodgingAmount || 0) },
            food: { pct: Number(meta.foodPct || 0), amt: Number(meta.foodAmount || 0) },
            travel: { pct: Number(meta.travelPct || 0), amt: Number(meta.travelAmount || 0) },
            other: { pct: Number(meta.otherPct || 0), amt: Number(meta.otherAmount || 0) }
        };
    }

    const total = Number(meta.totalEstimate || state.urlTourParams.est || 0);
    return {
        lodging: { pct: 40, amt: Math.round(total * 0.4) },
        food: { pct: 20, amt: Math.round(total * 0.2) },
        travel: { pct: 30, amt: Math.round(total * 0.3) },
        other: { pct: 10, amt: Math.round(total * 0.1) }
    };
}

/**
 * Shows custom non-blocking alert modal
 */
export function showModal(title, desc) {
    elements.modalTitle.textContent = title;
    elements.modalDesc.textContent = desc;
    elements.customModal.classList.remove('hidden');
}

export function closeModal() {
    elements.customModal.classList.add('hidden');
}
window.closeModal = closeModal;

/**
 * Updates log ticker entry
 */
function setLog(message) {
    if (elements.logTicker) {
        elements.logTicker.textContent = message;
    }
}

/**
 * Renders error card and hides main content
 */
function displayFatalError(title, message) {
    if (elements.skeletonLoader) elements.skeletonLoader.classList.add('hidden');
    if (elements.mainView) elements.mainView.classList.add('hidden');
    elements.errorCard.classList.remove('hidden');
    elements.errorMessage.innerHTML = `<strong>${title}:</strong> ${message}`;
}

/**
 * Builds provisional tour metadata enriched by URL query parameters
 */
function buildInitialMetaFromUrl() {
    const p = state.urlTourParams;
    let durationDays = 0;
    let durationNights = 0;
    if (p.duration) {
        const match = String(p.duration).match(/(\d+)\s*D[^\d]*(\d+)?\s*N?/i);
        if (match) {
            durationDays = Number(match[1] || 0);
            durationNights = Number(match[2] !== undefined ? match[2] : Math.max(0, durationDays - 1));
        }
    }

    let addedMembersCount = 1;
    let memberCapacity = 1;
    if (p.members) {
        const parts = String(p.members).split('/');
        addedMembersCount = Number(parts[0] || 1);
        memberCapacity = Number(parts[1] || addedMembersCount || 1);
    }

    return {
        title: p.title || `Aura Expedition #${state.tourId}`,
        destination: p.dest || 'Live Expedition Route',
        leaderName: p.host || 'Tour Leader',
        startDate: p.start || '',
        endDate: p.end || '',
        durationDays,
        durationNights,
        addedMembersCount,
        memberCapacity,
        totalEstimate: Number(p.est || 0),
        perPersonEstimate: Number(p.pp || 0),
        webDisplayFlags: p.flags || null,
        isExpirationEnabled: false,
        expiresAt: 0
    };
}

/**
 * Merges cloud metadata with URL query fallbacks
 */
function mergeCloudAndUrlMeta(cloudMeta, syncedFromCloud) {
    const urlMeta = buildInitialMetaFromUrl();
    if (!syncedFromCloud) {
        return urlMeta;
    }
    return {
        ...urlMeta,
        ...cloudMeta,
        title: (cloudMeta.title && !cloudMeta.title.startsWith('Aura Expedition #')) ? cloudMeta.title : urlMeta.title,
        destination: (cloudMeta.destination && cloudMeta.destination !== 'Live Expedition Route') ? cloudMeta.destination : urlMeta.destination,
        leaderName: (cloudMeta.leaderName && cloudMeta.leaderName !== 'Tour Leader') ? cloudMeta.leaderName : urlMeta.leaderName,
        startDate: cloudMeta.startDate || urlMeta.startDate,
        endDate: cloudMeta.endDate || urlMeta.endDate,
        durationDays: cloudMeta.durationDays || urlMeta.durationDays,
        durationNights: cloudMeta.durationNights || urlMeta.durationNights,
        addedMembersCount: cloudMeta.addedMembersCount || urlMeta.addedMembersCount,
        memberCapacity: cloudMeta.memberCapacity || urlMeta.memberCapacity,
        totalEstimate: cloudMeta.totalEstimate || urlMeta.totalEstimate,
        perPersonEstimate: cloudMeta.perPersonEstimate || urlMeta.perPersonEstimate,
        webDisplayFlags: state.urlTourParams.flags || cloudMeta.webDisplayFlags
    };
}

/**
 * Updates the UI with the current tour metadata, matched member, and dynamic visibility options
 */
function renderTourAndMemberUI(tourData, matched) {
    if (elements.skeletonLoader) elements.skeletonLoader.classList.add('hidden');
    if (elements.errorCard) elements.errorCard.classList.add('hidden');
    if (elements.mainView) elements.mainView.classList.remove('hidden');

    if (elements.tourIdChip && state.tourId) {
        elements.tourIdChip.textContent = `TOUR #${state.tourId}`;
    }

    const meta = tourData.meta;
    const visibility = resolveDisplayVisibility(meta);

    // 1. Member Banner
    elements.welcomeMember.textContent = `Welcome, ${matched.memberName}`;
    const rawContact = matched.contact || state.phone || '';
    const displayId = (matched.rawMemberId || matched.memberId || '').replace(/^member_/i, '');
    elements.memberPhoneMasked.textContent = rawContact
        ? maskPhoneNumber(rawContact)
        : `ID #${displayId || matched.memberId}`;

    // 2. Tour Title & Route Header Block
    if (visibility.title) {
        elements.tourTitleBlock.classList.remove('hidden');
        elements.tourTitle.textContent = meta.title || `Aura Expedition #${state.tourId}`;
        elements.tourDestination.textContent = meta.destination || 'Live Expedition Route';

        const phase = evaluateTourPhase(meta.startDate, meta.endDate);
        elements.phaseBadge.textContent = phase.label;

        if (tourData.activeRidersCount > 0) {
            elements.onlineRidersBadge.textContent = `${tourData.activeRidersCount} RIDERS ONLINE`;
        } else {
            elements.onlineRidersBadge.textContent = 'READY TO CONNECT';
        }
    } else {
        elements.tourTitleBlock.classList.add('hidden');
    }

    // 3. Duration Display
    const days = meta.durationDays || 0;
    const nights = meta.durationNights !== undefined ? meta.durationNights : Math.max(0, days - 1);
    const durationLabel = state.urlTourParams.duration
        ? state.urlTourParams.duration.replace('/', ' • ')
        : (days > 0 ? `${days}D • ${nights}N` : 'Flexible Duration');
    const fullDurationLabel = days > 0
        ? `${days} ${days === 1 ? 'Day' : 'Days'} • ${nights} ${nights === 1 ? 'Night' : 'Nights'}`
        : durationLabel;

    if (visibility.duration) {
        elements.cardDuration.classList.remove('hidden');
        elements.tourDuration.textContent = fullDurationLabel;
        if (elements.durationInlineBadge && elements.durationInlineText) {
            elements.durationInlineBadge.classList.remove('hidden');
            elements.durationInlineBadge.classList.add('inline-flex');
            elements.durationInlineText.textContent = durationLabel;
        }
    } else {
        elements.cardDuration.classList.add('hidden');
        if (elements.durationInlineBadge) {
            elements.durationInlineBadge.classList.add('hidden');
            elements.durationInlineBadge.classList.remove('inline-flex');
        }
    }

    // 4. Tour Dates Card
    if (visibility.dates) {
        elements.cardDates.classList.remove('hidden');
        elements.tourDates.textContent = formatTourDates(meta.startDate, meta.endDate);
    } else {
        elements.cardDates.classList.add('hidden');
    }

    // 5. Total Members Card
    if (visibility.members) {
        elements.cardMembers.classList.remove('hidden');
        const added = meta.addedMembersCount || 1;
        const cap = meta.memberCapacity || added;
        elements.tourMembers.textContent = added === cap
            ? `${cap} ${cap === 1 ? 'Rider' : 'Riders'} (PAX)`
            : `${added} of ${cap} Riders`;
    } else {
        elements.cardMembers.classList.add('hidden');
    }

    // 6. Tour Host Card
    if (visibility.host) {
        elements.cardHost.classList.remove('hidden');
        elements.tourHost.textContent = meta.leaderName || 'Tour Leader';
    } else {
        elements.cardHost.classList.add('hidden');
    }

    // 7. Total Estimate Card
    if (visibility.estimate) {
        elements.cardEstimate.classList.remove('hidden');
        const totalEst = Number(meta.totalEstimate || state.urlTourParams.est || 0);
        const ppEst = Number(meta.perPersonEstimate || state.urlTourParams.pp || 0);
        elements.tourTotalEst.textContent = totalEst > 0 ? formatINR(totalEst) : 'Budget Flexible';
        elements.tourPerPersonEst.textContent = ppEst > 0 ? `${formatINR(ppEst)} / PAX` : 'Shared Split';
    } else {
        elements.cardEstimate.classList.add('hidden');
    }

    // Hide dynamicStatsGrid if no stat cards are enabled
    const anyStatCardVisible =
        visibility.dates || visibility.duration || visibility.members || visibility.host || visibility.estimate;
    if (anyStatCardVisible) {
        elements.dynamicStatsGrid.classList.remove('hidden');
    } else {
        elements.dynamicStatsGrid.classList.add('hidden');
    }

    // Hide entire tourSummarySection if neither title nor any stat card is enabled
    if (visibility.title || anyStatCardVisible) {
        elements.tourSummarySection.classList.remove('hidden');
    } else {
        elements.tourSummarySection.classList.add('hidden');
    }

    // 8. Category-Wise Expense Percentage Breakdown Section
    if (visibility.expenses) {
        elements.expenseBreakdownSection.classList.remove('hidden');
        const exp = parseExpenseBreakdown(meta);

        elements.barLodging.style.width = `${Math.max(4, exp.lodging.pct)}%`;
        elements.barFood.style.width = `${Math.max(4, exp.food.pct)}%`;
        elements.barTravel.style.width = `${Math.max(4, exp.travel.pct)}%`;
        elements.barOther.style.width = `${Math.max(4, exp.other.pct)}%`;

        elements.pctLodging.textContent = `${exp.lodging.pct}%`;
        elements.amtLodging.textContent = formatINR(exp.lodging.amt);

        elements.pctFood.textContent = `${exp.food.pct}%`;
        elements.amtFood.textContent = formatINR(exp.food.amt);

        elements.pctTravel.textContent = `${exp.travel.pct}%`;
        elements.amtTravel.textContent = formatINR(exp.travel.amt);

        elements.pctOther.textContent = `${exp.other.pct}%`;
        elements.amtOther.textContent = formatINR(exp.other.amt);

        const sumAmt = exp.lodging.amt + exp.food.amt + exp.travel.amt + exp.other.amt;
        if (elements.expenseBadgeLabel) {
            elements.expenseBadgeLabel.textContent = sumAmt > 0 ? formatINR(sumAmt) : '100% Split';
        }
    } else {
        elements.expenseBreakdownSection.classList.add('hidden');
    }
}

/**
 * Initializes the page on load
 */
async function initApp() {
    await parseUrlParameters();

    // 1. Validate required URL parameters (tourid and memberid or phonenumber)
    if (!state.tourId) {
        displayFatalError(
            'Incomplete Link',
            'Missing <code>tourid</code> parameter in URL. Example: <code>?tourid=6&memberid=1</code> or <code>?tourid=6&phonenumber=9876543210</code>'
        );
        return;
    }

    if (!state.memberIdParam && !state.phone && !state.tokenParam) {
        displayFatalError(
            'Missing Member Identifier',
            'Please include <code>memberid</code> or <code>phonenumber</code> in the URL query string (e.g. <code>?tourid=' +
                state.tourId +
                '&memberid=1</code> or <code>?tourid=' +
                state.tourId +
                '&phonenumber=9876543210</code>).'
        );
        return;
    }

    // 2. Attach button handlers and render provisional UI immediately (never block on network)
    elements.toggleBtn.onclick = toggleLiveTracking;
    elements.copyCoordsBtn.onclick = copyCoordinatesToClipboard;

    // Direct lookup: fetch member record immediately by memberid/phone so member name is retrieved without delay
    let initialMember = null;
    try {
        await initFirebaseService(state.customDbUrl);
        const directMember = await fetchMemberById(state.tourId, state.memberIdParam, state.phone);
        if (directMember) {
            initialMember = directMember;
        }
    } catch {
        // Fallback to offline provisional member
    }

    if (!initialMember) {
        initialMember = findMatchingMember(
            {},
            state.phone,
            state.memberIdParam,
            state.tokenParam,
            state.memberNameParam
        );
    }
    state.matchedMember = initialMember;
    state.tourMeta = buildInitialMetaFromUrl();

    renderTourAndMemberUI(
        { meta: state.tourMeta, activeRidersCount: 0 },
        initialMember
    );
    setLog(`Ready as ${initialMember.memberName}. Tap Start Live Tracking to broadcast GPS.`);

    // 3. Initialize Firebase REST service & fetch cloud tour metadata non-blockingly
    try {
        const tourData = await fetchTourData(state.tourId);
        state.tourMeta = mergeCloudAndUrlMeta(tourData.meta, tourData.syncedFromCloud);

        // Check optional link expiration window if enabled on the tour
        if (state.tourMeta.isExpirationEnabled && state.tourMeta.expiresAt > 0 && Date.now() > state.tourMeta.expiresAt) {
            displayFatalError(
                'Tracking Link Expired',
                'This tour tracking link has passed its active expiration window. Ask the tour host to extend or refresh the link in Tour Sharing Hub.'
            );
            return;
        }

        const matched = findMatchingMember(
            tourData.members,
            state.phone,
            state.memberIdParam,
            state.tokenParam,
            state.memberNameParam
        );

        if (matched && matched.isActive === false) {
            displayFatalError(
                'Account Inactive',
                'Your member entry has been marked inactive for this tour.'
            );
            return;
        }

        if (matched) {
            state.matchedMember = matched;
        }

        renderTourAndMemberUI(
            { ...tourData, meta: state.tourMeta },
            state.matchedMember
        );
        recordMemberLinkOpened(state.tourId, state.matchedMember);

        if (!state.isTracking) {
            setLog(`Connected as ${state.matchedMember.memberName}. Tap Start Live Tracking to broadcast GPS.`);
        }
    } catch {
        // Keep provisional UI active so GPS tracking still works
    }

    // Re-acquire wake lock when tab returns to foreground
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.isTracking) {
            state.wakeLock.acquire();
        }
    });

    // Mark member offline when closing tab
    window.addEventListener('pagehide', () => {
        if (state.isTracking && state.tourId && state.matchedMember) {
            markMemberOffline(state.tourId, state.matchedMember.memberId);
        }
    });
}

/**
 * Toggles GPS live tracking on/off
 */
async function toggleLiveTracking() {
    if (!state.isTracking) {
        startLiveTracking();
    } else {
        stopLiveTracking();
    }
}

/**
 * Starts device geolocation watching and streaming
 */
async function startLiveTracking() {
    if (!navigator.geolocation) {
        showModal('GPS Not Supported', 'Geolocation is not supported by your browser.');
        return;
    }

    setLog('Requesting device GPS permission...');

    // Update status badge to ACQUIRING
    elements.statusBadge.className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold tracking-wide bg-indigo-50 text-indigo-700 border border-indigo-200 shadow-sm';
    elements.statusDot.className = 'w-1.5 h-1.5 rounded-full bg-indigo-600 radar-active-light';
    elements.statusText.textContent = 'ACQUIRING';
    elements.radarIcon.className = 'w-3 h-3 rounded-full bg-indigo-100 flex items-center justify-center radar-active-light';

    // Acquire screen wake lock
    await state.wakeLock.acquire();

    // Query battery
    state.currentBattery = await getBatteryLevel();

    const geoOptions = {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000
    };

    const handlePositionUpdate = async (position) => {
        state.isTracking = true;
        const coords = position.coords;
        state.currentCoords = coords;
        const timestamp = formatTime(position.timestamp);

        // Format coordinates
        const formatted = formatCoordinates(coords.latitude, coords.longitude);
        elements.latVal.textContent = formatted.latStr;
        elements.lngVal.textContent = formatted.lngStr;

        // Secondary metrics
        elements.accVal.textContent = `${Math.round(coords.accuracy)} m`;
        elements.spdVal.textContent = formatSpeed(coords.speed);
        elements.updateTimer.textContent = timestamp;

        const fix = evaluateAccuracy(coords.accuracy);
        elements.fixVal.textContent = fix.label;
        elements.fixVal.className = `font-mono font-bold ${fix.className} mt-0.5`;

        // Update Open in Maps link
        elements.openMapsLink.href = `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`;
        elements.mapActions.classList.remove('hidden');

        // Render Leaflet Mini-Map
        updateMiniMap(coords.latitude, coords.longitude, coords.accuracy);

        // Update UI status to LIVE
        elements.statusBadge.className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold tracking-wide bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-sm';
        elements.statusDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500 live-pulse-emerald';
        elements.statusText.textContent = 'LIVE ACTIVE';

        // Switch button to Stop
        elements.toggleBtn.className = 'w-full py-3.5 px-4 rounded-xl font-bold text-xs uppercase tracking-wider bg-gradient-to-r from-red-600 via-rose-600 to-red-700 text-white shadow-md shadow-red-500/25 active:scale-[0.98] transition-all flex items-center justify-center space-x-2 border border-white/20';
        elements.btnIcon.className = 'fa-solid fa-stop text-xs';
        elements.btnText.textContent = 'Stop Sharing Telemetry';

        // Check throttler before broadcasting to Firebase
        if (state.throttler.shouldSend(coords)) {
            try {
                await writeLivePosition(
                    state.tourId,
                    state.matchedMember.memberId,
                    state.matchedMember.memberName,
                    coords,
                    state.currentBattery,
                    maskPhoneNumber(state.matchedMember.contact || state.phone)
                );
                state.throttler.recordSent(coords);
                setLog(`Telemetry broadcast at ${timestamp} (Acc: ±${Math.round(coords.accuracy)}m)`);
            } catch {
                setLog(`Fix active at ${timestamp} (Acc: ±${Math.round(coords.accuracy)}m)`);
            }
        } else {
            setLog(`Fix acquired at ${timestamp} (Acc: ±${Math.round(coords.accuracy)}m)`);
        }
    };

    // 1. Immediate instantaneous fix via getCurrentPosition (parallel)
    navigator.geolocation.getCurrentPosition(
        handlePositionUpdate,
        () => { /* Silent fallback to watchPosition */ },
        { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
    );

    // 2. Continuous position stream via watchPosition
    state.watchId = navigator.geolocation.watchPosition(
        handlePositionUpdate,
        (error) => {
            let userMessage = 'Unable to acquire precise GPS fix.';
            if (error.code === error.PERMISSION_DENIED) {
                userMessage = 'Location permission was denied. On iOS: Settings > Safari > Location > Allow. On Android: tap lock icon in address bar > Permissions > Location.';
            } else if (error.code === error.POSITION_UNAVAILABLE) {
                userMessage = 'GPS hardware unavailable. Ensure Location Services are turned on.';
            } else if (error.code === error.TIMEOUT) {
                userMessage = 'Location request timed out. Retrying with mobile cellular/WiFi positioning...';
            }
            showModal('Location Notice', userMessage);
            stopLiveTracking();
        },
        geoOptions
    );
}

/**
 * Stops live tracking and marks member offline in Firebase
 */
async function stopLiveTracking() {
    if (state.watchId !== null) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
    }

    state.isTracking = false;
    state.wakeLock.release();
    state.throttler.reset();

    // Mark offline in Firebase RTDB
    if (state.tourId && state.matchedMember) {
        await markMemberOffline(state.tourId, state.matchedMember.memberId);
    }

    // Reset status badge
    elements.statusBadge.className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold tracking-wide bg-amber-50 text-amber-700 border border-amber-200 shadow-sm';
    elements.statusDot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500';
    elements.statusText.textContent = 'STANDBY';
    elements.radarIcon.className = 'w-3 h-3 rounded-full bg-indigo-100 flex items-center justify-center';

    // Reset button
    elements.toggleBtn.className = 'w-full py-3.5 px-4 rounded-xl font-bold text-xs uppercase tracking-wider bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-700 text-white shadow-md shadow-indigo-500/25 active:scale-[0.98] transition-all flex items-center justify-center space-x-2 border border-white/20';
    elements.btnIcon.className = 'fa-solid fa-play text-xs';
    elements.btnText.textContent = 'Start Live Tracking';

    setLog('Live telemetry broadcast stopped.');
}

/**
 * Updates Leaflet mini-map with current location marker and accuracy circle
 */
function updateMiniMap(lat, lng, accuracy) {
    if (typeof L === 'undefined') return;

    elements.mapContainer.classList.remove('hidden');

    if (!state.map) {
        state.map = L.map('miniMap', {
            zoomControl: false,
            attributionControl: true
        }).setView([lat, lng], 16);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap'
        }).addTo(state.map);

        const customIcon = L.divIcon({
            className: 'custom-pin',
            html: '<div style="background-color: #4F46E5; width: 14px; height: 14px; border-radius: 50%; border: 2.5px solid white; box-shadow: 0 0 8px rgba(79,70,229,0.7);"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        });

        state.mapMarker = L.marker([lat, lng], { icon: customIcon }).addTo(state.map);
        state.accuracyCircle = L.circle([lat, lng], {
            radius: accuracy || 20,
            color: '#4F46E5',
            fillColor: '#818CF8',
            fillOpacity: 0.15,
            weight: 1
        }).addTo(state.map);
    } else {
        state.map.setView([lat, lng], 16);
        state.mapMarker.setLatLng([lat, lng]);
        state.accuracyCircle.setLatLng([lat, lng]);
        state.accuracyCircle.setRadius(accuracy || 20);
    }
}

/**
 * Copies formatted coordinates to clipboard
 */
async function copyCoordinatesToClipboard() {
    if (!state.currentCoords) return;
    const text = `${state.currentCoords.latitude.toFixed(6)}, ${state.currentCoords.longitude.toFixed(6)}`;
    try {
        await navigator.clipboard.writeText(text);
        const originalText = elements.copyCoordsBtn.innerHTML;
        elements.copyCoordsBtn.innerHTML = '<i class="fa-solid fa-check text-emerald-600"></i> Copied!';
        setTimeout(() => {
            elements.copyCoordsBtn.innerHTML = originalText;
        }, 2000);
    } catch {
        // Fallback
    }
}

// Kick off initialization when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
