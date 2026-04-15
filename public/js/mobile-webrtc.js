/**
 * mobile-webrtc.js – WebRTC logic for the Phone Streamer
 *
 * FIXES APPLIED:
 *  1. Corrected viewer-ready queueing logic with better state tracking
 *  2. Robust signaling listener attachment/detachment
 *  3. Added comprehensive logging with [TAGS] for debugging
 *  4. Handle answer with correct viewerSocketId matching
 *  5. ICE candidate routing with viewer socket ID
 *  6. Proper track addition verification
 */

import { onSignal, offSignal, sendSignal } from './socket-client.js';

export class StreamerWebRTC {
  constructor({ roomId, iceConfig, previewEl, onStateChange, onLog, onViewerCountChange }) {
    this.roomId        = roomId;
    this.iceConfig     = iceConfig;
    this.previewEl     = previewEl || null;
    this.onStateChange = onStateChange       || (() => {});
    this.log           = onLog               || ((m) => console.log(m));
    this.onViewerCount = onViewerCountChange || (() => {});

    /** @type {MediaStream|null} */
    this.localStream = null;

    /**
     * viewer-ready signals that arrived before capture started.
     * Replayed once localStream is available.
     * @type {Set<string>} - Use Set to prevent duplicates
     */
    this._pendingViewers = new Set();

    /**
     * Map of viewerSocketId → RTCPeerConnection
     * @type {Map<string, RTCPeerConnection>}
     */
    this.peerConnections = new Map();

    // Named handler refs for clean removal
    this._onViewerReady  = null;
    this._onAnswer       = null;
    this._onIce          = null;
    this._onViewerLeft   = null;

    // Track attachment state
    this._listenersAttached = false;

    this._attachSignalingListeners();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  async startCapture() {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (!isMobile && navigator.mediaDevices.getDisplayMedia) {
      this.log('[CAPTURE] Requesting screen share permission…', 'info');
      try {
        this.localStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 60 } },
          audio: false,
        });
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          this.log('[CAPTURE] Screen share permission denied', 'error');
          throw new Error('PERMISSION_DENIED');
        }
        this.log(`[CAPTURE] getDisplayMedia failed (${err.message}) – falling back to camera`, 'warn');
        this.localStream = await this._getCameraStream();
      }
    } else {
      this.log(isMobile ? '[CAPTURE] Mobile detected – using camera' : '[CAPTURE] getDisplayMedia unavailable – using camera', 'warn');
      this.localStream = await this._getCameraStream();
    }

    // Attach preview
    if (this.previewEl) {
      this.previewEl.srcObject = this.localStream;
      await this.previewEl.play().catch(() => {});
      this.log('[PREVIEW] Preview attached ✓', 'debug');
    }

    // Set up track-ended handler
    this.localStream.getTracks().forEach((track) => {
      track.onended = () => {
        this.log(`[CAPTURE] ${track.kind} track ended by user`, 'warn');
        this.destroy();
        this.onStateChange('stopped');
      };
    });

    this.log('[CAPTURE] Capture started ✓', 'ok');
    this.onStateChange('capturing');

    // Replay any viewer-ready signals that arrived before capture started
    if (this._pendingViewers.size > 0) {
      this.log(`[CAPTURE] Replaying ${this._pendingViewers.size} queued viewer-ready signal(s)…`, 'info');
      const queued = Array.from(this._pendingViewers);
      this._pendingViewers.clear();
      for (const viewerSocketId of queued) {
        this.log(`[CAPTURE] Creating offer for queued viewer: ${viewerSocketId.substring(0, 8)}`, 'debug');
        await this._createOfferForViewer(viewerSocketId);
      }
    }

    return this.localStream;
  }

  destroy() {
    this.log('[DESTROY] Destroying streamer WebRTC…', 'warn');
    this._detachSignalingListeners();
    
    this.localStream?.getTracks().forEach((t) => {
      t.stop();
      this.log(`[DESTROY] Stopped ${t.kind} track`, 'debug');
    });
    this.localStream = null;
    this._pendingViewers.clear();

    if (this.previewEl) this.previewEl.srcObject = null;

    this.peerConnections.forEach((pc, viewerId) => {
      pc.close();
      this.log(`[DESTROY] Closed peer connection for viewer: ${viewerId.substring(0, 8)}`, 'debug');
    });
    this.peerConnections.clear();
    this.onViewerCount(0);

    this.log('[DESTROY] Streamer destroyed ✓', 'warn');
    this.onStateChange('idle');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _attachSignalingListeners() {
    // Prevent double-attachment
    if (this._listenersAttached) {
      this.log('[SIGNALING] Listeners already attached', 'debug');
      return;
    }

    this._detachSignalingListeners();

    this._onViewerReady = ({ viewerSocketId }) => {
      this.log(`[VIEWER-READY] Viewer ready: ${viewerSocketId.substring(0, 8)}`, 'info');
      if (!this.localStream) {
        this.log('[VIEWER-READY] No local stream yet – queuing viewer', 'warn');
        this._pendingViewers.add(viewerSocketId);
        return;
      }
      this._createOfferForViewer(viewerSocketId);
    };

    this._onAnswer = ({ sdp, viewerSocketId }) => {
      this.log(`[ANSWER] Answer received from viewer: ${viewerSocketId.substring(0, 8)}`, 'info');
      this._handleAnswer(sdp, viewerSocketId);
    };

    this._onIce = ({ candidate, fromSocketId }) => {
      this.log(`[ICE-IN] Candidate from: ${fromSocketId.substring(0, 8)}`, 'debug');
      this._addIceCandidate(candidate, fromSocketId);
    };

    this._onViewerLeft = ({ viewerSocketId }) => {
      this.log(`[VIEWER-LEFT] Viewer disconnected: ${viewerSocketId.substring(0, 8)}`, 'warn');
      this._pendingViewers.delete(viewerSocketId);
      this._closeViewerConnection(viewerSocketId);
    };

    onSignal('viewer-ready',   this._onViewerReady);
    onSignal('webrtc-answer',  this._onAnswer);
    onSignal('ice-candidate',  this._onIce);
    onSignal('viewer-left',    this._onViewerLeft);

    this._listenersAttached = true;
    this.log('[SIGNALING] Listeners attached ✓', 'debug');
  }

  _detachSignalingListeners() {
    if (this._onViewerReady) offSignal('viewer-ready',  this._onViewerReady);
    if (this._onAnswer)      offSignal('webrtc-answer', this._onAnswer);
    if (this._onIce)         offSignal('ice-candidate', this._onIce);
    if (this._onViewerLeft)  offSignal('viewer-left',   this._onViewerLeft);
    
    this._onViewerReady = null;
    this._onAnswer      = null;
    this._onIce         = null;
    this._onViewerLeft  = null;
    
    this._listenersAttached = false;
    this.log('[SIGNALING] Listeners detached ✓', 'debug');
  }

  async _createOfferForViewer(viewerSocketId) {
    this.log(`[OFFER] Creating offer for viewer: ${viewerSocketId.substring(0, 8)}`, 'info');
    
    if (this.peerConnections.has(viewerSocketId)) {
      const oldPc = this.peerConnections.get(viewerSocketId);
      oldPc.close();
      this.log(`[OFFER] Closed stale peer connection for viewer: ${viewerSocketId.substring(0, 8)}`, 'debug');
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(viewerSocketId, pc);
    this.onViewerCount(this.peerConnections.size);
    this.log(`[OFFER] Peer connection created. Total viewers: ${this.peerConnections.size}`, 'info');

    // Add local tracks
    this.localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, this.localStream);
      this.log(`[OFFER] Added ${track.kind} track to viewer: ${viewerSocketId.substring(0, 8)}`, 'debug');
    });

    // ICE candidate handler
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.log(`[ICE-OUT] Sending candidate to viewer: ${viewerSocketId.substring(0, 8)}`, 'debug');
        sendSignal('ice-candidate', {
          roomId        : this.roomId,
          candidate,
          targetSocketId: viewerSocketId,
        });
      } else {
        this.log(`[ICE-OUT] ICE gathering complete for viewer: ${viewerSocketId.substring(0, 8)}`, 'debug');
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      this.log(`[ICE-STATE] Viewer ${viewerSocketId.substring(0, 8)}: ${s}`, 'debug');
      if (s === 'disconnected' || s === 'failed') {
        this.log(`[ICE-STATE] Closing connection for viewer: ${viewerSocketId.substring(0, 8)}`, 'warn');
        this._closeViewerConnection(viewerSocketId);
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.log(`[CONN-STATE] Viewer ${viewerSocketId.substring(0, 8)}: ${s}`, 'debug');
      if (s === 'connected') {
        this.log(`[CONN-STATE] Viewer ${viewerSocketId.substring(0, 8)} connected ✓`, 'ok');
        this.onStateChange('streaming');
      }
    };

    try {
      this.log(`[OFFER] Creating offer…`, 'debug');
      const offer = await pc.createOffer({ offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      this.log(`[OFFER] Local description set ✓`, 'debug');

      sendSignal('webrtc-offer', {
        roomId               : this.roomId,
        sdp                  : pc.localDescription,
        targetViewerSocketId : viewerSocketId,
      });

      this.log(`[OFFER] Offer sent to viewer: ${viewerSocketId.substring(0, 8)} ✓`, 'info');
    } catch (err) {
      this.log(`[OFFER] Failed to create offer: ${err.message}`, 'error');
      this._closeViewerConnection(viewerSocketId);
    }
  }

  async _handleAnswer(sdp, viewerSocketId) {
    const pc = this.peerConnections.get(viewerSocketId);
    if (!pc) {
      this.log(`[ANSWER] No peer connection found for viewer: ${viewerSocketId.substring(0, 8)}`, 'warn');
      return;
    }
    try {
      this.log(`[ANSWER] Setting remote description for viewer: ${viewerSocketId.substring(0, 8)}`, 'debug');
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      this.log(`[ANSWER] Remote description set ✓`, 'ok');
    } catch (err) {
      this.log(`[ANSWER] setRemoteDescription failed: ${err.message}`, 'error');
    }
  }

  async _addIceCandidate(candidate, fromSocketId) {
    const pc = this.peerConnections.get(fromSocketId);
    if (!pc) {
      this.log(`[ICE-IN] No peer connection for viewer: ${fromSocketId.substring(0, 8)}`, 'warn');
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      this.log(`[ICE-IN] Candidate added ✓`, 'debug');
    } catch (err) {
      this.log(`[ICE-IN] Error: ${err.message}`, 'warn');
    }
  }

  _closeViewerConnection(viewerSocketId) {
    const pc = this.peerConnections.get(viewerSocketId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(viewerSocketId);
      this.onViewerCount(this.peerConnections.size);
      this.log(`[CLOSE] Closed connection for viewer: ${viewerSocketId.substring(0, 8)}. Remaining: ${this.peerConnections.size}`, 'info');
    }
  }

  async _getCameraStream() {
    this.log('[CAMERA] Requesting camera access…', 'info');
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      this.log(`[CAMERA] Rear camera failed (${err.message}), trying any camera…`, 'warn');
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }
}