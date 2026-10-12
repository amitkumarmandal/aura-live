/**
 * Aura Live - Web Application State Machine & Controller
 */

import {
    initFirebaseService,
    fetchTourData,
    findMatchingMember,
    writeLivePosition,
    markMemberOffline
} from './firebase.js';

import {
    formatCoordinates,
    formatSpeed,
    evaluateAccuracy,
    formatTime,
    normalizePhoneNumber,
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
 * Parses query parameters from URL supporting aliases
 */
function parseUrlParameters() {
    const params = new URLSearchParams(window.location.search);

    const tour = params.get('tour') || params.get('t') || params.get('tid') || params.get('tourId') || params.get('id');
    const phone = params.get('phone') || params.get('p') || params.get('mobile') || params.get('contact');
    const m = params.get('m') || params.get('memberId');
    const k = params.get('k') || params.get('token');
    const db = params.get('db');

    state.tourId = tour ? tour.trim() : null;
    state.phone = phone ? phone.trim() : null;
    state.memberIdParam = m ? m.trim() : null;
    state.tokenParam = k ? k.trim() : null;
    state.customDbUrl = db ? decodeURIComponent(db.trim()) : null;

    // Sanitize address bar for privacy: keep ?tour=..., remove raw phone
    if (state.tourId) {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('phone');
        cleanUrl.searchParams.delete('p');
        cleanUrl.searchParams.delete('mobile');
        cleanUrl.searchParams.delete('contact');
        window.history.replaceState({}, document.title, cleanUrl.toString());
    }
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
 * Appends log ticker entry with timestamp
 */
function setLog(message) {
    elements.logTicker.textContent = message;
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
 * Initializes the page on load
 */
async function initApp() {
    parseUrlParameters();

    // 1. Validate required URL parameters
    if (!state.tourId) {
        displayFatalError(
            'Incomplete Link',
            'Missing Tour ID parameter in URL. Please open the link sent by your tour leader.'
        );
        return;
    }

    if (!state.phone && !state.memberIdParam && !state.tokenParam) {
        displayFatalError(
            'Missing Phone',
            'This link does not specify your registered mobile number (?tour=&phone=). Ask your tour leader for your member tracking link.'
        );
        return;
    }

    try {
        setLog('Connecting to tour telemetry...');

        // 2. Initialize Firebase service
        await initFirebaseService(state.customDbUrl);

        // 3. Fetch Tour metadata and registered members
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

        // 4. Match user phone to member
        const matched = findMatchingMember(
            tourData.members,
            state.phone,
            state.memberIdParam,
            state.tokenParam
        );

        if (!matched) {
            displayFatalError(
                'Registration Not Found',
                `Mobile number (${maskPhoneNumber(state.phone)}) is not registered in this tour. Please verify your contact with the expedition host.`
            );
            return;
        }

        if (matched.isActive === false) {
            displayFatalError(
                'Account Inactive',
                'Your member entry has been marked inactive for this tour.'
            );
            return;
        }

        state.matchedMember = matched;

        // 5. Populate UI
        elements.skeletonLoader.classList.add('hidden');
        elements.mainView.classList.remove('hidden');

        elements.tourTitle.textContent = state.tourMeta.title;
        elements.tourDestination.textContent = state.tourMeta.destination || 'Expedition Route';
        elements.tourDates.textContent = formatTourDates(state.tourMeta.startDate, state.tourMeta.endDate);
        elements.tourHost.textContent = state.tourMeta.leaderName || 'Aura Host';

        elements.welcomeMember.textContent = `Welcome, ${matched.memberName}`;
        elements.memberPhoneMasked.textContent = maskPhoneNumber(matched.contact || state.phone);

        const phase = evaluateTourPhase(state.tourMeta.startDate, state.tourMeta.endDate);
        elements.phaseBadge.textContent = phase.label;

        if (tourData.activeRidersCount > 0) {
            elements.onlineRidersBadge.textContent = `${tourData.activeRidersCount} RIDERS ONLINE`;
        } else {
            elements.onlineRidersBadge.textContent = 'READY TO CONNECT';
        }

        setLog(`Connected as ${matched.memberName}. Ready to start GPS.`);

        // Attach action handlers
        elements.toggleBtn.onclick = toggleLiveTracking;
        elements.copyCoordsBtn.onclick = copyCoordinatesToClipboard;

        // Listen for visibility change to re-acquire wake lock if needed
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && state.isTracking) {
                state.wakeLock.acquire();
            }
        });

    } catch (err) {
        displayFatalError('Connection Error', err.message);
    }
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
                } catch (sendErr) {
                    console.warn('Realtime write error:', sendErr.message);
                    setLog(`Offline - Cached fix at ${timestamp}`);
                }
            } else {
                setLog(`Fix acquired at ${timestamp} (Acc: ±${Math.round(coords.accuracy)}m)`);
            }
        },
        (error) => {
            console.warn(`Geolocation error (${error.code}):`, error.message);
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
