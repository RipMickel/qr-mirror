/**
 * mobile.js – Phone Streamer Page Controller
 *
 * Orchestrates:
 *  1. Parse roomId from URL query string
 *  2. Validate session via REST
 *  3. Register as streamer via Socket.IO ('register-streamer')
 *  4. Handle user action to start screen capture
 *  5. Instantiate StreamerWebRTC and manage UI
 */

import { socket, onSignal, sendSignal } from './socket-client.js';
import { StreamerWebRTC } from './mobile-webrtc.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const roomBadgeId   = document.getElementById('room-badge-id');
const statusBadge   = document.getElementById('mobile-status');
const streamBtn     = document.getElementById('stream-btn');
const btnLabel      = document.getElementById('btn-label');
const previewEl     = document.getElementById('local-preview');
const previewWrap   = document.getElementById('preview-wrap');
const previewPlaceholder = document.getElementById('preview-placeholder');
const logPanel      = document.getElementById('mobile-log');
const viewerCountEl = document.getElementById('stat-viewers');
const streamTimeEl  = document.getElementById('stat-time');
const resolutionEl  = document.getElementById('stat-res');
const errorToast    = document.getElementById('error-toast');

// ── State ─────────────────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const roomId = params.get('room') || params.get('roomId') || null;

let streamer      = null;
let isStreaming   = false;
let streamTimer   = null;
let streamSeconds = 0;

// ── Logger ───────────────────────────────────────────────────────────────────
function log(msg, level = 'info') {
  const ts   = new Date().toLocaleTimeString();
  const line = document.createElement('span');
  line.className   = `log-line ${level}`;
  line.textContent = `[${ts}] ${msg}`;
  logPanel?.appendChild(line);
  if (logPanel) logPanel.scrollTop = logPanel.scrollHeight;
  while (logPanel?.children.length > 60) logPanel.removeChild(logPanel.firstChild);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 4000) {
  if (!errorToast) return;
  errorToast.textContent = msg;
  errorToast.classList.add('show');
  setTimeout(() => errorToast.classList.remove('show'), duration);
}

// ── Status ────────────────────────────────────────────────────────────────────
const STATUS_MAP = {
  idle       : { label: 'Idle',        cls: 'idle'      },
  validating : { label: 'Validating…', cls: 'waiting'   },
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

// ── Session validation ────────────────────────────────────────────────────────
async function validateSession() {
  if (!roomId) {
    log('No room ID in URL', 'error');
    showToast('No room ID found. Please scan the QR code again.');
    setStatus('error');
    streamBtn.disabled = true;
    return false;
  }

  setStatus('validating');
  roomBadgeId.textContent = roomId;

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
    return true;
  } catch (err) {
    log(`Validation request failed: ${err.message}`, 'error');
    showToast('Could not reach server. Check your network.');
    setStatus('error');
    return false;
  }
}

// ── Socket setup ──────────────────────────────────────────────────────────────
let iceConfig = null;

socket.on('connect', () => {
  log(`Socket connected: ${socket.id}`, 'ok');
  if (roomId) {
    sendSignal('register-streamer', { roomId });
  }
});

socket.on('disconnect', (reason) => {
  log(`Socket disconnected: ${reason}`, 'warn');
  if (isStreaming) showToast('Connection lost. Reconnecting…');
});

onSignal('streamer-registered', ({ iceConfig: cfg }) => {
  log('Registered as streamer ✓', 'ok');
  iceConfig = cfg;
  setStatus('ready');

  // Instantiate the WebRTC manager
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

    // Show preview
    if (previewEl && previewWrap) {
      previewPlaceholder.style.display = 'none';
      previewEl.style.display          = 'block';
    }

    // Update resolution display
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
  log(`Joined room ${roomId}. Connecting to signaling server…`, 'info');
  setStatus('idle');
})();
