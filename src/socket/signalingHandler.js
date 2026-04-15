/**
 * signalingHandler.js – Socket.IO event handlers for WebRTC signaling
 *
 * Signaling flow overview
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  PC (viewer)                  Server                  Phone (streamer)
 *  ──────────────────────────────────────────────────────────────────────
 *  connect ──────────────────► register-viewer
 *                               (joins Socket.IO room)
 *
 *  ◄──────── streamer-joined ──  (forwarded when phone connects)
 *
 *                               register-streamer ◄────── connect + scan
 *                               (joins Socket.IO room)
 *
 *  ◄── viewer-ready ──────────  (forwarded to streamer: "begin offer")
 *
 *                               webrtc-offer ◄──────────── createOffer()
 *  ◄── webrtc-offer ──────────  (relayed to all viewers)
 *
 *  createAnswer() ──────────── webrtc-answer ──────────► (relayed to streamer)
 *
 *                               ice-candidate ◄─────────── (both sides)
 *  ◄──────── ice-candidate ──  (relayed to opposite peer)
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const sessionManager = require('../utils/sessionManager');
const { buildIceConfig } = require('../utils/webrtcConfig');
const logger = require('../utils/logger');

/**
 * Attach all signaling event listeners to an individual socket.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server}  io
 */
function attachSignalingHandlers(socket, io) {

  // ── Helper: broadcast to everyone in a room except sender ────────────────
  const toRoom = (roomId, event, data) =>
    socket.to(roomId).emit(event, data);

  // ── Helper: send only to a specific socket ID ─────────────────────────────
  const toSocket = (socketId, event, data) =>
    io.to(socketId).emit(event, data);

  // ──────────────────────────────────────────────────────────────────────────
  // VIEWER: PC registers itself as the room owner / viewer
  // ──────────────────────────────────────────────────────────────────────────
  socket.on('register-viewer', ({ roomId }) => {
    if (!roomId) {
      return socket.emit('error-event', { message: 'register-viewer: roomId is required' });
    }

    const session = sessionManager.addViewer(roomId, socket.id);
    if (!session) {
      return socket.emit('error-event', { message: `Room ${roomId} not found` });
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role   = 'viewer';

    // Acknowledge with ICE config so the client can set up RTCPeerConnection
    socket.emit('viewer-registered', {
      roomId,
      iceConfig: buildIceConfig(),
    });

    // If a streamer is already in the room, tell this viewer immediately
    if (session.streamerSocketId) {
      socket.emit('streamer-joined', { roomId });
    }

    logger.info('Viewer registered', { roomId, socketId: socket.id });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // STREAMER: Phone registers itself as the stream source
  // ──────────────────────────────────────────────────────────────────────────
  socket.on('register-streamer', ({ roomId }) => {
    if (!roomId) {
      return socket.emit('error-event', { message: 'register-streamer: roomId is required' });
    }

    const result = sessionManager.setStreamer(roomId, socket.id);
    if (!result) {
      return socket.emit('error-event', { message: `Room ${roomId} not found` });
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role   = 'streamer';

    // Acknowledge with ICE config
    socket.emit('streamer-registered', {
      roomId,
      iceConfig: buildIceConfig(),
    });

    // Notify ALL viewers in the room that a streamer is available
    toRoom(roomId, 'streamer-joined', { roomId });

    logger.info('Streamer registered', { roomId, socketId: socket.id });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // VIEWER → STREAMER: viewer is ready to receive an offer
  // (triggered after viewer hears 'streamer-joined')
  // ──────────────────────────────────────────────────────────────────────────
  socket.on('viewer-ready', ({ roomId }) => {
    const session = sessionManager.getSession(roomId);
    if (!session || !session.streamerSocketId) {
      return socket.emit('error-event', { message: 'No active streamer for this room' });
    }
    // Tell the streamer to begin the WebRTC offer towards this specific viewer
    toSocket(session.streamerSocketId, 'viewer-ready', {
      roomId,
      viewerSocketId: socket.id,
    });
    logger.debug('viewer-ready forwarded', { roomId, viewerSocketId: socket.id });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // STREAMER → VIEWER: relay WebRTC offer
  // payload: { roomId, sdp, targetViewerSocketId }
  // ──────────────────────────────────────────────────────────────────────────
  socket.on('webrtc-offer', ({ roomId, sdp, targetViewerSocketId }) => {
    if (!sdp) return;
    logger.debug('Relaying WebRTC offer', { roomId, targetViewerSocketId });

    if (targetViewerSocketId) {
      // Unicast to a specific viewer
      toSocket(targetViewerSocketId, 'webrtc-offer', { sdp, streamerSocketId: socket.id });
    } else {
      // Broadcast to all viewers in room (legacy / 1-to-many without targeting)
      toRoom(roomId, 'webrtc-offer', { sdp, streamerSocketId: socket.id });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // VIEWER → STREAMER: relay WebRTC answer
  // payload: { roomId, sdp, streamerSocketId }
  // ──────────────────────────────────────────────────────────────────────────
  socket.on('webrtc-answer', ({ roomId, sdp, streamerSocketId }) => {
    if (!sdp) return;
    logger.debug('Relaying WebRTC answer', { roomId });
    const targetId = streamerSocketId || sessionManager.getSession(roomId)?.streamerSocketId;
    if (targetId) {
      toSocket(targetId, 'webrtc-answer', { sdp, viewerSocketId: socket.id });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ICE candidate relay – bidirectional
  // payload: { roomId, candidate, targetSocketId }
  // ──────────────────────────────────────────────────────────────────────────
  socket.on('ice-candidate', ({ roomId, candidate, targetSocketId }) => {
    if (!candidate) return;

    if (targetSocketId) {
      toSocket(targetSocketId, 'ice-candidate', { candidate, fromSocketId: socket.id });
    } else {
      // Fallback: if role is streamer, send to all viewers; if viewer send to streamer
      const session = sessionManager.getSession(roomId);
      if (!session) return;

      if (socket.data.role === 'streamer') {
        session.viewerSocketIds.forEach((vid) => {
          toSocket(vid, 'ice-candidate', { candidate, fromSocketId: socket.id });
        });
      } else if (socket.data.role === 'viewer' && session.streamerSocketId) {
        toSocket(session.streamerSocketId, 'ice-candidate', { candidate, fromSocketId: socket.id });
      }
    }
    logger.debug('ICE candidate relayed', { from: socket.id, targetSocketId });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Disconnect – clean up session state
  // ──────────────────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    logger.info('Socket disconnected', { socketId: socket.id, reason });

    const result = sessionManager.removeSocket(socket.id);
    if (!result) return;

    const { session, role } = result;

    if (role === 'streamer') {
      // Inform all viewers that the stream ended
      toRoom(session.roomId, 'streamer-left', {
        roomId: session.roomId,
        reason,
      });
      logger.warn('Streamer disconnected – viewers notified', { roomId: session.roomId });
    } else if (role === 'viewer') {
      // Inform the streamer so it can close its RTCPeerConnection for this viewer
      if (session.streamerSocketId) {
        toSocket(session.streamerSocketId, 'viewer-left', {
          roomId        : session.roomId,
          viewerSocketId: socket.id,
        });
      }
    }
  });
}

module.exports = { attachSignalingHandlers };
