/**
 * static-preview.js — ±Quantum pattern preview.
 *
 * 3-layer hybrid architecture:
 *   L1: Quantum walk (Schrödinger equation) → wave patterns
 *   L2: Quantum tile circuits (state vectors) → measurement / entanglement
 *
 * Modes:
 *   __qw:*      — L1 only (wave patterns)
 *   __hybrid    — L1 + L2 (wave + measurement)
 */

import { QuantumWalk } from './quantum-walk.js';
import { QuantumTileSystem } from './quantum-tile.js';
import { EntanglementClient } from './entanglement-client.js';
import { loadPatterns, getCurrentPatternAt, getCurrentPatternName, nextPattern, setPattern } from './collapse-patterns.js';
import { GazeTracker } from './gaze-tracker.js';
import { WebGLRenderer } from './webgl-renderer.js';

const FONT_SIZE  = 10;
const BG_COLOR   = '#0a0a0c';

let canvas, ctx;
let cellW, cellH, cols, rows;
let scaledFont;
let currentMode = '__hybrid';
let animId = null;
let lastTime = 0;

// L1: Quantum walk instance
let qw = null;

// L2: Quantum tile system
let tileSystem = null;
const TILE_COLS = 32;
const TILE_ROWS = 16;

// Measurement config
const GAZE_SIGMA = 3.0;
let gazePresent = false;
// Multi-person: array of active gaze points [{x, y, faceIndex}]
let gazePoints = [];

// Per-cell collapse outcome: 0 = not collapsed, 1 = '+', 2 = '−'
let cellOutcome = null;

// Pattern auto-cycle timer
let patternCycleTimer = null;
const PATTERN_CYCLE_SECONDS = 20;

// Entanglement
let entanglementClient = null;

// Gaze tracker (WebGazer + mouse fallback)
let gazeTracker = null;

// WebGL renderer (Canvas 2D fallback)
let glRenderer = null;
let useWebGL = false;

// Display mode detection
const isDisplayMode = window.location.pathname.includes('display.html');

async function init() {
  canvas = document.getElementById('grid-canvas');

  // Try WebGL2 first, fall back to Canvas 2D
  glRenderer = new WebGLRenderer();
  setupCanvas();
  const maxCells = cols * rows;
  if (glRenderer.init(canvas, maxCells)) {
    useWebGL = true;
    // Keep a 2D context reference for non-hybrid modes (photo, procedural)
    const offscreen = document.createElement('canvas');
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    ctx = offscreen.getContext('2d');
    console.log('[render] Using WebGL2 instanced renderer');
  } else {
    useWebGL = false;
    ctx = canvas.getContext('2d');
    console.log('[render] Using Canvas 2D fallback');
  }
  initQuantumWalk();
  initTileSystem();
  await loadPatterns(cols, rows);
  initEntanglement();

  // Controls (only in static.html, not display.html)
  const select = document.getElementById('image-select');
  if (select) {
    select.addEventListener('change', async (e) => {
      currentMode = e.target.value;
      if (currentMode.startsWith('__qw:') || currentMode === '__hybrid') {
        initQuantumWalk();
        if (currentMode === '__hybrid') initTileSystem();
      } else if (currentMode.startsWith('__proc:')) {
        // procedural modes handled in animation loop
      } else {
        // Photo mode — static
        const brightness = await loadAndProcess(currentMode, cols, rows);
        renderDensity(brightness, true);
      }
    });
  }

  const gammaSlider = document.getElementById('gamma-slider');
  if (gammaSlider) {
    gammaSlider.addEventListener('input', () => {
      document.getElementById('gamma-value').textContent = gammaSlider.value;
    });
  }

  // Gaze / mouse input via GazeTracker (multi-person)
  const gazeStatusEl = document.getElementById('gaze-status');
  gazeTracker = new GazeTracker({
    maxFaces: 4,
    onGaze: (x, y, source, faceIndex) => {
      if (x < 0 || y < 0) {
        // Remove this face's gaze point
        gazePoints = gazePoints.filter(p => p.faceIndex !== faceIndex);
        gazePresent = gazePoints.length > 0;
        return;
      }

      // Update or add gaze point for this face
      const existing = gazePoints.find(p => p.faceIndex === faceIndex);
      if (existing) {
        existing.x = x;
        existing.y = y;
      } else {
        gazePoints.push({ x, y, faceIndex });
      }
      gazePresent = true;

      // Inject wave packet at each gaze point
      if (qw && (currentMode.startsWith('__qw:') || currentMode === '__hybrid')) {
        qw.injectWavePacket(x * cols, y * rows, 2.5, 0.15);
      }
    },
    onReady: () => {
      if (gazeStatusEl) gazeStatusEl.textContent = gazeTracker.getSource();
      console.log(`[gaze] Ready: source=${gazeTracker.getSource()}`);
    },
    onError: (err) => {
      if (gazeStatusEl) gazeStatusEl.textContent = 'mouse (fallback)';
      console.warn('[gaze] Error:', err.message);
    }
  });
  gazeTracker.start(canvas);

  window.addEventListener('resize', () => {
    setupCanvas();
    initQuantumWalk();
    if (currentMode === '__hybrid') initTileSystem();
  });

  lastTime = performance.now() / 1000;

  // Auto-cycle patterns every N seconds
  patternCycleTimer = setInterval(() => {
    const name = nextPattern();
    console.log(`[pattern] Switched to: ${name}`);
    // Clear all collapsed tiles so new pattern emerges on next observation
    if (tileSystem && cellOutcome) {
      for (let i = 0; i < tileSystem.collapsed.length; i++) {
        tileSystem.collapsed[i] = 0;
        tileSystem.fadeProgress[i] = 1.0;
      }
      cellOutcome.fill(0);
    }
  }, PATTERN_CYCLE_SECONDS * 1000);

  animate();
}

function setupCanvas() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';

  scaledFont = FONT_SIZE * devicePixelRatio;
  cellW = Math.ceil(scaledFont * 0.6);
  cellH = Math.ceil(scaledFont * 1.1);
  cols = Math.floor(canvas.width / cellW);
  rows = Math.floor(canvas.height / cellH);

  // Set font for Canvas 2D modes (may not exist in WebGL mode)
  if (ctx) {
    ctx.font = `${scaledFont}px 'IBM Plex Mono','Source Code Pro','Consolas',monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  // Resize WebGL viewport
  if (glRenderer && useWebGL) {
    glRenderer.resize(canvas.width, canvas.height);
  }

  console.log(`Grid: ${cols}×${rows} = ${cols * rows} cells`);
}

/**
 * Initialize quantum walk with wave sources.
 * Sources continuously inject amplitude → propagating wavefronts.
 */
function initQuantumWalk() {
  qw = new QuantumWalk(cols, rows, {
    J: 0.4,
    dt: 0.025,
    damping: 0.9992
  });

  const mode = currentMode === '__hybrid' ? '__qw:ripple' : currentMode;

  if (mode === '__qw:ripple') {
    // Dense grid of sources to fill entire screen with interference
    const srcCols = 5, srcRows = 3;
    for (let sy = 0; sy < srcRows; sy++) {
      for (let sx = 0; sx < srcCols; sx++) {
        const x = Math.round(cols * (sx + 0.5) / srcCols);
        const y = Math.round(rows * (sy + 0.5) / srcRows);
        const amp = 2.0 + Math.sin(sx * 1.7 + sy * 2.3) * 0.8;
        const freq = 5.5 + Math.cos(sx * 0.9 + sy * 1.4) * 1.5;
        const phase = (sx * 2.1 + sy * 3.7) % (Math.PI * 2);
        qw.addSource(x, y, amp, freq, phase);
      }
    }
  } else if (mode === '__qw:single') {
    qw.addSource(Math.round(cols / 2), Math.round(rows / 2), 2.5, 8.0, 0);
  } else if (mode === '__qw:edge') {
    for (let i = 0; i < rows; i += Math.max(1, Math.floor(rows / 8))) {
      qw.addSource(2, i, 2.5, 4.0, 0);
    }
  }

  console.log(`L1 Quantum walk: ${mode}, ${cols}×${rows}`);
}

function initTileSystem() {
  tileSystem = new QuantumTileSystem(TILE_COLS, TILE_ROWS, 2);
  cellOutcome = new Uint8Array(cols * rows);  // 0=superposition, 1=+, 2=−
  console.log(`L2 Tile system: ${TILE_COLS}×${TILE_ROWS} = ${TILE_COLS * TILE_ROWS} tiles, k=2 qubits`);
}

/**
 * Initialize entanglement client (WebSocket A-B link).
 * Reads URL param ?role=A or ?role=B. If present, connects.
 * Each display shows its OWN pattern — entanglement syncs timing, not content.
 */
function initEntanglement() {
  const params = new URLSearchParams(window.location.search);
  const role = params.get('role');

  if (!role) {
    console.log('[entanglement] No ?role= param — standalone mode');
    return;
  }

  // Role-based pattern offset: A and B show DIFFERENT images
  // This models Bell state: measurement collapses both, but outcomes depend on local basis
  const roleUpper = role.toUpperCase();
  if (roleUpper === 'B') {
    setPattern(1);  // B starts with a different pattern than A
    console.log(`[entanglement] Role B: pattern offset → ${getCurrentPatternName()}`);
  } else {
    setPattern(0);
    console.log(`[entanglement] Role A: pattern → ${getCurrentPatternName()}`);
  }

  // Status indicator
  const statusEl = document.getElementById('ws-status');
  if (statusEl) {
    statusEl.style.display = 'inline-block';
    statusEl.style.background = '#ef4444';
  }

  entanglementClient = new EntanglementClient(roleUpper, tileSystem, {
    onStatusChange: (connected) => {
      if (statusEl) {
        statusEl.style.background = connected
          ? (entanglementClient.partnerConnected ? '#4ade80' : '#facc15')
          : '#ef4444';
        statusEl.title = connected
          ? (entanglementClient.partnerConnected ? `${roleUpper}: connected (partner online)` : `${roleUpper}: connected (waiting for partner)`)
          : `${roleUpper}: disconnected`;
      }
    }
  });

  // Wire: local collapse → send tile index to partner (timing only, not outcome)
  tileSystem.onCollapse = (tileIdx, outcome) => {
    entanglementClient.sendCollapse(tileIdx);
  };

  entanglementClient.connect();
  console.log(`[entanglement] Client role=${roleUpper} initialized, pattern=${getCurrentPatternName()}`);
}

let procTime = 0;

function generateProceduralRipple(cols, rows, t) {
  const data = new Float32Array(cols * rows);
  const cx = cols / 2, cy = rows / 2;
  const aspect = cellW / cellH;
  const sources = [
    { x: cx * 0.6, y: cy * 0.5, freq: 0.25, phase: 0 },
    { x: cx * 1.4, y: cy * 0.7, freq: 0.28, phase: Math.PI * 0.5 },
    { x: cx * 0.8, y: cy * 1.5, freq: 0.22, phase: Math.PI },
  ];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let wave = 0;
      for (const src of sources) {
        const dx = c - src.x;
        const dy = (r - src.y) * aspect;
        const dist = Math.sqrt(dx * dx + dy * dy);
        wave += Math.sin(dist * src.freq - t * 1.5 + src.phase);
      }
      data[r * cols + c] = (wave / sources.length + 1) / 2;
    }
  }
  return data;
}

function generateReactionDiffusion(cols, rows, t) {
  const data = new Float32Array(cols * rows);
  const aspect = cellW / cellH;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c / cols * 10;
      const y = (r / rows) * 10 * aspect;
      const v1 = Math.sin(x * 3.7 + y * 2.1 + t * 0.3);
      const v2 = Math.sin(x * 1.3 - y * 4.2 + t * 0.2);
      const v3 = Math.sin(x * 2.8 + y * 0.5 - t * 0.4);
      const v4 = Math.cos(x * 1.7 * Math.sin(y * 0.5 + t * 0.15));
      data[r * cols + c] = ((v1 + v2 + v3 + v4) / 4 + 1) / 2;
    }
  }
  return data;
}

/* ══════════════════════════════════════════
   Rendering
   ══════════════════════════════════════════ */

/**
 * Render density map to +/− characters.
 *
 * For quantum walk: density = |ψ|² normalized to [0,1].
 *   High density → show characters (wave is here)
 *   Low density  → blank (vacuum / node)
 *
 * For photos: inverted (dark = characters).
 *
 * @param {Float32Array} density  [0,1] values per cell
 * @param {boolean} inverted      If true, high values → blank (for photos)
 */
function renderDensity(density, inverted = false) {
  const gammaSlider = document.getElementById('gamma-slider');
  const gamma = gammaSlider ? parseFloat(gammaSlider.value) : 0.5;

  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let d = density[r * cols + c];
      if (isNaN(d)) continue;

      // For photos: invert (dark areas → characters)
      if (inverted) d = 1 - d;

      // Gamma
      d = Math.pow(Math.max(0, d), gamma);

      // Threshold: d > 0.05 → show character
      if (d < 0.05) continue;

      // Character choice based on amplitude
      //   + for strong presence, − for weak
      const ch = d > 0.4 ? '+' : '–';

      // Alpha proportional to density
      const alpha = Math.min(1.0, 0.15 + d * 0.85);

      ctx.fillStyle = `rgba(224, 224, 224, ${alpha.toFixed(2)})`;
      ctx.fillText(ch, c * cellW + cellW / 2, r * cellH + cellH / 2);
    }
  }
}

/**
 * Render hybrid mode: L1 (quantum walk) + L2 (quantum tiles).
 *
 * DISCRETE MEASUREMENT MODEL:
 *
 *   Superposition:
 *     Each cell: per-frame random choice between + and −.
 *     P(+) = pPlus (biased by source image brightness).
 *     The cell is ALWAYS either + or −, never in between.
 *     Flickering = genuine uncertainty. You cannot tell what it IS.
 *
 *   Collapsed (observed):
 *     The choice is LOCKED. No more flickering. Static + or −.
 *     Because pPlus is image-biased, the statistical pattern
 *     of locked +/− reveals the source image as halftone.
 *     This is the image "appearing through observation".
 *
 *   Coherence controls flicker QUALITY:
 *     High coherence → rhythmic switching ("actively both")
 *     Low coherence  → random noise ("just uncertain")
 */
function renderHybrid(density) {
  const gammaSlider = document.getElementById('gamma-slider');
  const gamma = gammaSlider ? parseFloat(gammaSlider.value) : 0.5;
  const t = performance.now();

  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Bar geometry
  const barThick = Math.max(1, Math.round(scaledFont * 0.14));
  const halfLenH = cellW * 0.35;
  const halfLenV = cellH * 0.35;

  // Cells per tile
  const cellsPerTileX = Math.max(1, Math.floor(cols / TILE_COLS));
  const cellsPerTileY = Math.max(1, Math.floor(rows / TILE_ROWS));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Map cell to tile
      const tx = Math.min(TILE_COLS - 1, Math.floor(c / cellsPerTileX));
      const ty = Math.min(TILE_ROWS - 1, Math.floor(r / cellsPerTileY));
      const tileIdx = ty * TILE_COLS + tx;

      const isCollapsed = tileSystem.collapsed[tileIdx];
      const fade = tileSystem.fadeProgress[tileIdx];

      // Wave density at this cell
      let d = density[r * cols + c];
      if (isNaN(d)) d = 0;
      d = Math.pow(Math.max(0, d), gamma);

      // Cell center
      const cx = c * cellW + cellW / 2;
      const cy = r * cellH + cellH / 2;

      if (isCollapsed !== 0 && fade < 1.0) {
        // ── COLLAPSED: per-cell outcomes at UNIFORM brightness ──
        // Each cell's +/− was determined at collapse time from wave density.
        const cellIdx = r * cols + c;
        const outcome = cellOutcome[cellIdx];
        if (outcome === 0) continue;  // not yet snapshot'd

        const collapseStrength = 1.0 - fade;

        // Edge softening within tile
        const inTileX = (c % cellsPerTileX) / cellsPerTileX;
        const inTileY = (r % cellsPerTileY) / cellsPerTileY;
        const edgeDist = Math.min(inTileX, 1 - inTileX, inTileY, 1 - inTileY);
        const edgeFade = edgeDist < 0.15 ? (edgeDist / 0.15) : 1.0;

        const alpha = 0.85 * collapseStrength * (0.5 + 0.5 * edgeFade);
        if (alpha < 0.04) continue;

        // Uniform warm white
        const aStr = Math.min(1.0, alpha).toFixed(2);
        ctx.fillStyle = `rgba(230, 225, 210, ${aStr})`;

        // Horizontal bar (always)
        ctx.fillRect(cx - halfLenH, cy - barThick / 2, halfLenH * 2, barThick);

        // Vertical bar (only for +)
        if (outcome === 1) {
          ctx.fillRect(cx - barThick / 2, cy - halfLenV, barThick, halfLenV * 2);
        }

      } else {
        // ── SUPERPOSITION: discrete flicker ──────────────────────
        // Each cell randomly shows + or − each frame.
        // Wave density d is the bias: high density → + (interference bright spots)
        if (d < 0.02) continue;

        const coh = tileSystem.getCoherence(tx, ty);

        // Coherence-driven decision:
        //   High coh → rhythmic (sin-wave threshold) → "actively both"
        //   Low coh  → pure random → "just uncertain"
        const phase = tx * 7.3 + ty * 13.7 + c * 0.37 + r * 0.71;
        const rhythmic = 0.5 + 0.5 * Math.sin(t * 0.008 + phase);
        const noise = Math.random();
        const threshold = coh * rhythmic + (1 - coh) * noise;
        const showPlus = threshold < d;  // wave density IS the bias

        // Base alpha from wave density
        const baseAlpha = Math.min(0.55, d * 0.65);
        if (baseAlpha < 0.03) continue;

        // Cool blue-gray
        const aStr = baseAlpha.toFixed(2);
        ctx.fillStyle = `rgba(130, 150, 180, ${aStr})`;

        // Horizontal bar (always — this is the − component)
        ctx.fillRect(cx - halfLenH, cy - barThick / 2, halfLenH * 2, barThick);

        // Vertical bar (discrete: either fully there or not)
        if (showPlus) {
          ctx.fillRect(cx - barThick / 2, cy - halfLenV, barThick, halfLenV * 2);
        }
      }
    }
  }
}

/**
 * Animation loop.
 */
function animate() {
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastTime, 0.1);
  lastTime = now;

  if (currentMode === '__hybrid') {
    // L1: quantum walk steps
    const stepsPerFrame = 8;
    for (let i = 0; i < stepsPerFrame; i++) {
      qw.step();
    }

    // L2: feed wave density into tile pPlus (L1 → L2 coupling)
    const density = qw.getDensityForDisplay();
    const cellsPerTileX = Math.max(1, Math.floor(cols / TILE_COLS));
    const cellsPerTileY = Math.max(1, Math.floor(rows / TILE_ROWS));
    for (let ty = 0; ty < TILE_ROWS; ty++) {
      for (let tx = 0; tx < TILE_COLS; tx++) {
        const tileIdx = ty * TILE_COLS + tx;
        if (tileSystem.collapsed[tileIdx] !== 0) continue;
        // Average wave density over tile's cells
        let sum = 0, count = 0;
        const startC = tx * cellsPerTileX;
        const startR = ty * cellsPerTileY;
        for (let dr = 0; dr < cellsPerTileY && (startR + dr) < rows; dr++) {
          for (let dc = 0; dc < cellsPerTileX && (startC + dc) < cols; dc++) {
            sum += density[(startR + dr) * cols + (startC + dc)];
            count++;
          }
        }
        const avgDensity = count > 0 ? sum / count : 0.5;
        // Update tile brightness → pPlus tracks wave pattern
        tileSystem.brightness[tileIdx] = 1.0 - avgDensity;
        tileSystem._initTileFromBrightness(tileIdx, tileSystem.brightness[tileIdx]);
      }
    }

    // L2: tile system evolution + measurement
    tileSystem.evolve(dt);
    tileSystem.reqantize(dt);

    // Measurement from all gaze points (multi-person)
    if (gazePresent && tileSystem) {
      for (const gp of gazePoints) {
        const tileCX = gp.x * TILE_COLS;
        const tileCY = gp.y * TILE_ROWS;
        tileSystem.applyGazeMeasurement(tileCX, tileCY, GAZE_SIGMA, 0.3);
      }
    }

    // Snapshot per-cell outcomes using current pattern image
    for (let ty = 0; ty < TILE_ROWS; ty++) {
      for (let tx = 0; tx < TILE_COLS; tx++) {
        const tileIdx = ty * TILE_COLS + tx;
        const startC = tx * cellsPerTileX;
        const startR = ty * cellsPerTileY;

        if (tileSystem.collapsed[tileIdx] !== 0) {
          // Tile collapsed — snapshot cells from pattern image
          for (let dr = 0; dr < cellsPerTileY && (startR + dr) < rows; dr++) {
            for (let dc = 0; dc < cellsPerTileX && (startC + dc) < cols; dc++) {
              const ci = (startR + dr) * cols + (startC + dc);
              if (cellOutcome[ci] === 0) {
                const isPlus = getCurrentPatternAt(startC + dc, startR + dr);
                cellOutcome[ci] = isPlus ? 1 : 2;
              }
            }
          }
        } else {
          // Superposition — clear stale outcomes
          for (let dr = 0; dr < cellsPerTileY && (startR + dr) < rows; dr++) {
            for (let dc = 0; dc < cellsPerTileX && (startC + dc) < cols; dc++) {
              cellOutcome[(startR + dr) * cols + (startC + dc)] = 0;
            }
          }
        }
      }
    }

    // Render
    if (useWebGL && currentMode === '__hybrid') {
      const gammaSlider = document.getElementById('gamma-slider');
      const gamma = gammaSlider ? parseFloat(gammaSlider.value) : 0.5;

      glRenderer.buildInstances({
        cols, rows, cellW, cellH,
        density, cellOutcome, tileSystem,
        tileCols: TILE_COLS, tileRows: TILE_ROWS,
        gamma,
        time: performance.now(),
      });
      glRenderer.render(canvas.width, canvas.height, scaledFont, cellW, cellH);
    } else {
      renderHybrid(density);
    }

  } else if (currentMode.startsWith('__qw:')) {
    const stepsPerFrame = 8;
    for (let i = 0; i < stepsPerFrame; i++) {
      qw.step();
    }
    const density = qw.getDensityForDisplay();
    renderDensity(density, false);

  } else if (currentMode.startsWith('__proc:')) {
    procTime += 0.03;
    let density;
    if (currentMode === '__proc:ripple') {
      density = generateProceduralRipple(cols, rows, procTime);
      renderDensity(density, true);
    } else if (currentMode === '__proc:reaction') {
      density = generateReactionDiffusion(cols, rows, procTime);
      renderDensity(density, true);
    }
  }

  animId = requestAnimationFrame(animate);
}

init();
