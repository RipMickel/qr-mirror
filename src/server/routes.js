/**
 * routes.js – Express REST API routes
 *
 * GET  /api/session/create   → Create a new room, return roomId + QR data URL
 * GET  /api/session/:roomId  → Check if a session exists
 * GET  /api/sessions         → List all active sessions (admin/debug)
 * POST /api/session/:roomId/refresh-qr → Regenerate QR for a room
 */

'use strict';

const express        = require('express');
const sessionManager = require('../utils/sessionManager');
const { generateDataUrl } = require('../utils/qrGenerator');
const logger         = require('../utils/logger');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMobileUrl(roomId) {
  const base = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/mobile?room=${roomId}`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/session/create
 * Body: (none required)
 * Response: { roomId, mobileUrl, qrDataUrl, qrRefreshInterval }
 */
router.post('/session/create', async (req, res) => {
  try {
    const session   = sessionManager.createSession();
    const mobileUrl = buildMobileUrl(session.roomId);
    const qrDataUrl = await generateDataUrl(mobileUrl);

    logger.http('Session created via API', { roomId: session.roomId, ip: req.ip });

    res.json({
      success          : true,
      roomId           : session.roomId,
      mobileUrl,
      qrDataUrl,
      qrRefreshInterval: parseInt(process.env.QR_REFRESH_INTERVAL_MS || '0', 10),
    });
  } catch (err) {
    logger.error('Failed to create session', { error: err.message });
    res.status(500).json({ success: false, error: 'Could not create session' });
  }
});

/**
 * GET /api/session/:roomId
 * Response: { exists, roomId, hasStreamer, viewerCount }
 */
router.get('/session/:roomId', (req, res) => {
  const { roomId } = req.params;
  const session    = sessionManager.getSession(roomId);

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  res.json({
    success     : true,
    roomId      : session.roomId,
    hasStreamer  : session.streamerSocketId !== null,
    viewerCount : session.viewerSocketIds.size,
  });
});

/**
 * POST /api/session/:roomId/refresh-qr
 * Regenerate the QR code (e.g. after TTL rotation)
 */
router.post('/session/:roomId/refresh-qr', async (req, res) => {
  const { roomId } = req.params;
  const session    = sessionManager.getSession(roomId);

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  try {
    const mobileUrl = buildMobileUrl(roomId);
    const qrDataUrl = await generateDataUrl(mobileUrl);
    res.json({ success: true, qrDataUrl, mobileUrl });
  } catch (err) {
    logger.error('QR refresh failed', { roomId, error: err.message });
    res.status(500).json({ success: false, error: 'QR regeneration failed' });
  }
});

/**
 * GET /api/sessions  (debug – disable in production)
 */
router.get('/sessions', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }
  res.json({ sessions: sessionManager.listSessions() });
});

module.exports = router;
