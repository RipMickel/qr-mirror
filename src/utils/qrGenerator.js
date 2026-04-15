/**
 * qrGenerator.js – QR code generation helper
 *
 * Wraps the `qrcode` npm package and exposes two convenience functions:
 *   - generateDataUrl  → base-64 PNG embedded in a data: URI (for <img src>)
 *   - generateSvgString → inline SVG markup
 *
 * Both accept a plain URL string and optional override options.
 */

'use strict';

const QRCode = require('qrcode');
const logger = require('./logger');

// ── Default QR options ───────────────────────────────────────────────────────
const DEFAULTS = {
  errorCorrectionLevel : 'H',   // High – survives up to 30 % damage; good for logos
  margin               : 2,
  width                : 300,
  color: {
    dark  : '#0a0a0a',
    light : '#ffffff',
  },
};

/**
 * Generate a QR code as a base-64 PNG data URL.
 *
 * @param {string} url        - The URL to encode.
 * @param {object} [options]  - Override any QRCode options.
 * @returns {Promise<string>} - Data URL string: "data:image/png;base64,..."
 */
async function generateDataUrl(url, options = {}) {
  try {
    const opts = { ...DEFAULTS, ...options };
    const dataUrl = await QRCode.toDataURL(url, opts);
    logger.debug('QR data URL generated', { url });
    return dataUrl;
  } catch (err) {
    logger.error('QR generation failed', { url, error: err.message });
    throw err;
  }
}

/**
 * Generate a QR code as an inline SVG string.
 *
 * @param {string} url        - The URL to encode.
 * @param {object} [options]  - Override any QRCode options.
 * @returns {Promise<string>} - SVG markup string.
 */
async function generateSvgString(url, options = {}) {
  try {
    const opts = { ...DEFAULTS, type: 'svg', ...options };
    const svg = await QRCode.toString(url, opts);
    logger.debug('QR SVG generated', { url });
    return svg;
  } catch (err) {
    logger.error('QR SVG generation failed', { url, error: err.message });
    throw err;
  }
}

module.exports = { generateDataUrl, generateSvgString };
