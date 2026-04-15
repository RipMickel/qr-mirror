/**
 * logger.js – Centralised Winston logger
 *
 * Provides structured logging to console (coloured) and optionally to
 * rotating log files.  Import this module everywhere instead of using
 * console.log so that log level, format, and output are controlled from
 * the environment.
 */

'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs   = require('fs');

// ── Config pulled from environment ──────────────────────────────────────────
const LOG_LEVEL   = process.env.LOG_LEVEL  || 'info';
const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
const LOG_DIR     = process.env.LOG_DIR    || './logs';

// Ensure the log directory exists when file logging is enabled.
if (LOG_TO_FILE) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ── Custom format: timestamp + level + message + optional metadata ───────────
const baseFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? ' ' + JSON.stringify(meta)
      : '';
    return `[${timestamp}] ${level.toUpperCase().padEnd(7)} ${message}${metaStr}`;
  })
);

// ── Transport list ───────────────────────────────────────────────────────────
const logTransports = [
  new transports.Console({
    format: format.combine(format.colorize({ all: true }), baseFormat),
  }),
];

if (LOG_TO_FILE) {
  // Combined log – all levels
  logTransports.push(
    new transports.File({
      filename : path.join(LOG_DIR, 'combined.log'),
      format   : baseFormat,
      maxsize  : 10 * 1024 * 1024, // 10 MB
      maxFiles : 5,
      tailable : true,
    })
  );

  // Error-only log
  logTransports.push(
    new transports.File({
      filename : path.join(LOG_DIR, 'error.log'),
      level    : 'error',
      format   : baseFormat,
      maxsize  : 5 * 1024 * 1024,
      maxFiles : 3,
      tailable : true,
    })
  );
}

// ── Logger instance ──────────────────────────────────────────────────────────
const logger = createLogger({
  level      : LOG_LEVEL,
  transports : logTransports,
  exitOnError: false,
});

module.exports = logger;
