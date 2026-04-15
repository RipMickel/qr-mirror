/**
 * auth-middleware.js – JWT-based authentication for WebSocket
 * 
 * Usage in your Express/Node server:
 *   const authMiddleware = require('./auth-middleware');
 *   io.use(authMiddleware);
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-prod';

/**
 * Verify JWT token from socket auth
 */
function authMiddleware(socket, next) {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    return next(new Error('Missing authentication token'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    socket.room = decoded.room; // Optional: tie token to specific room
    console.log(`[AUTH] User ${socket.username} authenticated`, socket.id);
    next();
  } catch (err) {
    console.error(`[AUTH] Invalid token:`, err.message);
    next(new Error('Invalid or expired token'));
  }
}

/**
 * Generate a JWT token for a user + optional room
 */
function generateToken(userId, username, room = null, expiresIn = '1h') {
  return jwt.sign(
    { userId, username, room },
    JWT_SECRET,
    { expiresIn }
  );
}

module.exports = { authMiddleware, generateToken, JWT_SECRET };