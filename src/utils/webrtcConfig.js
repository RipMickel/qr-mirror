/**
 * webrtcConfig.js – Build the ICE server configuration from environment vars.
 *
 * This object is sent to the client so that RTCPeerConnection uses the same
 * STUN/TURN servers as configured on the server side.
 *
 * Environment variables:
 *   STUN_SERVERS   – comma-separated stun: URLs
 *   TURN_URL       – turn: or turns: URL (optional)
 *   TURN_USERNAME  – TURN credential username
 *   TURN_CREDENTIAL – TURN credential password
 */

'use strict';

function buildIceConfig() {
  const iceServers = [];

  // ── STUN ──────────────────────────────────────────────────────────────────
  const stunEnv = process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302';
  const stunUrls = stunEnv.split(',').map((s) => s.trim()).filter(Boolean);
  if (stunUrls.length) {
    iceServers.push({ urls: stunUrls });
  }

  // ── TURN (optional) ───────────────────────────────────────────────────────
  if (process.env.TURN_URL) {
    iceServers.push({
      urls       : process.env.TURN_URL,
      username   : process.env.TURN_USERNAME   || '',
      credential : process.env.TURN_CREDENTIAL || '',
    });
  }

  return { iceServers };
}

module.exports = { buildIceConfig };
