/**
 * socket-client.js – Thin wrapper around socket.io-client
 *
 * Provides a single shared socket instance and a lightweight event bus so
 * that the WebRTC modules can listen for signaling events without importing
 * socket.io themselves.
 *
 * Usage:
 *   import { socket, onSignal, sendSignal } from './socket-client.js';
 */

// ── Create the socket connection ─────────────────────────────────────────────
// socket.io client is loaded from the server's static bundle at /socket.io/socket.io.js
const socket = io({
  transports       : ['websocket', 'polling'],
  reconnectionAttempts: 5,
  reconnectionDelay   : 1500,
  timeout             : 10000,
});

// ── Simple event bus ─────────────────────────────────────────────────────────
/** @type {Map<string, Set<Function>>} */
const _listeners = new Map();

/**
 * Subscribe to a signaling event.
 * @param {string}   event
 * @param {Function} handler
 */
function onSignal(event, handler) {
  if (!_listeners.has(event)) _listeners.set(event, new Set());
  _listeners.get(event).add(handler);
  socket.on(event, handler);
}

/**
 * Remove a signaling event listener.
 */
function offSignal(event, handler) {
  socket.off(event, handler);
  _listeners.get(event)?.delete(handler);
}

/**
 * Emit a signaling event.
 */
function sendSignal(event, data) {
  socket.emit(event, data);
}

// ── Connection lifecycle logging ─────────────────────────────────────────────
socket.on('connect',           () => console.info('[Socket] Connected ›', socket.id));
socket.on('disconnect',  (r)  => console.warn('[Socket] Disconnected ›', r));
socket.on('reconnecting', (n) => console.info(`[Socket] Reconnecting (attempt ${n})…`));
socket.on('reconnect_failed',  () => console.error('[Socket] Reconnection failed'));
socket.on('connect_error', (e) => console.error('[Socket] Connect error ›', e.message));
socket.on('error-event', (e)  => console.error('[Socket] Server error ›', e.message));

export { socket, onSignal, offSignal, sendSignal };
