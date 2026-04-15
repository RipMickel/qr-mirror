/**
 * viewer-webrtc.js – WebRTC logic for the PC Viewer
 *
 * Responsibilities:
 *  1. Create an RTCPeerConnection per streamer session
 *  2. Handle incoming offer → create + send answer
 *  3. Receive ICE candidates from the streamer
 *  4. Attach the remote MediaStream to the <video> element
 *  5. Emit 'viewer-ready' to trigger the streamer to begin offering
 *
 * FIXES:
 *  - _attachSignalingListeners now stores named handler refs and removes them
 *    on destroy(), preventing stale handlers from a previous instance from
 *    firing and causing "setRemoteDescription: Called in wrong state: stale".
 *  - webrtc-answer now sends `viewerSocketId` (not `streamerSocketId`) so the
 *    streamer can look up the correct RTCPeerConnection in its map.
 */

import { onSignal, offSignal, sendSignal } from './socket-client.js';

export class ViewerWebRTC {
  /**
   * @param {object} opts
   * @param {string}      opts.roomId
   * @param {string}      opts.socketId          - Our own socket ID
   * @param {object}      opts.iceConfig         - ICE server config from server
   * @param {HTMLVideoElement} opts.videoEl       - <video> to attach stream to
   * @param {Function}    opts.onStateChange      - (state:string) => void
   * @param {Function}    opts.onLog              - (msg:string, level:string) => void
   */
  constructor({ roomId, socketId, iceConfig, videoEl, onStateChange, onLog }) {
    this.roomId       = roomId;
    this.socketId     = socketId;
    this.iceConfig    = iceConfig;
    this.videoEl      = videoEl;
    this.onStateChange = onStateChange || (() => {});
    this.log          = onLog         || ((m) => console.log(m));

    /** @type {RTCPeerConnection|null} */
    this.pc = null;

    /** @type {string|null} ID of the streamer socket we're paired with */
    this.streamerSocketId = null;

    // Named handler refs so we can remove them on destroy
    this._onOffer       = null;
    this._onIce         = null;
    this._onStreamerLeft = null;

    this._attachSignalingListeners();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /** Call this once the viewer is registered to signal readiness. */
  signalReady() {
    this.log('Signaling readiness to streamer…', 'info');
    sendSignal('viewer-ready', { roomId: this.roomId });
  }

  /** Cleanly close the peer connection and remove signaling listeners. */
  destroy() {
    this._detachSignalingListeners();
    this.pc?.close();
    this.pc = null;
    this.log('Peer connection destroyed', 'warn');
    this.onStateChange('idle');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _attachSignalingListeners() {
    // Always detach first so re-instantiation never leaves stale listeners
    this._detachSignalingListeners();

    // FIX Bug 1: store named refs so we can remove them precisely
    this._onOffer = ({ sdp, streamerSocketId }) => {
      this.log(`Received WebRTC offer from ${streamerSocketId}`, 'info');
      this.streamerSocketId = streamerSocketId;
      this._handleOffer(sdp);
    };

    this._onIce = ({ candidate, fromSocketId }) => {
      // Only handle candidates from our paired streamer
      if (fromSocketId && fromSocketId !== this.streamerSocketId) return;
      this._addIceCandidate(candidate);
    };

    this._onStreamerLeft = ({ reason }) => {
      this.log(`Streamer disconnected (${reason})`, 'warn');
      this.destroy();
      this.onStateChange('streamer-left');
    };

    onSignal('webrtc-offer',  this._onOffer);
    onSignal('ice-candidate', this._onIce);
    onSignal('streamer-left', this._onStreamerLeft);
  }

  _detachSignalingListeners() {
    if (this._onOffer)        offSignal('webrtc-offer',  this._onOffer);
    if (this._onIce)          offSignal('ice-candidate', this._onIce);
    if (this._onStreamerLeft)  offSignal('streamer-left', this._onStreamerLeft);
    this._onOffer       = null;
    this._onIce         = null;
    this._onStreamerLeft = null;
  }

  /** Create (or re-create) the RTCPeerConnection. */
  _createPeerConnection() {
    if (this.pc) {
      this.pc.close();
      this.log('Previous peer connection closed', 'debug');
    }

    this.pc = new RTCPeerConnection(this.iceConfig);
    this.log('RTCPeerConnection created', 'debug');

    // ── ICE events ──────────────────────────────────────────────────────────
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        sendSignal('ice-candidate', {
          roomId        : this.roomId,
          candidate,
          targetSocketId: this.streamerSocketId,
        });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      this.log(`ICE state → ${s}`, s === 'connected' || s === 'completed' ? 'ok' : 'debug');
      if (s === 'failed') {
        this.log('ICE connection failed – attempting restart…', 'warn');
        this.pc.restartIce?.();
      }
    };

    // ── Track / stream events ────────────────────────────────────────────────
    this.pc.ontrack = (event) => {
      this.log('Remote track received ✓', 'ok');
      this.onStateChange('streaming');

      const [stream] = event.streams;
      if (stream && this.videoEl.srcObject !== stream) {
        this.videoEl.srcObject = stream;
        this.videoEl.play().catch((e) => {
          this.log(`Video play blocked: ${e.message}`, 'warn');
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.log(`Connection state → ${s}`, 'debug');
      if (s === 'failed' || s === 'disconnected') {
        this.onStateChange('error');
      }
    };

    return this.pc;
  }

  async _handleOffer(sdp) {
    try {
      this._createPeerConnection();
      this.onStateChange('connecting');

      await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      this.log('Remote description set (offer)', 'debug');

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.log('Local description set (answer)', 'debug');

      // FIX Bug 2: send `viewerSocketId` (our own socket ID) not `streamerSocketId`
      // so the streamer can look us up in its peerConnections map.
      sendSignal('webrtc-answer', {
        roomId        : this.roomId,
        sdp           : this.pc.localDescription,
        viewerSocketId: this.socketId,
      });
      this.log('Answer sent to streamer', 'info');
    } catch (err) {
      this.log(`Offer handling failed: ${err.message}`, 'error');
      this.onStateChange('error');
    }
  }

  async _addIceCandidate(candidate) {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      this.log(`ICE candidate error: ${err.message}`, 'warn');
    }
  }
}