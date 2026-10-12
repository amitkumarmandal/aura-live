# Aura Live — Web Telemetry GPS Broadcast

> **Zero-install live location streaming web app for motorcycle tours and expeditions planned in Aura iOS.**  
> Hosted on GitHub Pages: [https://amitkumarmandal.github.io/aura-live/](https://amitkumarmandal.github.io/aura-live/)

---

## 🚀 Overview

Aura Live is a lightweight, zero-dependency progressive web application built with plain ES Modules, Tailwind CSS, and the modular Firebase Realtime Database SDK (v10+).

It allows riders and expedition members without the native Aura iOS / Android app to stream their live GPS coordinates, speed, heading, and battery level directly into the tour's live tracking room in real time.

---

## 🔗 URL Format & Query Parameters

```text
https://amitkumarmandal.github.io/aura-live/?tour=<TOUR_ID>&phone=<PHONE_NUMBER>
```

### Supported Query Parameters

| Parameter | Aliases | Description | Example |
| :--- | :--- | :--- | :--- |
| `tour` | `t`, `tid`, `tourId` | Unique ID of the shared tour expedition | `?tour=1042` |
| `phone` | `p`, `mobile` | Registered mobile number of the rider | `&phone=+919876543210` |
| `m` | `memberId` | Optional explicit member identifier | `&m=member_01` |
| `k` | `token` | Optional security join token | `&k=RT-4K7M` |
| `db` | — | Custom Firebase Realtime Database URL | `&db=https%3A%2F%2F...` |

> **Privacy Guard:** On load, the browser address bar automatically scrubs the raw phone number using `history.replaceState` while keeping `?tour=<TOUR_ID>`. The phone is masked in the UI and database payload (`+91 ••••••3210`).

---

## 📡 Firebase Realtime Database Contract

### 1. Tour Metadata Path
```text
shared_tours/{tourId}/meta
```
Fields:
- `title` (String): Tour Title
- `destination` (String): Destination name
- `leaderName` (String): Expedition leader name
- `startDate` / `endDate` (String: `YYYY-MM-DD`): Tour duration
- `members` (Map): Registered member records matching `MemberCodeInfo`

### 2. Live Telemetry Write Path
```text
shared_tours/{tourId}/live_locations/{memberId}
```
Payload schema matching `LiveLocationManager.swift`:
```json
{
  "member_id": "member_01",
  "member_name": "Amit Mandal",
  "latitude": 20.296058,
  "longitude": 85.824539,
  "speed_kmh": 42.5,
  "heading": 180,
  "battery_level": 88,
  "is_online": true,
  "timestamp": 1728777600000,
  "accuracy_m": 12,
  "source": "web",
  "phone_masked": "+91 ••••••3210"
}
```

### 3. Presence & Disconnection
When the browser tab closes, network drops, or the rider taps **Stop Sharing**:
- `onDisconnect` triggers `is_online: false` with server timestamp.
- Screen Wake Lock is released.

---

## 🔒 Security Rules (`firebase.rules.json`)

To deploy the production security rules using Firebase CLI:
```bash
firebase deploy --only database
```

Rules enforce:
- Coordinate bounds (`latitude` between -90 and 90, `longitude` between -180 and 180).
- Mandatory data types (`latitude` isNumber, `is_online` isBoolean, `timestamp` isNumber).
- Read permission for participants while protecting tour administration.

---

## 🛠️ Testing Checklist

1. **Incomplete Links:**
   - Open without params `/?tour=` ➔ Displays friendly "Incomplete Link" error card.
   - Open without phone `/?tour=1042` ➔ Displays "Missing Phone" card.
2. **Registration Check:**
   - Open with unregistered phone ➔ Displays "Registration Not Found" and disables tracking.
3. **Live Streaming (localhost / HTTPS):**
   - Tap **Start Live Tracking** ➔ Requests browser GPS permissions.
   - Status badge transitions: `STANDBY` ➔ `ACQUIRING` ➔ `LIVE ACTIVE`.
   - Leaflet mini-map appears with custom blue pin and accuracy circle.
   - Throttling ensures writes only occur every ≥10s or ≥20m moved.
4. **Disconnection:**
   - Tap **Stop Sharing** ➔ Immediately updates `is_online: false` in RTDB.

---

## 📱 Browser Considerations

- **HTTPS Required:** Browsers only grant access to `navigator.geolocation` in secure contexts (`https://` or `http://localhost`).
- **Foreground Only:** Web browsers pause JavaScript and geolocation when tabs are placed in the background. Riders are advised to keep the tab open or tap **Add to Home Screen**.
