/**
 * viewer.js – PC Viewer Page Controller
 *
 * Orchestrates:
 *  1. Session creation via REST API
 *  2. QR code display + optional auto-refresh
 *  3. Socket registration ('register-viewer')
 *  4. ViewerWebRTC instantiation
 *  5. UI state machine (idle → waiting → connecting → streaming → error)
 */

import { socket, onSignal, sendSignal } from './socket-client.js';
import { ViewerWebRTC } from './viewer-webrtc.js';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const videoEl         = document.getElementById('remote-video');
const idleOverlay     = document.getElementById('idle-overlay');
const qrImage         = document.getElementById('qr-image');
const qrPlaceholder   = document.getElementById('qr-placeholder');
const roomIdDisplay   = document.getElementById('room-id-display');
const statusBadge     = document.getElementById('status-badge');
const viewerCountEl   = document.getElementById('viewer-count');
const logPanel        = document.getElementById('log-panel');
const btnNewSession   = document.getElementById('btn-new-session');
const btnFullscreen   = document.getElementById('btn-fullscreen');
const btnMute         = document.getElementById('btn-mute');
const qrRefreshBar    = document.getElementById('qr-refresh-bar-fill');
const videoWrapper    = document.getElementById('video-wrapper');
const topbarStatus    = document.getElementById('topbar-status');

// ── State ─────────────────────────────────────────────────────────────────────
let roomId    = null;
let iceConfig = null;
let webrtc    = null;
let qrRefreshTimer   = null;
let qrRefreshInterval = 0;  // ms; 0 = disabled

// ── Logger ───────────────────────────────────────────────────────────────────
function log(msg, level = 'info') {
  const ts   = new Date().toLocaleTimeString();
  const line = document.createElement('span');
  line.className   = `log-line ${level}`;
  line.textContent = `[${ts}] ${msg}`;
  logPanel.appendChild(line);
  logPanel.scrollTop = logPanel.scrollHeight;
  // Keep at most 80 lines
  while (logPanel.children.length > 80) logPanel.removeChild(logPanel.firstChild);
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// ── Status UI ────────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  idle        : { label: 'Idle',        cls: 'idle'      },
  waiting     : { label: 'Waiting…',    cls: 'waiting'   },
  connecting  : { label: 'Connecting…', cls: 'waiting'   },
  streaming   : { label: 'Streaming',   cls: 'connected' },
  error       : { label: 'Error',       cls: 'error'     },
  'streamer-left': { label: 'Disconnected', cls: 'error' },
};

function setStatus(state) {
  const cfg = STATUS_CONFIG[state] || STATUS_CONFIG.idle;
  [statusBadge, topbarStatus].forEach((el) => {
    if (!el) return;
    el.className      = `status-badge ${cfg.cls}`;
    el.querySelector('.badge-text').textContent = cfg.label;
  });

  // Show/hide idle overlay
  const streaming = state === 'streaming';
  idleOverlay.classList.toggle('hidden', streaming);
  videoWrapper.classList.toggle('active', streaming);
}

// ── Session creation ──────────────────────────────────────────────────────────
async function createSession() {
  log('Creating new session…', 'info');
  setStatus('idle');
  qrImage.style.display   = 'none';
  qrPlaceholder.style.display = 'flex';
  roomIdDisplay.textContent = '——————';

  // Destroy previous WebRTC instance if any
  webrtc?.destroy();
  webrtc = null;

  // Clear refresh timer
  clearQrRefreshTimer();

  try {
    const resp = await fetch('/api/session/create', { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    roomId             = data.roomId;
    qrRefreshInterval  = data.qrRefreshInterval || 0;

    log(`Session created: ${roomId}`, 'ok');

    // Show QR
    renderQr(data.qrDataUrl);

    // Display room ID
    roomIdDisplay.textContent = roomId;

    // Register as viewer
    sendSignal('register-viewer', { roomId });

    // Schedule QR refresh
    if (qrRefreshInterval > 0) {
      scheduleQrRefresh();
    }
  } catch (err) {
    log(`Session creation failed: ${err.message}`, 'error');
    setStatus('error');
  }
}

function renderQr(dataUrl) {
  qrImage.src             = dataUrl;
  qrImage.style.display   = 'block';
  qrPlaceholder.style.display = 'none';
  log('QR code displayed', 'debug');
  setStatus('waiting');
}

// ── QR Auto-refresh ───────────────────────────────────────────────────────────
function scheduleQrRefresh() {
  if (!qrRefreshInterval || !roomId) return;

  const startTime = Date.now();

  function tick() {
    const elapsed  = Date.now() - startTime;
    const progress = Math.min((elapsed / qrRefreshInterval) * 100, 100);
    if (qrRefreshBar) qrRefreshBar.style.width = `${progress}%`;
  }

  const tickInterval = setInterval(tick, 500);

  qrRefreshTimer = setTimeout(async () => {
    clearInterval(tickInterval);
    log('Auto-refreshing QR code…', 'info');
    try {
      const resp = await fetch(`/api/session/${roomId}/refresh-qr`, { method: 'POST' });
      const data = await resp.json();
      if (data.success) {
        renderQr(data.qrDataUrl);
        if (qrRefreshBar) qrRefreshBar.style.width = '0%';
        scheduleQrRefresh();
      }
    } catch (e) {
      log(`QR refresh failed: ${e.message}`, 'warn');
    }
  }, qrRefreshInterval);
}

function clearQrRefreshTimer() {
  clearTimeout(qrRefreshTimer);
  qrRefreshTimer = null;
  if (qrRefreshBar) qrRefreshBar.style.width = '0%';
}

// ── Socket signaling ──────────────────────────────────────────────────────────
socket.on('connect', () => {
  log(`Socket connected: ${socket.id}`, 'ok');
  // Re-register if we already have a room
  if (roomId) {
    sendSignal('register-viewer', { roomId });
  }
});

socket.on('disconnect', (reason) => {
  log(`Socket disconnected: ${reason}`, 'warn');
  setStatus('error');
});

onSignal('viewer-registered', ({ roomId: rid, iceConfig: cfg }) => {
  log(`Registered as viewer in room ${rid}`, 'ok');
  iceConfig = cfg;

  // Instantiate WebRTC (waits for streamer-joined before doing anything)
  webrtc = new ViewerWebRTC({
    roomId,
    socketId    : socket.id,
    iceConfig,
    videoEl,
    onStateChange: setStatus,
    onLog       : log,
  });
});

onSignal('streamer-joined', ({ roomId: rid }) => {
  log(`Streamer joined room ${rid} – signalling ready`, 'ok');
  viewerCountEl && (viewerCountEl.textContent = '1');
  webrtc?.signalReady();
  setStatus('connecting');
});

// ── Video controls ────────────────────────────────────────────────────────────
let isMuted = false;

btnFullscreen?.addEventListener('click', () => {
  const wrapper = videoWrapper;
  if (!document.fullscreenElement) {
    wrapper.requestFullscreen?.() || wrapper.webkitRequestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});

btnMute?.addEventListener('click', () => {
  isMuted = !isMuted;
  videoEl.muted = isMuted;
  btnMute.title = isMuted ? 'Unmute' : 'Mute';
  btnMute.textContent = isMuted ? '🔇' : '🔊';
});

btnNewSession?.addEventListener('click', createSession);

// ── Init ──────────────────────────────────────────────────────────────────────
// Create a session automatically when the page loads
createSession();
