/**
 * qrGenerator.js – Optimized QR code generation
 *
 * OPTIMIZATIONS:
 *  1. Use lower error correction for faster generation
 *  2. Smaller width (displays fine on mobile)
 *  3. Cache recently generated QR codes (same URL = instant return)
 *  4. Use SVG for viewer (no pixel rendering), PNG for mobile (embedded in QR)
 *  5. Measure performance with timestamps
 */

'use strict';

const QRCode = require('qrcode');
const logger = require('./logger');

// ── QR Cache (prevent regenerating same room's QR) ──────────────────────────
const qrCache = new Map();
const CACHE_TTL = 60000; // 1 minute (QR codes refresh anyway)

// ── Fast QR Options ──────────────────────────────────────────────────────────
const FAST_DEFAULTS = {
  errorCorrectionLevel: 'L',    // LOW = fastest, still scannable
  margin              : 1,      // Minimal padding
  width               : 200,    // 200px = good for mobile + fast
};

const PNG_DEFAULTS = {
  ...FAST_DEFAULTS,
  type: 'image/png',
};

const SVG_DEFAULTS = {
  ...FAST_DEFAULTS,
  type: 'svg',
};

/**
 * Generate a QR code as a data URL (with caching).
 * @param {string} url - The URL to encode.
 * @param {object} [options] - Override any QRCode options.
 * @returns {Promise<string>} - Data URL string: "data:image/png;base64,..."
 */
async function generateDataUrl(url, options = {}) {
  const startTime = Date.now();

  // Check cache first
  const cacheKey = `png_${url}`;
  if (qrCache.has(cacheKey)) {
    const { dataUrl, generatedAt } = qrCache.get(cacheKey);
    if (Date.now() - generatedAt < CACHE_TTL) {
      logger.debug('QR cache hit', { url: url.substring(0, 50), ms: 0 });
      return dataUrl;
    }
    qrCache.delete(cacheKey); // Expired
  }

  try {
    const opts = { ...PNG_DEFAULTS, ...options };
    const dataUrl = await QRCode.toDataURL(url, opts);

    // Cache for 1 minute
    qrCache.set(cacheKey, { dataUrl, generatedAt: Date.now() });

    const elapsed = Date.now() - startTime;
    logger.debug('QR generated (PNG)', { url: url.substring(0, 50), ms: elapsed });

    return dataUrl;
  } catch (err) {
    logger.error('QR generation failed', { url: url.substring(0, 50), error: err.message });
    throw err;
  }
}

/**
 * Generate a QR code as an SVG string (faster, no pixel rendering).
 * @param {string} url - The URL to encode.
 * @param {object} [options] - Override any QRCode options.
 * @returns {Promise<string>} - SVG markup string.
 */
async function generateSvgString(url, options = {}) {
  const startTime = Date.now();

  const cacheKey = `svg_${url}`;
  if (qrCache.has(cacheKey)) {
    const { svg, generatedAt } = qrCache.get(cacheKey);
    if (Date.now() - generatedAt < CACHE_TTL) {
      logger.debug('QR cache hit', { url: url.substring(0, 50), format: 'svg', ms: 0 });
      return svg;
    }
    qrCache.delete(cacheKey);
  }

  try {
    const opts = { ...SVG_DEFAULTS, ...options };
    const svg = await QRCode.toString(url, opts);

    qrCache.set(cacheKey, { svg, generatedAt: Date.now() });

    const elapsed = Date.now() - startTime;
    logger.debug('QR generated (SVG)', { url: url.substring(0, 50), ms: elapsed });

    return svg;
  } catch (err) {
    logger.error('QR SVG generation failed', { url: url.substring(0, 50), error: err.message });
    throw err;
  }
}

/**
 * Clear old QR codes from cache (run periodically).
 */
function clearExpiredCache() {
  const now = Date.now();
  let count = 0;

  for (const [key, { generatedAt }] of qrCache) {
    if (now - generatedAt > CACHE_TTL) {
      qrCache.delete(key);
      count++;
    }
  }

  if (count > 0) {
    logger.debug('QR cache cleanup', { expired: count, remaining: qrCache.size });
  }
}

// Run cleanup every 2 minutes
setInterval(clearExpiredCache, 120000);

module.exports = { generateDataUrl, generateSvgString };