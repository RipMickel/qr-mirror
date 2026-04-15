/**
 * socket-client.js – Socket.IO wrapper with QR token auth
 */

// Extract room ID and token from URL
const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');
const qrToken = params.get('token');

// Create socket with auth
const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 5,
  reconnectionDelay: 1500,
  reconnectionDelayMax: 10000,
  timeout: 10000,
  auth: { roomId, token: qrToken },
});

// ── Simple event bus ──────────────────────────────────────────────────────────
/** @type {Map<string, Set<Function>>} */
const _listeners = new Map();

function onSignal(event, handler) {
  if (!_listeners.has(event)) _listeners.set(event, new Set());

  const handlers = _listeners.get(event);
  if (handlers.has(handler)) {
    console.warn(`[Socket] Handler already registered for: ${event}`);
    return;
  }

  handlers.add(handler);
  socket.on(event, handler);
}

function offSignal(event, handler) {
  socket.off(event, handler);
  _listeners.get(event)?.delete(handler);
}

function sendSignal(event, data) {
  socket.emit(event, data);
}

// ── Connection lifecycle logging ──────────────────────────────────────────────
socket.on('connect', () => {
  console.info(`[Socket] ✓ Connected (${socket.id.substring(0, 8)})`);
});

socket.on('disconnect', (reason) => {
  console.warn(`[Socket] ✗ Disconnected: ${reason}`);
});

socket.on('connect_error', (err) => {
  console.error(`[Socket] ✗ Connect error: ${err.message}`);
});

export { socket, onSignal, offSignal, sendSignal };