/**
 * mobile-webrtc.js – WebRTC logic for the Phone Streamer
 *
 * Responsibilities:
 *  1. Capture the phone screen via getDisplayMedia (or getUserMedia as fallback)
 *  2. Maintain one RTCPeerConnection per viewer (many-viewers support)
 *  3. When a viewer signals ready → create offer + send it
 *  4. Handle incoming answers and ICE candidates per viewer
 *  5. Stop all streams on destroy
 *
 * FIX: viewer-ready signals that arrive BEFORE capture starts are now queued
 * and replayed once localStream is available, preventing the silent deadlock
 * where the offer was dropped and the viewer never received a stream.
 */

import { onSignal, sendSignal } from './socket-client.js';

export class StreamerWebRTC {
  /**
   * @param {object} opts
   * @param {string}   opts.roomId
   * @param {object}   opts.iceConfig
   * @param {HTMLVideoElement} [opts.previewEl]    - Optional local preview <video>
   * @param {Function} opts.onStateChange          - (state:string) => void
   * @param {Function} opts.onLog                  - (msg, level) => void
   * @param {Function} opts.onViewerCountChange     - (count:number) => void
   */
  constructor({ roomId, iceConfig, previewEl, onStateChange, onLog, onViewerCountChange }) {
    this.roomId         = roomId;
    this.iceConfig      = iceConfig;
    this.previewEl      = previewEl || null;
    this.onStateChange  = onStateChange       || (() => {});
    this.log            = onLog               || ((m) => console.log(m));
    this.onViewerCount  = onViewerCountChange || (() => {});

    /** @type {MediaStream|null} */
    this.localStream = null;

    /**
     * Viewers that sent viewer-ready BEFORE capture started.
     * Replayed once localStream is available.
     * @type {string[]}
     */
    this._pendingViewers = [];

    /**
     * Map of viewerSocketId → RTCPeerConnection
     * @type {Map<string, RTCPeerConnection>}
     */
    this.peerConnections = new Map();

    this._attachSignalingListeners();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Start screen capture.
   * Returns the captured MediaStream so the caller can show a preview.
   * @returns {Promise<MediaStream>}
   */
  async startCapture() {
    // Try screen sharing; fall back to camera on devices that don't support it
    // (iOS Safari does NOT support getDisplayMedia as of early 2025, so camera
    // is the realistic option on iPhone).
    // Mobile browsers (iOS Safari, Chrome Android) don't support getDisplayMedia.
    // Detect mobile and go straight to camera to avoid the "capture failed" error.
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (!isMobile && navigator.mediaDevices.getDisplayMedia) {
      this.log('Requesting screen share permission…', 'info');
      try {
        this.localStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 60 } },
          audio: false,
        });
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          this.log('Screen share permission denied', 'error');
          throw new Error('PERMISSION_DENIED');
        }
        this.log(`getDisplayMedia failed (${err.message}) – falling back to camera`, 'warn');
        this.localStream = await this._getCameraStream();
      }
    } else {
      this.log(isMobile ? 'Mobile detected – using camera' : 'getDisplayMedia unavailable – using camera', 'warn');
      this.localStream = await this._getCameraStream();
    }

    // Attach to local preview
    if (this.previewEl) {
      this.previewEl.srcObject = this.localStream;
      await this.previewEl.play().catch(() => {});
    }

    // Watch for the user stopping the share from the browser toolbar
    this.localStream.getTracks().forEach((track) => {
      track.onended = () => {
        this.log('Screen share ended by user', 'warn');
        this.destroy();
        this.onStateChange('stopped');
      };
    });

    this.log('Capture started ✓', 'ok');
    this.onStateChange('capturing');

    // FIX: replay any viewer-ready signals that arrived before capture started
    if (this._pendingViewers.length > 0) {
      this.log(`Replaying ${this._pendingViewers.length} queued viewer-ready signal(s)…`, 'info');
      const queued = [...this._pendingViewers];
      this._pendingViewers = [];
      for (const viewerSocketId of queued) {
        await this._createOfferForViewer(viewerSocketId);
      }
    }

    return this.localStream;
  }

  /**
   * Stop capture and close all peer connections.
   */
  destroy() {
    // Stop media tracks
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this._pendingViewers = [];

    if (this.previewEl) this.previewEl.srcObject = null;

    // Close all peer connections
    this.peerConnections.forEach((pc, viewerId) => {
      pc.close();
      this.log(`Peer connection closed for viewer ${viewerId}`, 'debug');
    });
    this.peerConnections.clear();
    this.onViewerCount(0);

    this.log('Streamer destroyed', 'warn');
    this.onStateChange('idle');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _attachSignalingListeners() {
    // A viewer is ready to receive an offer
    onSignal('viewer-ready', ({ viewerSocketId }) => {
      this.log(`Viewer ready: ${viewerSocketId}`, 'info');

      if (!this.localStream) {
        // FIX: queue instead of silently dropping
        this.log('No local stream yet – queuing viewer until capture starts', 'warn');
        if (!this._pendingViewers.includes(viewerSocketId)) {
          this._pendingViewers.push(viewerSocketId);
        }
        return;
      }

      this._createOfferForViewer(viewerSocketId);
    });

    // Viewer sent us an answer
    onSignal('webrtc-answer', ({ sdp, viewerSocketId }) => {
      this.log(`Answer received from viewer ${viewerSocketId}`, 'info');
      this._handleAnswer(sdp, viewerSocketId);
    });

    // ICE candidate from a viewer
    onSignal('ice-candidate', ({ candidate, fromSocketId }) => {
      this._addIceCandidate(candidate, fromSocketId);
    });

    // A viewer disconnected
    onSignal('viewer-left', ({ viewerSocketId }) => {
      this.log(`Viewer left: ${viewerSocketId}`, 'warn');
      // Also remove from pending queue if they disconnect before capture
      this._pendingViewers = this._pendingViewers.filter((id) => id !== viewerSocketId);
      this._closeViewerConnection(viewerSocketId);
    });
  }

  /** Create a peer connection for a specific viewer and send an offer. */
  async _createOfferForViewer(viewerSocketId) {
    if (this.peerConnections.has(viewerSocketId)) {
      // Close stale connection if viewer re-connects
      this.peerConnections.get(viewerSocketId).close();
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(viewerSocketId, pc);
    this.onViewerCount(this.peerConnections.size);

    // ── Add local tracks ────────────────────────────────────────────────────
    this.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream);
    });

    // ── ICE events ──────────────────────────────────────────────────────────
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        sendSignal('ice-candidate', {
          roomId        : this.roomId,
          candidate,
          targetSocketId: viewerSocketId,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      this.log(`ICE [${viewerSocketId.slice(0,6)}] → ${s}`, 'debug');
      if (s === 'disconnected' || s === 'failed') {
        this._closeViewerConnection(viewerSocketId);
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.log(`Connection [${viewerSocketId.slice(0,6)}] → ${s}`, 'debug');
      if (s === 'connected') {
        this.onStateChange('streaming');
      }
    };

    // ── Create and send offer ────────────────────────────────────────────────
    try {
      const offer = await pc.createOffer({ offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);

      sendSignal('webrtc-offer', {
        roomId          : this.roomId,
        sdp             : pc.localDescription,
        targetViewerSocketId: viewerSocketId,
      });

      this.log(`Offer sent to viewer ${viewerSocketId}`, 'info');
    } catch (err) {
      this.log(`Failed to create offer: ${err.message}`, 'error');
      this._closeViewerConnection(viewerSocketId);
    }
  }

  async _handleAnswer(sdp, viewerSocketId) {
    const pc = this.peerConnections.get(viewerSocketId);
    if (!pc) {
      this.log(`No peer connection found for viewer ${viewerSocketId}`, 'warn');
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      this.log(`Remote description set for viewer ${viewerSocketId}`, 'debug');
    } catch (err) {
      this.log(`setRemoteDescription failed: ${err.message}`, 'error');
    }
  }

  async _addIceCandidate(candidate, fromSocketId) {
    const pc = this.peerConnections.get(fromSocketId);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      this.log(`ICE candidate error: ${err.message}`, 'warn');
    }
  }

  _closeViewerConnection(viewerSocketId) {
    const pc = this.peerConnections.get(viewerSocketId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(viewerSocketId);
      this.onViewerCount(this.peerConnections.size);
      this.log(`Closed connection for viewer ${viewerSocketId}`, 'debug');
    }
  }

  async _getCameraStream() {
    this.log('Requesting camera access…', 'info');
    try {
      // Try rear camera first
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      this.log(`Rear camera failed (${err.message}), trying any camera…`, 'warn');
      // Fall back to any available camera with minimal constraints
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }
}