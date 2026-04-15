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
 * FIXES:
 *  - viewer-ready signals arriving before capture starts are queued and replayed
 *    after startCapture() resolves (prevents silent offer-drop deadlock).
 *  - Named handler refs stored so destroy() can remove them cleanly, preventing
 *    stale listeners accumulating across re-instantiations.
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
     * @type {string[]}
     */
    this._pendingViewers = [];

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

    this._attachSignalingListeners();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  async startCapture() {
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

    if (this.previewEl) {
      this.previewEl.srcObject = this.localStream;
      await this.previewEl.play().catch(() => {});
    }

    this.localStream.getTracks().forEach((track) => {
      track.onended = () => {
        this.log('Screen share ended by user', 'warn');
        this.destroy();
        this.onStateChange('stopped');
      };
    });

    this.log('Capture started ✓', 'ok');
    this.onStateChange('capturing');

    // Replay any viewer-ready signals that arrived before capture started
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

  destroy() {
    this._detachSignalingListeners();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this._pendingViewers = [];

    if (this.previewEl) this.previewEl.srcObject = null;

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
    this._detachSignalingListeners();

    this._onViewerReady = ({ viewerSocketId }) => {
      this.log(`Viewer ready: ${viewerSocketId}`, 'info');
      if (!this.localStream) {
        this.log('No local stream yet – queuing viewer until capture starts', 'warn');
        if (!this._pendingViewers.includes(viewerSocketId)) {
          this._pendingViewers.push(viewerSocketId);
        }
        return;
      }
      this._createOfferForViewer(viewerSocketId);
    };

    this._onAnswer = ({ sdp, viewerSocketId }) => {
      this.log(`Answer received from viewer ${viewerSocketId}`, 'info');
      this._handleAnswer(sdp, viewerSocketId);
    };

    this._onIce = ({ candidate, fromSocketId }) => {
      this._addIceCandidate(candidate, fromSocketId);
    };

    this._onViewerLeft = ({ viewerSocketId }) => {
      this.log(`Viewer left: ${viewerSocketId}`, 'warn');
      this._pendingViewers = this._pendingViewers.filter((id) => id !== viewerSocketId);
      this._closeViewerConnection(viewerSocketId);
    };

    onSignal('viewer-ready',   this._onViewerReady);
    onSignal('webrtc-answer',  this._onAnswer);
    onSignal('ice-candidate',  this._onIce);
    onSignal('viewer-left',    this._onViewerLeft);
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
  }

  async _createOfferForViewer(viewerSocketId) {
    if (this.peerConnections.has(viewerSocketId)) {
      this.peerConnections.get(viewerSocketId).close();
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(viewerSocketId, pc);
    this.onViewerCount(this.peerConnections.size);

    this.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream);
    });

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

    try {
      const offer = await pc.createOffer({ offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);

      sendSignal('webrtc-offer', {
        roomId               : this.roomId,
        sdp                  : pc.localDescription,
        targetViewerSocketId : viewerSocketId,
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
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      this.log(`Rear camera failed (${err.message}), trying any camera…`, 'warn');
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }
}