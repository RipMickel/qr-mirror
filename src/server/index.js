/**
 * index.js – Main server entry point
 *
 * Bootstrap order:
 *  1. Load environment variables (.env)
 *  2. Create Express app
 *  3. Mount middleware (CORS, JSON, static files)
 *  4. Mount API routes
 *  5. Create HTTP server
 *  6. Attach Socket.IO with signaling handlers
 *  7. Serve SPA catch-all for viewer/mobile pages
 *  8. Start listening
 */

'use strict';

// ── 1. Load env vars first (before any other require reads process.env) ──────
require('dotenv').config();

const path    = require('path');
const http    = require('http');
const express = require('express');
const { Server: SocketServer } = require('socket.io');

const logger                  = require('../utils/logger');
const { attachSignalingHandlers } = require('../socket/signalingHandler');
const apiRouter               = require('./routes');

// ── Config ───────────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3000', 10);
const HOST       = process.env.HOST || '0.0.0.0';
const CORS_ORIGINS = process.env.CORS_ORIGINS || '*';
const PUBLIC_DIR   = path.resolve(__dirname, '../../public');

// ── 2. Express app ───────────────────────────────────────────────────────────
const app = express();

// ── 3. Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Simple request logger
app.use((req, _res, next) => {
  logger.http(`${req.method} ${req.url}`, { ip: req.ip });
  next();
});

// Serve static assets (CSS, JS, images)
app.use(express.static(PUBLIC_DIR));

// ── 4. API routes ─────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── SPA page routes ───────────────────────────────────────────────────────────
// Viewer (PC)
app.get(['/', '/viewer'], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pages', 'viewer.html'));
});

// Mobile (Phone)
app.get('/mobile', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pages', 'mobile.html'));
});

// ── 404 handler ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ──────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error('Unhandled Express error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── 5. HTTP server ────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);

// ── 6. Socket.IO ──────────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: {
    origin : CORS_ORIGINS === '*' ? '*' : CORS_ORIGINS.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST'],
  },
  // Prefer WebSocket transport; fall back to polling for constrained networks
  transports       : ['websocket', 'polling'],
  pingTimeout      : 20000,
  pingInterval     : 25000,
  upgradeTimeout   : 10000,
  maxHttpBufferSize: 1e6, // 1 MB – we only pass signaling messages, not media
});

// Attach signaling handlers to every new connection
io.on('connection', (socket) => {
  logger.info('New socket connection', { socketId: socket.id, transport: socket.conn.transport.name });
  attachSignalingHandlers(socket, io);
});

// ── 8. Start server ───────────────────────────────────────────────────────────
httpServer.listen(PORT, HOST, () => {
  logger.info(`QR Mirror server running`, {
    address   : `http://${HOST}:${PORT}`,
    publicUrl : process.env.PUBLIC_URL || `http://localhost:${PORT}`,
    env       : process.env.NODE_ENV || 'development',
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.warn(`${signal} received – shutting down gracefully`);
  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Force-kill after 10 s
  setTimeout(() => {
    logger.error('Forceful shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason });
});

module.exports = { app, httpServer, io }; // export for testing
