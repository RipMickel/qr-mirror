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

    // FAST: Use SVG for display (no pixel rendering)
    const qrDataUrl = await generateSvgString(streamerUrl);

    res.json({
      roomId: session.roomId,
      qrDataUrl,
      qrRefreshInterval: QR_REFRESH_INTERVAL,
      serverUrl: baseUrl,
    });

    logger.info('Session created', { roomId: session.roomId });
  } catch (err) {
    logger.error('Session creation error', { error: err.message });
    res.status(500).json({ error: 'Failed to create session' });
  }
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

    // FAST: Use SVG for display
    const qrDataUrl = await generateSvgString(streamerUrl);

    res.json({ success: true, qrDataUrl });
    logger.info('QR refreshed', { roomId: session.roomId });
  } catch (err) {
    logger.error('QR refresh failed', { error: err.message });
    res.status(500).json({ error: 'Failed to refresh QR' });
  }
});