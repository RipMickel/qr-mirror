/**
 * login-endpoint.js – Simple authentication endpoint
 * 
 * Add to your Express server:
 *   const express = require('express');
 *   const { generateToken } = require('./auth-middleware');
 *   const app = express();
 *   
 *   app.post('/api/login', express.json(), loginEndpoint);
 */

const express = require('express');
const { generateToken } = require('./auth-middleware');

function loginEndpoint(req, res) {
  const { username, password } = req.body;

  // EXAMPLE: Simple hardcoded validation
  // In production, check against a database with hashed passwords
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }

  // Validate credentials (mock)
  if (password.length < 4) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Generate token
  const token = generateToken(
    `user_${Date.now()}`,
    username,
    null,
    '24h'
  );

  res.json({
    success: true,
    token,
    username,
    expiresIn: '24h',
  });
}

module.exports = { loginEndpoint };