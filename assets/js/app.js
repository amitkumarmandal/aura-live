/**
 * Aura Live - Web Application State Machine & Controller
 */

import {
    initFirebaseService,
    fetchTourData,
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
    errorCard: document.getElementById('errorCard'),
    errorMessage: document.getElementById('errorMessage'),
    statusBadge: document.getElementById('statusBadge'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    welcomeMember: document.getElementById('welcomeMember'),
    memberPhoneMasked: document.getElementById('memberPhoneMasked'),
    tourTitle: document.getElementById('tourTitle'),
    tourDestination: document.getElementById('tourDestination'),
    tourDates: document.getElementById('tourDates'),
    tourHost: document.getElementById('tourHost'),
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
 * Parses query parameters from URL supporting simple tourid, memberid, and phonenumber/phone
 * without modifying or rewriting the browser address bar URL.
 */
function parseUrlParameters() {
    const params = new URLSearchParams(window.location.search);

    const tour = getQueryParamCaseInsensitive(params, [
        'tourid',
        'tour_id',
        'tour',
        'tid',
        't',
        'id'
    ]);
    const memberId = getQueryParamCaseInsensitive(params, [
        'memberid',
        'member_id',
        'mid',
        'm'
    ]);
    const phone = getQueryParamCaseInsensitive(params, [
        'phonenumber',
        'phone_number',
        'phone',
        'mobile',
        'contact',
        'p'
    ]);
    const memberName = getQueryParamCaseInsensitive(params, [
        'name',
        'membername',
        'member_name'
    ]);
    const token = getQueryParamCaseInsensitive(params, ['token', 'k', 'code']);
    const db = getQueryParamCaseInsensitive(params, ['db', 'database', 'rtdb']);

    state.tourId = tour;
    state.memberIdParam = memberId;
    state.phone = phone;
    state.memberNameParam = memberName;
    state.tokenParam = token;
    state.customDbUrl = db;
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
    return 'Active Expedition';
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
        return { label: 'Upcoming', color: 'sky' };
    }
    if (now > e) {
        return { label: 'Tour Completed', color: 'slate' };
    }
    return { label: 'Live Expedition', color: 'emerald' };
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
 * Updates the UI with the current tour metadata and matched member
 */
function renderTourAndMemberUI(tourData, matched) {
    if (elements.skeletonLoader) elements.skeletonLoader.classList.add('hidden');
    if (elements.errorCard) elements.errorCard.classList.add('hidden');
    if (elements.mainView) elements.mainView.classList.remove('hidden');

    const meta = tourData.meta;
    elements.tourTitle.textContent = meta.title || `Aura Expedition #${state.tourId}`;
    elements.tourDestination.textContent = meta.destination || 'Live Expedition Route';
    elements.tourDates.textContent = formatTourDates(meta.startDate, meta.endDate);
    elements.tourHost.textContent = meta.leaderName || 'Tour Leader';

    elements.welcomeMember.textContent = `Welcome, ${matched.memberName}`;
    const rawContact = matched.contact || state.phone || '';
    const displayId = (matched.rawMemberId || matched.memberId || '').replace(/^member_/i, '');
    elements.memberPhoneMasked.textContent = rawContact
        ? maskPhoneNumber(rawContact)
        : `ID: ${displayId || matched.memberId}`;

    const phase = evaluateTourPhase(meta.startDate, meta.endDate);
    elements.phaseBadge.textContent = phase.label;

    if (tourData.activeRidersCount > 0) {
        elements.onlineRidersBadge.textContent = `${tourData.activeRidersCount} RIDERS ONLINE`;
    } else {
        elements.onlineRidersBadge.textContent = 'READY TO CONNECT';
    }
}

/**
 * Initializes the page on load
 */
async function initApp() {
    parseUrlParameters();

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

    const provisionalMember = findMatchingMember(
        {},
        state.phone,
        state.memberIdParam,
        state.tokenParam,
        state.memberNameParam
    );
    state.matchedMember = provisionalMember;
    state.tourMeta = {
        title: `Aura Expedition #${state.tourId}`,
        destination: 'Live Expedition Route',
        leaderName: 'Tour Leader',
        startDate: '',
        endDate: '',
        isExpirationEnabled: false,
        expiresAt: 0
    };

    renderTourAndMemberUI(
        { meta: state.tourMeta, activeRidersCount: 0 },
        provisionalMember
    );
    setLog(`Ready as ${provisionalMember.memberName}. Tap Start Live Tracking to broadcast GPS.`);

    // 3. Initialize Firebase REST service & fetch cloud tour metadata non-blockingly
    try {
        await initFirebaseService(state.customDbUrl);
        const tourData = await fetchTourData(state.tourId);
        state.tourMeta = tourData.meta;

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

        renderTourAndMemberUI(tourData, state.matchedMember);
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
    elements.statusBadge.className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold tracking-wide bg-indigo-50 text-indigo-700 border border-indigo-200';
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

    state.watchId = navigator.geolocation.watchPosition(
        async (position) => {
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
            elements.fixVal.className = `font-mono font-semibold ${fix.className} mt-0.5`;

            // Update Open in Maps link
            elements.openMapsLink.href = `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`;
            elements.mapActions.classList.remove('hidden');

            // Render Leaflet Mini-Map
            updateMiniMap(coords.latitude, coords.longitude, coords.accuracy);

            // Update UI status to LIVE
            elements.statusBadge.className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold tracking-wide bg-emerald-50 text-emerald-700 border border-emerald-200';
            elements.statusDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500 live-pulse-emerald';
            elements.statusText.textContent = 'LIVE ACTIVE';

            // Switch button to Stop
            elements.toggleBtn.className = 'w-full py-3 px-4 rounded-xl font-bold text-xs uppercase tracking-wider bg-gradient-to-r from-red-600 via-rose-600 to-red-700 text-white shadow-md shadow-red-500/25 active:scale-[0.98] transition-all flex items-center justify-center space-x-2 border border-white/20';
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
        },
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
    elements.statusBadge.className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold tracking-wide bg-amber-50 text-amber-700 border border-amber-200';
    elements.statusDot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500';
    elements.statusText.textContent = 'STANDBY';
    elements.radarIcon.className = 'w-3 h-3 rounded-full bg-indigo-100 flex items-center justify-center';

    // Reset button
    elements.toggleBtn.className = 'w-full py-3 px-4 rounded-xl font-bold text-xs uppercase tracking-wider bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-700 text-white shadow-md shadow-indigo-500/25 active:scale-[0.98] transition-all flex items-center justify-center space-x-2 border border-white/20';
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
