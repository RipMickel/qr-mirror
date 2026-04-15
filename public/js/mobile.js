/**
 * mobile.js – Phone Streamer with Accept/Decline toast
 * 
 * Flow:
 *  1. Scan QR → Extract room + token from URL
 *  2. Connect via WebSocket with token
 *  3. Show "Accept to stream?" toast
 *  4. If accept → register as streamer → can start capturing
 *  5. If decline → disconnect
 */

import { socket, onSignal, sendSignal } from './socket-client.js';
import { StreamerWebRTC } from './mobile-webrtc.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const roomBadgeId           = document.getElementById('room-badge-id');
const statusBadge           = document.getElementById('mobile-status');
const streamBtn             = document.getElementById('stream-btn');
const btnLabel              = document.getElementById('btn-label');
const previewEl             = document.getElementById('local-preview');
const previewWrap           = document.getElementById('preview-wrap');
const previewPlaceholder    = document.getElementById('preview-placeholder');
const logPanel              = document.getElementById('mobile-log');
const viewerCountEl         = document.getElementById('stat-viewers');
const streamTimeEl          = document.getElementById('stat-time');
const resolutionEl          = document.getElementById('stat-res');
const errorToast            = document.getElementById('error-toast');
const acceptDeclineOverlay  = document.getElementById('accept-decline-overlay'); // NEW
const acceptBtn             = document.getElementById('accept-btn');           // NEW
const declineBtn            = document.getElementById('decline-btn');          // NEW
const toastMessage          = document.getElementById('toast-message');        // NEW

// ── State ─────────────────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');
const qrToken = params.get('token');

let streamer      = null;
let isStreaming   = false;
let streamTimer   = null;
let streamSeconds = 0;
let iceConfig     = null;

// ── Logger ───────────────────────────────────────────────────────────────────
function log(msg, level = 'info') {
  const ts   = new Date().toLocaleTimeString();
  const line = document.createElement('span');
  line.className   = `log-line ${level}`;
  line.textContent = `[${ts}] ${msg}`;
  logPanel?.appendChild(line);
  if (logPanel) logPanel.scrollTop = logPanel.scrollHeight;
  while (logPanel?.children.length > 60) logPanel.removeChild(logPanel.firstChild);
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 4000) {
  if (!errorToast) return;
  errorToast.textContent = msg;
  errorToast.classList.add('show');
  setTimeout(() => errorToast.classList.remove('show'), duration);
}

// ── NEW: Accept/Decline Toast ─────────────────────────────────────────────────
function showAcceptDeclineToast() {
  if (!acceptDeclineOverlay) {
    log('Accept/decline overlay not found in DOM', 'error');
    return;
  }

  acceptDeclineOverlay.classList.add('show');
  toastMessage.textContent = `Start streaming from room ${roomId}?`;

  // Disable buttons temporarily to prevent double-click
  acceptBtn.disabled = false;
  declineBtn.disabled = false;

  const handleAccept = () => {
    log('User ACCEPTED – registering as streamer', 'ok');
    acceptDeclineOverlay.classList.remove('show');
    acceptBtn.removeEventListener('click', handleAccept);
    declineBtn.removeEventListener('click', handleDecline);
    registerAsStreamer();
  };

  const handleDecline = () => {
    log('User DECLINED', 'warn');
    acceptDeclineOverlay.classList.remove('show');
    acceptBtn.removeEventListener('click', handleAccept);
    declineBtn.removeEventListener('click', handleDecline);
    socket.disconnect();
    setStatus('error');
    showToast('Connection declined');
  };

  acceptBtn.addEventListener('click', handleAccept);
  declineBtn.addEventListener('click', handleDecline);
}

// ── Status UI ────────────────────────────────────────────────────────────────
const STATUS_MAP = {
  idle       : { label: 'Idle',        cls: 'idle'      },
  waiting    : { label: 'Waiting…',    cls: 'waiting'   },
  ready      : { label: 'Ready',       cls: 'waiting'   },
  capturing  : { label: 'Capturing…',  cls: 'waiting'   },
  streaming  : { label: 'Live',        cls: 'connected' },
  stopped    : { label: 'Stopped',     cls: 'idle'      },
  error      : { label: 'Error',       cls: 'error'     },
};

function setStatus(state) {
  const cfg = STATUS_MAP[state] || STATUS_MAP.idle;
  if (statusBadge) {
    statusBadge.className = `status-badge ${cfg.cls}`;
    const txt = statusBadge.querySelector('.badge-text');
    if (txt) txt.textContent = cfg.label;
  }

  if (state === 'streaming') {
    streamBtn.classList.add('streaming');
    btnLabel.textContent = '⏹ Stop Sharing';
    startStreamTimer();
  } else if (state === 'stopped' || state === 'idle' || state === 'error') {
    streamBtn.classList.remove('streaming');
    btnLabel.textContent = '📡 Start Sharing';
    stopStreamTimer();
    isStreaming = false;
    viewerCountEl && (viewerCountEl.textContent = '0');
    streamBtn.disabled = false;
  }
}

// ── Stream timer ──────────────────────────────────────────────────────────────
function startStreamTimer() {
  streamSeconds = 0;
  streamTimer   = setInterval(() => {
    streamSeconds++;
    const h = String(Math.floor(streamSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((streamSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(streamSeconds % 60).padStart(2, '0');
    if (streamTimeEl) streamTimeEl.textContent = `${h}:${m}:${s}`;
  }, 1000);
}

function stopStreamTimer() {
  clearInterval(streamTimer);
  if (streamTimeEl) streamTimeEl.textContent = '00:00:00';
}

// ── Socket setup ──────────────────────────────────────────────────────────────
socket.on('connect', () => {
  log(`Socket connected: ${socket.id.substring(0, 8)}`, 'ok');
  log('Waiting for user to accept/decline…', 'info');
  setStatus('waiting');
  
  // Show accept/decline toast ONLY on successful connection
  showAcceptDeclineToast();
});

socket.on('disconnect', (reason) => {
  log(`Socket disconnected: ${reason}`, 'warn');
  if (isStreaming) showToast('Connection lost. Reconnecting…');
});

socket.on('connect_error', (err) => {
  log(`Connection error: ${err.message}`, 'error');
  if (err.message.includes('token')) {
    showToast('Invalid QR code. Please scan again.');
  } else {
    showToast(`Connection error: ${err.message}`);
  }
  setStatus('error');
});

onSignal('streamer-registered', ({ iceConfig: cfg }) => {
  log('Registered as streamer ✓', 'ok');
  iceConfig = cfg;
  setStatus('ready');

  streamer = new StreamerWebRTC({
    roomId,
    iceConfig,
    previewEl,
    onStateChange       : setStatus,
    onLog               : log,
    onViewerCountChange : (count) => {
      if (viewerCountEl) viewerCountEl.textContent = String(count);
    },
  });
});

onSignal('error-event', ({ message }) => {
  log(`Server error: ${message}`, 'error');
  showToast(message);
  setStatus('error');
});

// ── NEW: Register as streamer function ────────────────────────────────────────
function registerAsStreamer() {
  if (!roomId) {
    log('No room ID available', 'error');
    setStatus('error');
    return;
  }

  log('Registering as streamer…', 'info');
  sendSignal('register-streamer', { roomId });
}

// ── Session validation (optional check) ───────────────────────────────────────
async function validateSession() {
  if (!roomId) {
    log('No room ID in URL', 'error');
    showToast('No room ID found. Please scan the QR code again.');
    setStatus('error');
    streamBtn.disabled = true;
    return false;
  }

  try {
    const resp = await fetch(`/api/session/${roomId}`);
    if (!resp.ok) {
      log(`Room ${roomId} not found on server`, 'error');
      showToast('Session expired or invalid. Please get a fresh QR code.');
      setStatus('error');
      streamBtn.disabled = true;
      return false;
    }
    log(`Session ${roomId} validated ✓`, 'ok');
    roomBadgeId.textContent = roomId;
    return true;
  } catch (err) {
    log(`Validation request failed: ${err.message}`, 'error');
    showToast('Could not reach server. Check your network.');
    setStatus('error');
    return false;
  }
}

// ── Start / stop button ───────────────────────────────────────────────────────
streamBtn.addEventListener('click', async () => {
  if (isStreaming) {
    // Stop
    streamer?.destroy();
    isStreaming = false;
    previewWrap && (previewPlaceholder.style.display = 'flex');
    log('Stream stopped by user', 'warn');
    setStatus('stopped');
    return;
  }

  // Start
  if (!streamer) {
    showToast('Not connected to server yet. Please wait…');
    return;
  }

  streamBtn.disabled = true;

  try {
    const stream = await streamer.startCapture();
    isStreaming = true;
    streamBtn.disabled = false;

    if (previewEl && previewWrap) {
      previewPlaceholder.style.display = 'none';
      previewEl.style.display          = 'block';
    }

    const track = stream.getVideoTracks()[0];
    if (track && resolutionEl) {
      const settings = track.getSettings();
      resolutionEl.textContent = settings.width ? `${settings.width}×${settings.height}` : 'HD';
    }
  } catch (err) {
    streamBtn.disabled = false;
    isStreaming = false;

    if (err.message === 'PERMISSION_DENIED') {
      showToast('Screen share permission denied. Please allow screen recording.');
      log('Permission denied by user', 'error');
    } else {
      showToast(`Capture failed: ${err.message}`);
      log(`Capture error: ${err.message}`, 'error');
    }
    setStatus('error');
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const valid = await validateSession();
  if (!valid) return;

  log(`Joining room ${roomId}. Connecting to signaling server…`, 'info');
  setStatus('idle');
  // Socket will connect and show accept/decline toast in 'connect' handler above
})();