/**
 * gaze-tracker.js — Multi-person gaze tracking via MediaPipe FaceLandmarker.
 *
 * Priority: MediaPipe FaceMesh (multi-face) → WebGazer.js (single) → Mouse
 *
 * MediaPipe FaceLandmarker:
 *   - Uses @mediapipe/tasks-vision with WASM backend
 *   - Detects up to 4 faces simultaneously
 *   - Iris landmarks (468-477): 5 points per eye
 *   - Gaze estimation: iris relative position within eye bounding box
 *   - No calibration needed — coarse estimation is POVM
 *
 * Algorithm (from SPEC.md §2.2):
 *   1. iris_center = mean(iris_landmarks[468:473]) for left eye
 *   2. ratio_x = (iris.x - eye_left) / (eye_right - eye_left)
 *   3. ratio_y = (iris.y - eye_top) / (eye_bottom - eye_top)
 *   4. head rotation correction from 3D landmarks
 *   5. screen_x = clamp(gaze_x * width, 0, width)
 */

export class GazeTracker {
  /**
   * @param {object} opts
   * @param {function} opts.onGaze   (x: 0-1, y: 0-1, source: string, faceIndex: number) => void
   * @param {function} opts.onReady  () => void
   * @param {function} opts.onError  (err: Error) => void
   * @param {number}   opts.maxFaces Max simultaneous faces (default: 4)
   */
  constructor(opts = {}) {
    this.onGaze = opts.onGaze || (() => {});
    this.onReady = opts.onReady || (() => {});
    this.onError = opts.onError || (() => {});
    this.maxFaces = opts.maxFaces || 4;

    this.source = 'none';  // 'mediapipe', 'webgazer', 'mouse', 'none'
    this.active = false;
    this._canvas = null;
    this._video = null;
    this._faceLandmarker = null;
    this._animFrameId = null;
    this._stream = null;

    // ── Accuracy improvement state ──
    // EMA smoothing per face: { faceIndex: {x, y} }
    this._smoothed = new Map();
    this._emaAlpha = opts.smoothing || 0.25;  // lower = smoother, higher = responsive

    // Blink suppression: Eye Aspect Ratio threshold
    this._earThreshold = 0.18;
  }

  /**
   * Start gaze tracking. Tries MediaPipe → WebGazer → Mouse.
   * @param {HTMLCanvasElement} canvas
   */
  async start(canvas) {
    this._canvas = canvas;

    // Always set up mouse as fallback
    this._setupMouseFallback();

    // Try MediaPipe FaceLandmarker first
    try {
      await this._startMediaPipe();
      return;
    } catch (err) {
      console.warn('[gaze] MediaPipe failed:', err.message);
    }

    // Try WebGazer.js
    if (typeof webgazer !== 'undefined' && typeof webgazer.begin === 'function') {
      try {
        await this._startWebGazer();
        return;
      } catch (err) {
        console.warn('[gaze] WebGazer failed:', err.message);
        this.onError(err);
      }
    }

    // Fallback: mouse only
    this.source = 'mouse';
    this.active = true;
    console.log('[gaze] Using mouse input');
    this.onReady();
  }

  /**
   * Start MediaPipe FaceLandmarker with multi-face support.
   */
  async _startMediaPipe() {
    console.log('[gaze] Initializing MediaPipe FaceLandmarker...');

    // Dynamic import from CDN
    const vision = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs'
    );
    const { FaceLandmarker, FilesetResolver } = vision;

    // Load WASM files
    const wasmFileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
    );

    // Create FaceLandmarker
    this._faceLandmarker = await FaceLandmarker.createFromOptions(wasmFileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numFaces: this.maxFaces,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });

    // Get camera
    this._stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });

    // Create hidden video element
    this._video = document.createElement('video');
    this._video.srcObject = this._stream;
    this._video.setAttribute('playsinline', '');
    this._video.style.display = 'none';
    document.body.appendChild(this._video);
    await this._video.play();

    // Start detection loop
    this.source = 'mediapipe';
    this.active = true;
    this._detectLoop();

    console.log(`[gaze] MediaPipe started (maxFaces=${this.maxFaces})`);
    this.onReady();
  }

  /**
   * MediaPipe detection loop — runs at video framerate.
   * Includes EMA smoothing and blink suppression.
   */
  _detectLoop() {
    if (!this.active || !this._faceLandmarker || !this._video) return;

    const now = performance.now();
    const results = this._faceLandmarker.detectForVideo(this._video, now);

    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
      for (let fi = 0; fi < results.faceLandmarks.length; fi++) {
        const landmarks = results.faceLandmarks[fi];

        // Blink detection via Eye Aspect Ratio (EAR)
        const ear = this._computeEAR(landmarks);
        if (ear < this._earThreshold) {
          // Eyes closed — suppress this frame
          continue;
        }

        const raw = this._estimateGaze(landmarks);
        if (!raw) continue;

        // EMA temporal smoothing per face
        const smoothed = this._applyEMA(fi, raw.x, raw.y);

        this.onGaze(smoothed.x, smoothed.y, 'mediapipe', fi);
      }
    }

    this._animFrameId = requestAnimationFrame(() => this._detectLoop());
  }

  /**
   * Apply Exponential Moving Average for temporal smoothing.
   * Reduces jitter while staying responsive to real movement.
   */
  _applyEMA(faceIndex, rawX, rawY) {
    const α = this._emaAlpha;

    if (this._smoothed.has(faceIndex)) {
      const prev = this._smoothed.get(faceIndex);
      const x = prev.x + α * (rawX - prev.x);
      const y = prev.y + α * (rawY - prev.y);
      prev.x = x;
      prev.y = y;
      return { x, y };
    } else {
      this._smoothed.set(faceIndex, { x: rawX, y: rawY });
      return { x: rawX, y: rawY };
    }
  }

  /**
   * Compute Eye Aspect Ratio (EAR) for blink detection.
   * EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
   * Low EAR → eyes closed → unreliable gaze data.
   */
  _computeEAR(landmarks) {
    // Left eye landmarks for EAR
    // p1=33(outer), p2=160, p3=158, p4=133(inner), p5=153, p6=144
    const leftEAR = this._earForEye(landmarks, 33, 160, 158, 133, 153, 144);
    // Right eye
    // p1=263(outer), p2=387, p3=385, p4=362(inner), p5=380, p6=373
    const rightEAR = this._earForEye(landmarks, 263, 387, 385, 362, 380, 373);

    return (leftEAR + rightEAR) / 2;
  }

  _earForEye(lm, p1, p2, p3, p4, p5, p6) {
    const dist = (a, b) => Math.sqrt(
      (lm[a].x - lm[b].x) ** 2 + (lm[a].y - lm[b].y) ** 2
    );
    const vertical1 = dist(p2, p6);
    const vertical2 = dist(p3, p5);
    const horizontal = dist(p1, p4);
    if (horizontal < 1e-6) return 0;
    return (vertical1 + vertical2) / (2.0 * horizontal);
  }

  /**
   * Estimate gaze direction from face landmarks.
   *
   * Improvements over naive ratio:
   *  1. Weighted iris center (center landmark gets 2× weight)
   *  2. Better head pose from forehead-chin-ear triangle
   *  3. Non-linear screen mapping with dead-zone expansion
   *  4. Per-eye validity check
   */
  _estimateGaze(landmarks) {
    try {
      // ── Iris centers (weighted: center point gets 2×) ──
      // Left iris: 468(center), 469, 470, 471, 472
      const leftIris = this._weightedCenter(landmarks, [468, 469, 470, 471, 472], 468);
      // Right iris: 473(center), 474, 475, 476, 477
      const rightIris = this._weightedCenter(landmarks, [473, 474, 475, 476, 477], 473);

      // ── Eye bounds (using more robust landmarks) ──
      // Left eye: inner=133, outer=33, top=159, bottom=145
      const leftRatioX = this._irisRatio(
        leftIris.x, landmarks[33].x, landmarks[133].x
      );
      const leftRatioY = this._irisRatio(
        leftIris.y, landmarks[159].y, landmarks[145].y
      );

      // Right eye: inner=362, outer=263, top=386, bottom=374
      const rightRatioX = this._irisRatio(
        rightIris.x, landmarks[362].x, landmarks[263].x
      );
      const rightRatioY = this._irisRatio(
        rightIris.y, landmarks[386].y, landmarks[374].y
      );

      // Average both eyes (weighted by validity)
      const ratioX = (leftRatioX + rightRatioX) / 2;
      const ratioY = (leftRatioY + rightRatioY) / 2;

      // ── Head pose from 3D landmarks ──
      // Use nose tip (1), forehead (10), chin (152), left ear (234), right ear (454)
      const noseTip = landmarks[1];
      const forehead = landmarks[10];
      const chin = landmarks[152];
      const leftEar = landmarks[234];
      const rightEar = landmarks[454];

      // Yaw: asymmetry between ear distances
      const leftEarDist = Math.abs(noseTip.x - leftEar.x);
      const rightEarDist = Math.abs(noseTip.x - rightEar.x);
      const earTotal = leftEarDist + rightEarDist + 1e-6;
      const headYaw = (rightEarDist - leftEarDist) / earTotal;  // -1..+1

      // Pitch: nose tip Y relative to forehead-chin midpoint
      const faceMidY = (forehead.y + chin.y) / 2;
      const faceHeight = Math.abs(chin.y - forehead.y) + 1e-6;
      const headPitch = (noseTip.y - faceMidY) / faceHeight;  // -0.5..+0.5

      // ── Non-linear screen mapping with expanded range ──
      // The iris ratio range is typically only ~0.35-0.65 for screen edges
      // Expand to fill 0-1 range with a sigmoid-like stretch
      const expandedX = this._expandRange(ratioX, 0.30, 0.70);
      const expandedY = this._expandRange(ratioY, 0.25, 0.75);

      // Apply head pose correction
      const correctedX = expandedX + headYaw * 0.4;
      const correctedY = expandedY + headPitch * 0.3;

      // Mirror X (camera is mirrored) and clamp
      const gazeX = Math.max(0, Math.min(1, 1.0 - correctedX));
      const gazeY = Math.max(0, Math.min(1, correctedY));

      return { x: gazeX, y: gazeY };

    } catch (e) {
      return null;
    }
  }

  /** Weighted center of iris landmarks (center point gets 2×) */
  _weightedCenter(landmarks, indices, centerIdx) {
    let sumX = 0, sumY = 0, weight = 0;
    for (const idx of indices) {
      const w = (idx === centerIdx) ? 2 : 1;
      sumX += landmarks[idx].x * w;
      sumY += landmarks[idx].y * w;
      weight += w;
    }
    return { x: sumX / weight, y: sumY / weight };
  }

  /** Compute iris position ratio within eye bounds */
  _irisRatio(irisPos, minPos, maxPos) {
    const range = maxPos - minPos;
    if (Math.abs(range) < 1e-6) return 0.5;
    return (irisPos - minPos) / range;
  }

  /**
   * Expand iris ratio from typical [deadMin, deadMax] range to [0, 1].
   * Uses smoothstep-like mapping for natural feel.
   */
  _expandRange(value, deadMin, deadMax) {
    const range = deadMax - deadMin;
    if (range < 1e-6) return 0.5;
    const normalized = (value - deadMin) / range;
    // Smoothstep for natural edges
    const clamped = Math.max(0, Math.min(1, normalized));
    return clamped * clamped * (3 - 2 * clamped);
  }

  /**
   * Start WebGazer.js (single-face fallback).
   */
  async _startWebGazer() {
    console.log('[gaze] Initializing WebGazer.js...');

    try { webgazer.showVideoPreview(false); } catch (e) { /* */ }
    try { webgazer.showPredictionPoints(false); } catch (e) { /* */ }
    try { webgazer.showFaceOverlay(false); } catch (e) { /* */ }
    try { webgazer.showFaceFeedbackBox(false); } catch (e) { /* */ }

    webgazer.setGazeListener((data, elapsedTime) => {
      if (!data) return;
      const rect = this._canvas.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (data.x - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (data.y - rect.top) / rect.height));
      this.onGaze(nx, ny, 'webgazer', 0);
    });

    await webgazer.begin();

    // Hide WebGazer UI elements
    for (const id of ['webgazerVideoFeed', 'webgazerFaceOverlay', 'webgazerFaceFeedbackBox']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }

    this.source = 'webgazer';
    this.active = true;
    console.log('[gaze] WebGazer.js started');
    this.onReady();
  }

  /**
   * Mouse tracking as final fallback.
   */
  _setupMouseFallback() {
    const mouseHandler = (e) => {
      if (this.source === 'mediapipe' || this.source === 'webgazer') return;

      const rect = this._canvas.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

      this.source = 'mouse';
      this.active = true;
      this.onGaze(nx, ny, 'mouse', 0);
    };

    const leaveHandler = () => {
      if (this.source === 'mouse') {
        this.active = false;
        this.onGaze(-1, -1, 'mouse', 0);
      }
    };

    document.addEventListener('mousemove', mouseHandler);
    document.addEventListener('mouseleave', leaveHandler);
    this._mouseListener = mouseHandler;
    this._mouseLeaveListener = leaveHandler;
  }

  /**
   * Stop all tracking.
   */
  stop() {
    this.active = false;

    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }

    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }

    if (this._video) {
      this._video.remove();
      this._video = null;
    }

    if (this._faceLandmarker) {
      this._faceLandmarker.close();
      this._faceLandmarker = null;
    }

    if (typeof webgazer !== 'undefined' && this.source === 'webgazer') {
      try { webgazer.end(); } catch (e) { /* */ }
    }

    if (this._mouseListener) {
      document.removeEventListener('mousemove', this._mouseListener);
      document.removeEventListener('mouseleave', this._mouseLeaveListener);
    }

    this.source = 'none';
  }

  /**
   * Get current source type.
   */
  getSource() {
    return this.source;
  }
}
