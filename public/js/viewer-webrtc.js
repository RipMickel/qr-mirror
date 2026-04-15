/**
 * viewer-webrtc.js – WebRTC logic for the PC Viewer
 *
 * FIXES APPLIED:
 *  1. Corrected answer payload to send viewerSocketId consistently
 *  2. Robust signaling listener attachment/detachment with verification
 *  3. Added comprehensive logging for debugging connection state
 *  4. Handle ICE candidates only from paired streamer (with fallback)
 *  5. Proper error handling and recovery for stale connections
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
    this.roomId        = roomId;
    this.socketId      = socketId;
    this.iceConfig     = iceConfig;
    this.videoEl       = videoEl;
    this.onStateChange = onStateChange || (() => {});
    this.log           = onLog         || ((m) => console.log(m));

    /** @type {RTCPeerConnection|null} */
    this.pc = null;

    /** @type {string|null} ID of the streamer socket we're paired with */
    this.streamerSocketId = null;

    // Named handler refs so we can remove them on destroy
    this._onOffer        = null;
    this._onIce          = null;
    this._onStreamerLeft = null;

    // Track attachment state to prevent double-attachment
    this._listenersAttached = false;

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
    if (this.pc) {
      this.pc.close();
      this.pc = null;
      this.log('Peer connection closed', 'debug');
    }
    this.log('Viewer WebRTC destroyed', 'warn');
    this.onStateChange('idle');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _attachSignalingListeners() {
    // Prevent double-attachment
    if (this._listenersAttached) {
      this.log('Signaling listeners already attached', 'debug');
      return;
    }

    this._detachSignalingListeners();

    // Store named refs so we can remove them precisely
    this._onOffer = ({ sdp, streamerSocketId }) => {
      this.log(`[OFFER] Received from streamer: ${streamerSocketId}`, 'info');
      this.streamerSocketId = streamerSocketId;
      this._handleOffer(sdp);
    };

    this._onIce = ({ candidate, fromSocketId }) => {
      // Log ICE receipt
      this.log(`[ICE] Candidate from: ${fromSocketId}`, 'debug');
      
      // Only handle candidates from our paired streamer, or if no streamer yet (bootstrap)
      if (this.streamerSocketId && fromSocketId && fromSocketId !== this.streamerSocketId) {
        this.log(`[ICE] Ignoring candidate from different streamer (${fromSocketId} vs ${this.streamerSocketId})`, 'warn');
        return;
      }
      this._addIceCandidate(candidate);
    };

    this._onStreamerLeft = ({ reason }) => {
      this.log(`[STREAMER-LEFT] Disconnected: ${reason}`, 'warn');
      this.destroy();
      this.onStateChange('streamer-left');
    };

    onSignal('webrtc-offer',  this._onOffer);
    onSignal('ice-candidate', this._onIce);
    onSignal('streamer-left', this._onStreamerLeft);

    this._listenersAttached = true;
    this.log('[SIGNALING] Listeners attached', 'debug');
  }

  _detachSignalingListeners() {
    if (this._onOffer) {
      offSignal('webrtc-offer', this._onOffer);
      this._onOffer = null;
    }
    if (this._onIce) {
      offSignal('ice-candidate', this._onIce);
      this._onIce = null;
    }
    if (this._onStreamerLeft) {
      offSignal('streamer-left', this._onStreamerLeft);
      this._onStreamerLeft = null;
    }
    this._listenersAttached = false;
    this.log('[SIGNALING] Listeners detached', 'debug');
  }

  /** Create (or re-create) the RTCPeerConnection. */
  _createPeerConnection() {
    if (this.pc) {
      this.pc.close();
      this.log('[PC] Closing previous peer connection', 'debug');
    }

    this.pc = new RTCPeerConnection(this.iceConfig);
    this.log('[PC] RTCPeerConnection created', 'debug');

    // ── ICE events ──────────────────────────────────────────────────────────
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.log(`[ICE-OUT] Sending candidate (${candidate.candidate.substring(0, 50)}...)`, 'debug');
        sendSignal('ice-candidate', {
          roomId        : this.roomId,
          candidate,
          targetSocketId: this.streamerSocketId,
        });
      } else {
        this.log('[ICE-OUT] ICE gathering complete', 'debug');
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      this.log(`[ICE-STATE] ${s}`, s === 'connected' || s === 'completed' ? 'ok' : 'debug');
      if (s === 'failed') {
        this.log('[ICE-STATE] Failed – attempting restart…', 'warn');
        this.pc.restartIce?.();
      }
    };

    // ── Track / stream events ────────────────────────────────────────────────
    this.pc.ontrack = (event) => {
      this.log(`[TRACK] Remote track received: ${event.track.kind}`, 'ok');
      this.onStateChange('streaming');

      const [stream] = event.streams;
      if (stream) {
        if (this.videoEl.srcObject !== stream) {
          this.log('[STREAM] Attaching remote stream to video element', 'info');
          this.videoEl.srcObject = stream;
          this.videoEl.play().catch((e) => {
            this.log(`[STREAM] Video play blocked: ${e.message}`, 'warn');
          });
        }
      } else {
        this.log('[TRACK] No stream in event – attaching track directly', 'warn');
        if (event.track.kind === 'video') {
          this.videoEl.srcObject = new MediaStream([event.track]);
          this.videoEl.play().catch((e) => {
            this.log(`[STREAM] Direct track play failed: ${e.message}`, 'warn');
          });
        }
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.log(`[CONN-STATE] ${s}`, 'debug');
      if (s === 'failed' || s === 'disconnected') {
        this.log('[CONN-STATE] Connection failed/disconnected', 'warn');
        this.onStateChange('error');
      }
    };

    return this.pc;
  }

  async _handleOffer(sdp) {
    try {
      this.log('[OFFER-HANDLE] Creating peer connection…', 'debug');
      this._createPeerConnection();
      this.onStateChange('connecting');

      this.log('[OFFER-HANDLE] Setting remote description (offer)…', 'debug');
      await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      this.log('[OFFER-HANDLE] Remote description set ✓', 'ok');

      this.log('[OFFER-HANDLE] Creating answer…', 'debug');
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.log('[OFFER-HANDLE] Local description set (answer) ✓', 'ok');

      // Send answer with viewerSocketId (OUR socket ID) so streamer can match the peer connection
      sendSignal('webrtc-answer', {
        roomId        : this.roomId,
        sdp           : this.pc.localDescription,
        viewerSocketId: this.socketId,
      });
      this.log('[ANSWER-SENT] Answer sent with viewerSocketId: ' + this.socketId.substring(0, 8), 'info');
    } catch (err) {
      this.log(`[OFFER-HANDLE] Error: ${err.message}`, 'error');
      this.onStateChange('error');
    }
  }

  async _addIceCandidate(candidate) {
    if (!this.pc) {
      this.log('[ICE-IN] No peer connection yet – discarding candidate', 'warn');
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      this.log('[ICE-IN] Candidate added ✓', 'debug');
    } catch (err) {
      this.log(`[ICE-IN] Error: ${err.message}`, 'warn');
    }
  }
}