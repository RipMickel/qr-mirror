/**
 * server.js – Simplified, no-auth streaming server
 * 
 * QR code contains: room ID + single-use token
 * Mobile scans → shows accept/decline toast
 * PC viewer waits for streamer confirmation
 */

'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const logger = require('./logger');
const sessionManager = require('./sessionManager');
const { buildIceConfig } = require('./webrtcConfig');
const { generateDataUrl } = require('./qrGenerator');
const { getLocalIp } = require('./get-server-info');

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, {
  cors: { origin: '*' },
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Environment ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const QR_REFRESH_INTERVAL = parseInt(process.env.QR_REFRESH_INTERVAL_MS || '30000', 10);

// Store QR tokens: roomId -> { token, createdAt }
const qrTokens = new Map();

// ── QR Token Validation Middleware ────────────────────────────────────────────
io.use((socket, next) => {
  const { roomId, token } = socket.handshake.auth;

  if (!roomId || !token) {
    return next(new Error('Missing roomId or token'));
  }

  const storedToken = qrTokens.get(roomId);
  if (!storedToken || storedToken.token !== token) {
    logger.warn('Invalid QR token attempt', { roomId, socketId: socket.id });
    return next(new Error('Invalid QR token'));
  }

  // Mark as used (still allow reconnects during this session)
  socket.userId = socket.id;
  socket.roomId = roomId;
  next();
});

// ── REST API: Create Session ──────────────────────────────────────────────────
app.post('/api/session/create', async (req, res) => {
  try {
    const session = sessionManager.createSession();
    const token = crypto.randomBytes(16).toString('hex');

    qrTokens.set(session.roomId, { token, createdAt: Date.now() });

    const localIp = getLocalIp();
    const protocol = req.secure ? 'https' : 'http';
    const baseUrl = `${protocol}://${localIp}:${PORT}`;
    const streamerUrl = `${baseUrl}/mobile.html?room=${session.roomId}&token=${token}`;

    const qrDataUrl = await generateDataUrl(streamerUrl);

    res.json({
      roomId: session.roomId,
      qrDataUrl,
      qrRefreshInterval: QR_REFRESH_INTERVAL,
      serverUrl: baseUrl,
    });

    logger.info('Session created', { roomId: session.roomId, streamerUrl });
  } catch (err) {
    logger.error('Session creation error', { error: err.message });
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ── REST API: Get Session ─────────────────────────────────────────────────────
app.get('/api/session/:roomId', (req, res) => {
  const session = sessionManager.getSession(req.params.roomId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({
    roomId: session.roomId,
    hasStreamer: session.streamerSocketId !== null,
    viewerCount: session.viewerSocketIds.size,
  });
});

// ── REST API: Refresh QR ──────────────────────────────────────────────────────
app.post('/api/session/:roomId/refresh-qr', async (req, res) => {
  const session = sessionManager.getSession(req.params.roomId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    const token = crypto.randomBytes(16).toString('hex');
    qrTokens.set(session.roomId, { token, createdAt: Date.now() });

    const localIp = getLocalIp();
    const protocol = req.secure ? 'https' : 'http';
    const baseUrl = `${protocol}://${localIp}:${PORT}`;
    const streamerUrl = `${baseUrl}/mobile.html?room=${session.roomId}&token=${token}`;

    const qrDataUrl = await generateDataUrl(streamerUrl);
    res.json({ success: true, qrDataUrl });
  } catch (err) {
    logger.error('QR refresh failed', { error: err.message });
    res.status(500).json({ error: 'Failed to refresh QR' });
  }
});

// ── REST API: Server Info ─────────────────────────────────────────────────────
app.get('/api/server-info', (req, res) => {
  const localIp = getLocalIp();
  const protocol = req.secure ? 'https' : 'http';
  const serverUrl = `${protocol}://${localIp}:${PORT}`;

  res.json({
    localIp,
    serverUrl,
    port: PORT,
  });
});

// ── Socket.IO: Connection ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const { roomId } = socket;
  logger.info('Socket connected', { socketId: socket.id.substring(0, 8), roomId });

  // ── Register as viewer ──────────────────────────────────────��─────────────
  socket.on('register-viewer', ({ roomId: rid }) => {
    const session = sessionManager.getSession(rid);
    if (!session) {
      socket.emit('error-event', { message: 'Session not found' });
      return;
    }

    sessionManager.addViewer(rid, socket.id);
    socket.join(`room_${rid}`);
    socket.role = 'viewer';

    const iceConfig = buildIceConfig();
    socket.emit('viewer-registered', { roomId: rid, iceConfig });
    logger.info('Viewer registered', { socketId: socket.id.substring(0, 8), roomId: rid });
  });

  // ── Register as streamer ──────────────────────────────────────────────────
  socket.on('register-streamer', ({ roomId: rid }) => {
    const session = sessionManager.getSession(rid);
    if (!session) {
      socket.emit('error-event', { message: 'Session not found' });
      return;
    }

    sessionManager.setStreamer(rid, socket.id);
    socket.join(`room_${rid}`);
    socket.role = 'streamer';

    const iceConfig = buildIceConfig();
    socket.emit('streamer-registered', { iceConfig });
    logger.info('Streamer registered', { socketId: socket.id.substring(0, 8), roomId: rid });
  });

  // ── NEW: Streamer accepts or declines ─────────────────────────────���───────
  socket.on('streamer-decision', ({ roomId: rid, accepted }) => {
    const session = sessionManager.getSession(rid);
    if (!session) return;

    if (accepted) {
      logger.info('Streamer accepted', { socketId: socket.id.substring(0, 8), roomId: rid });
      // Notify all viewers that streamer is ready
      io.to(`room_${rid}`).emit('streamer-joined', { roomId: rid });
    } else {
      logger.warn('Streamer declined', { socketId: socket.id.substring(0, 8), roomId: rid });
      // Close streamer connection
      sessionManager.removeSocket(socket.id);
      // Notify viewers
      io.to(`room_${rid}`).emit('streamer-declined', { reason: 'Streamer declined connection' });
      socket.disconnect();
    }
  });

  // ── Signal: viewer-ready ──────────────────────────────────────────────────
  socket.on('viewer-ready', ({ roomId: rid }) => {
    const session = sessionManager.getSession(rid);
    if (!session || !session.streamerSocketId) return;

    io.to(session.streamerSocketId).emit('viewer-ready', {
      viewerSocketId: socket.id,
    });
  });

  // ── Signal: WebRTC offer ──────────────────────────────────────────────────
  socket.on('webrtc-offer', ({ roomId: rid, sdp, targetViewerSocketId }) => {
    const session = sessionManager.getSession(rid);
    if (!session) return;

    io.to(targetViewerSocketId).emit('webrtc-offer', {
      sdp,
      streamerSocketId: socket.id,
    });
  });

  // ── Signal: WebRTC answer ─────────────────────────────────────────────────
  socket.on('webrtc-answer', ({ roomId: rid, sdp, viewerSocketId }) => {
    const session = sessionManager.getSession(rid);
    if (!session) return;

    io.to(session.streamerSocketId).emit('webrtc-answer', {
      sdp,
      viewerSocketId,
    });
  });

  // ── Signal: ICE candidates ────────────────────────────────────────────────
  socket.on('ice-candidate', ({ roomId: rid, candidate, targetSocketId }) => {
    io.to(targetSocketId).emit('ice-candidate', {
      candidate,
      fromSocketId: socket.id,
    });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    if (socket.roomId) {
      const result = sessionManager.removeSocket(socket.id);

      if (result && result.role === 'streamer') {
        io.to(`room_${socket.roomId}`).emit('streamer-left', {
          reason: reason || 'Streamer disconnected',
        });
      }

      const session = sessionManager.getSession(socket.roomId);
      if (session && session.viewerSocketIds.size === 0 && !session.streamerSocketId) {
        sessionManager.destroySession(socket.roomId);
        qrTokens.delete(socket.roomId);
        logger.info('Session destroyed (empty)', { roomId: socket.roomId });
      }
    }

    logger.info('Socket disconnected', { socketId: socket.id.substring(0, 8), reason });
  });
});

// ── Cleanup: Remove expired QR tokens (1 hour TTL) ────────────────────────────
setInterval(() => {
  const now = Date.now();
  const ttl = 3600000; // 1 hour

  for (const [roomId, { createdAt }] of qrTokens) {
    if (now - createdAt > ttl) {
      qrTokens.delete(roomId);
      logger.debug('QR token expired', { roomId });
    }
  }
}, 300000); // Check every 5 minutes

// ── Server start ──────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  logger.info(`✓ Server running on http://${localIp}:${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});