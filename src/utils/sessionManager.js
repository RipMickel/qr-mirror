/**
 * sessionManager.js – In-memory session / room registry
 *
 * Each "session" maps to a unique room.  A room tracks:
 *   - The viewer socket ID (PC)
 *   - The streamer socket ID (Phone) – at most one active streamer per room
 *   - Additional viewer socket IDs (many-viewers support)
 *   - Creation timestamp (for TTL cleanup)
 *
 * This module is intentionally stateless (pure functions operating on a Map)
 * so it can be replaced by a Redis adapter for multi-server deployments
 * without changing the rest of the code.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const logger         = require('./logger');

// ── Internal state ───────────────────────────────────────────────────────────
/** @type {Map<string, Session>} */
const sessions = new Map();

const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE_MS || '3600000', 10);

/**
 * @typedef {Object} Session
 * @property {string}   roomId       - Unique room identifier (UUID v4)
 * @property {string|null} streamerSocketId  - Socket ID of the active streamer
 * @property {Set<string>} viewerSocketIds   - All viewer socket IDs
 * @property {number}   createdAt    - Unix timestamp (ms)
 * @property {number}   lastActivity - Unix timestamp (ms)
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a short, URL-safe room token derived from a UUID. */
function generateRoomId() {
  // Take the first 12 characters of a UUID (minus hyphens) – collision risk is
  // negligible at the scale this server operates.
  return uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase();
}

function now() {
  return Date.now();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new session and return it.
 * @returns {Session}
 */
function createSession() {
  const roomId = generateRoomId();
  /** @type {Session} */
  const session = {
    roomId,
    streamerSocketId : null,
    viewerSocketIds  : new Set(),
    createdAt        : now(),
    lastActivity     : now(),
  };
  sessions.set(roomId, session);
  logger.info('Session created', { roomId });
  return session;
}

/**
 * Look up an existing session by room ID.
 * @param {string} roomId
 * @returns {Session|null}
 */
function getSession(roomId) {
  return sessions.get(roomId) || null;
}

/**
 * Register a viewer socket for a session.
 * @param {string} roomId
 * @param {string} socketId
 * @returns {Session|null}
 */
function addViewer(roomId, socketId) {
  const session = getSession(roomId);
  if (!session) return null;
  session.viewerSocketIds.add(socketId);
  session.lastActivity = now();
  logger.info('Viewer joined', { roomId, socketId, totalViewers: session.viewerSocketIds.size });
  return session;
}

/**
 * Register the streamer socket for a session.
 * Only one streamer is allowed per session at a time.
 * @param {string} roomId
 * @param {string} socketId
 * @returns {{ session: Session, replaced: boolean }|null}
 */
function setStreamer(roomId, socketId) {
  const session = getSession(roomId);
  if (!session) return null;
  const replaced = session.streamerSocketId !== null;
  session.streamerSocketId = socketId;
  session.lastActivity = now();
  logger.info('Streamer set', { roomId, socketId, replaced });
  return { session, replaced };
}

/**
 * Remove a socket (viewer or streamer) from its session.
 * Returns the session and the role the socket held.
 * @param {string} socketId
 * @returns {{ session: Session, role: 'streamer'|'viewer'|'unknown' }|null}
 */
function removeSocket(socketId) {
  for (const [roomId, session] of sessions) {
    if (session.streamerSocketId === socketId) {
      session.streamerSocketId = null;
      session.lastActivity = now();
      logger.info('Streamer removed', { roomId, socketId });
      return { session, role: 'streamer' };
    }
    if (session.viewerSocketIds.has(socketId)) {
      session.viewerSocketIds.delete(socketId);
      session.lastActivity = now();
      logger.info('Viewer removed', { roomId, socketId, remainingViewers: session.viewerSocketIds.size });
      return { session, role: 'viewer' };
    }
  }
  return null;
}

/**
 * Delete a session entirely.
 * @param {string} roomId
 */
function destroySession(roomId) {
  if (sessions.delete(roomId)) {
    logger.info('Session destroyed', { roomId });
  }
}

/**
 * Return a sanitised summary of all active sessions (for admin/debug).
 * @returns {Array}
 */
function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    roomId         : s.roomId,
    hasStreamer     : s.streamerSocketId !== null,
    viewerCount    : s.viewerSocketIds.size,
    ageMs          : now() - s.createdAt,
    lastActivityMs : now() - s.lastActivity,
  }));
}

// ── TTL cleanup ──────────────────────────────────────────────────────────────
// Periodically purge sessions that have been idle for longer than SESSION_MAX_AGE.
setInterval(() => {
  const cutoff = now() - SESSION_MAX_AGE;
  for (const [roomId, session] of sessions) {
    if (session.lastActivity < cutoff) {
      logger.warn('Purging stale session', { roomId });
      sessions.delete(roomId);
    }
  }
}, 60_000); // run every minute

module.exports = {
  createSession,
  getSession,
  addViewer,
  setStreamer,
  removeSocket,
  destroySession,
  listSessions,
};
