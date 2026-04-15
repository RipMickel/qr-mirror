# 📡 QR Mirror — Production-Ready Screen Mirroring System

Stream your phone screen to a PC browser in real time by simply scanning a QR code.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Node.js Server                          │
│   Express (REST API)  +  Socket.IO (WebRTC Signaling)           │
│   SessionManager      +  QR Generator    +  Logger (Winston)    │
└───────────────┬────────────────────────────┬────────────────────┘
                │  HTTP / WebSocket           │  HTTP / WebSocket
     ┌──────────▼──────────┐      ┌──────────▼──────────┐
     │   PC Browser        │      │   Phone Browser      │
     │   viewer.html       │      │   mobile.html        │
     │   ViewerWebRTC      │◄────►│   StreamerWebRTC     │
     │   (RTCPeerConn.)    │      │   (RTCPeerConn.)     │
     └─────────────────────┘      └──────────────────────┘
                    WebRTC peer-to-peer (media)
```

### Signaling Flow

1. **PC loads viewer.html** → calls `POST /api/session/create` → server generates a unique `roomId` and returns a QR data URL
2. **PC displays QR** + registers with server via `register-viewer`
3. **Phone scans QR** → opens `mobile.html?room=ROOMID`
4. **Phone validates** session via `GET /api/session/:roomId` then registers via `register-streamer`
5. Server emits **`streamer-joined`** to all viewers in the room
6. Viewer emits **`viewer-ready`** → server forwards to streamer
7. Streamer calls `getDisplayMedia()`, creates `RTCPeerConnection`, sends **offer**
8. Server relays offer → viewer creates **answer** → server relays back
9. **ICE candidates** are exchanged through the server until a direct P2P path is found
10. **Media flows directly** phone → PC via WebRTC (server is not in the media path)

---

## File Structure

```
qr-mirror/
├── .env                          # Environment configuration (copy from this file)
├── .gitignore
├── package.json
├── README.md
│
├── src/
│   ├── server/
│   │   ├── index.js              # Express + Socket.IO bootstrap
│   │   └── routes.js             # REST API routes (/api/session/*)
│   │
│   ├── socket/
│   │   └── signalingHandler.js   # All Socket.IO event handlers
│   │
│   └── utils/
│       ├── logger.js             # Winston logger (console + file)
│       ├── sessionManager.js     # In-memory room/session registry
│       ├── qrGenerator.js        # QR code PNG / SVG generation
│       └── webrtcConfig.js       # ICE server config builder
│
├── public/
│   ├── css/
│   │   ├── shared.css            # Design tokens, reset, shared components
│   │   ├── viewer.css            # PC viewer layout & styles
│   │   └── mobile.css            # Phone streamer layout & styles
│   │
│   ├── js/
│   │   ├── socket-client.js      # Socket.IO client wrapper (ES module)
│   │   ├── viewer-webrtc.js      # RTCPeerConnection logic for viewer
│   │   ├── mobile-webrtc.js      # RTCPeerConnection logic for streamer
│   │   ├── viewer.js             # Viewer page controller
│   │   └── mobile.js             # Mobile page controller
│   │
│   └── pages/
│       ├── viewer.html           # PC viewer page
│       └── mobile.html           # Phone streamer page
│
└── logs/                         # Created automatically when LOG_TO_FILE=true
    ├── combined.log
    └── error.log
```

---

## Quick Start

### 1. Install dependencies

```bash
cd qr-mirror
npm install
```

### 2. Configure environment

Edit `.env`:

```env
PORT=3000

# IMPORTANT for LAN use: set this to your machine's local IP
# so the QR code points to an address the phone can reach.
PUBLIC_URL=http://192.168.1.XXX:3000
```

Find your LAN IP:
- **macOS/Linux**: `ifconfig | grep "inet " | grep -v 127`
- **Windows**: `ipconfig` → look for IPv4 Address

### 3. Start the server

```bash
npm start          # production
npm run dev        # development (auto-restart with nodemon)
```

### 4. Open the viewer

Navigate to `http://localhost:3000` (or your LAN IP) on your PC browser.

### 5. Scan the QR code

Use your phone's camera app or any QR scanner. The phone must be on the **same network** as the server (or the server must be publicly accessible).

### 6. Allow screen sharing

Tap **Start Sharing** on the phone and grant screen recording permission when prompted.

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `PUBLIC_URL` | `http://localhost:3000` | Base URL used in QR codes |
| `SESSION_MAX_AGE_MS` | `3600000` | Session TTL (1 hour) |
| `QR_REFRESH_INTERVAL_MS` | `0` | Auto-QR refresh (0 = disabled) |
| `STUN_SERVERS` | Google STUN | Comma-separated STUN URLs |
| `TURN_URL` | _(none)_ | Optional TURN server URL |
| `TURN_USERNAME` | _(none)_ | TURN credential |
| `TURN_CREDENTIAL` | _(none)_ | TURN credential |
| `LOG_LEVEL` | `info` | `error\|warn\|info\|debug` |
| `LOG_TO_FILE` | `true` | Write logs to `./logs/` |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |
| `NODE_ENV` | `development` | `development\|production` |

---

## Production Deployment

### With HTTPS (required for `getDisplayMedia` on most browsers)

```bash
# Using Nginx as a reverse proxy (recommended)
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
    }
}
```

Then set in `.env`:
```env
PUBLIC_URL=https://yourdomain.com
NODE_ENV=production
```

### TURN Server (for strict NAT / corporate networks)

If WebRTC fails through firewalls, deploy a TURN server (e.g. [coturn](https://github.com/coturn/coturn)):

```env
TURN_URL=turn:turn.yourdomain.com:3478
TURN_USERNAME=youruser
TURN_CREDENTIAL=yourpassword
```

### Process management

```bash
npm install -g pm2
pm2 start src/server/index.js --name qr-mirror
pm2 save
pm2 startup
```

---

## Extending the System

### Add authentication
Add a middleware in `src/server/index.js` before the route mounts, or protect the session creation endpoint.

### Redis session store
Replace the `Map` in `src/utils/sessionManager.js` with a Redis client. The module's interface (createSession / getSession / addViewer / setStreamer / removeSocket) stays identical.

### Audio streaming
In `mobile-webrtc.js` → `startCapture()`, add `audio: true` to `getDisplayMedia()` constraints and handle the audio track alongside video.

### Recording
In `viewer-webrtc.js` → `_handleOffer()`, after receiving the stream via `ontrack`, attach a `MediaRecorder` to it and save chunks to disk or cloud storage.

---

## Browser Compatibility

| Feature | Chrome | Firefox | Safari | Chrome Android |
|---|---|---|---|---|
| `getDisplayMedia` | ✅ | ✅ | ✅ 13+ | ⚠️ Limited |
| WebRTC | ✅ | ✅ | ✅ | ✅ |
| ES Modules | ✅ | ✅ | ✅ | ✅ |

> **iOS Note**: `getDisplayMedia` is supported in Safari on iOS 16+. On older devices the system will fall back to the rear camera via `getUserMedia`.

---

## License

MIT
# qr-mirror
