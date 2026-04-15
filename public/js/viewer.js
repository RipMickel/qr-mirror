onSignal('streamer-declined', ({ reason }) => {
  log(`Streamer declined connection: ${reason}`, 'warn');
  showToast('Streamer declined your request');
  setStatus('error');
  createSession(); // Auto-create new session for next streamer
});

onSignal('streamer-joined', ({ roomId: rid }) => {
  log(`Streamer joined room ${rid} – signalling ready`, 'ok');
  viewerCountEl && (viewerCountEl.textContent = '1');
  webrtc?.signalReady();
  setStatus('connecting');
});