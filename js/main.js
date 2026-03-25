/**
 * main.js — Entry point for ±Quantum Halftone Prototype
 *
 * Orchestrates: image loading → halftone state init → render loop + mouse measurement
 */

import { loadAndProcess } from './image-loader.js';
import { initTileStates } from './halftone.js';
import { calcGridDimensions, createGlyphCache, createCellAssignments, refreshCellAssignments, drawGrid } from './grid.js';
import { applyMeasurement, updateRequantization } from './measurement.js';

/* ── Configuration ── */
const FONT_SIZE  = 12;   // px
const TILE_COLS  = 80;   // tile grid columns
const TILE_ROWS  = 50;   // tile grid rows
const REFRESH_INTERVAL = 0.12; // seconds between stochastic re-rolls (superposition flicker)

const DEFAULT_IMAGE = 'pic/lukasz-szmigiel-2ShvY8Lf6l0-unsplash.jpg';

/* ── State ── */
let canvas, ctx;
let gridCols, gridRows, cellW, cellH;
let glyphCache = null;
let cellAssignments = null;
let tileStates = null;
let mouseX = -1, mouseY = -1;
let mousePresent = false;
let lastTime = 0;
let lastRefresh = 0;

/* ── Initialization ── */
async function init() {
  canvas = document.getElementById('grid-canvas');
  ctx = canvas.getContext('2d');

  resizeCanvas();
  window.addEventListener('resize', () => {
    resizeCanvas();
  });

  // Mouse tracking (cursor = gaze proxy)
  canvas.addEventListener('mousemove', (e) => {
    mouseX = e.clientX * devicePixelRatio;
    mouseY = e.clientY * devicePixelRatio;
    mousePresent = true;
  });
  canvas.addEventListener('mouseleave', () => {
    mousePresent = false;
  });
  canvas.addEventListener('mouseenter', () => {
    mousePresent = true;
  });

  // UI controls
  setupUI();

  // Load default image
  await loadImageAndInit(DEFAULT_IMAGE);

  // Start render loop
  lastTime = performance.now() / 1000;
  requestAnimationFrame(renderLoop);
}

function resizeCanvas() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';

  const scaledFontSize = FONT_SIZE * devicePixelRatio;
  const dims = calcGridDimensions(canvas.width, canvas.height, scaledFontSize);
  gridCols = dims.cols;
  gridRows = dims.rows;
  cellW = dims.cellW;
  cellH = dims.cellH;

  // Re-create caches
  glyphCache = createGlyphCache(cellW, cellH, scaledFontSize);
  cellAssignments = createCellAssignments(gridCols * gridRows);
}

async function loadImageAndInit(src) {
  try {
    const brightness = await loadAndProcess(src, TILE_COLS, TILE_ROWS);
    tileStates = initTileStates(brightness, TILE_COLS, TILE_ROWS);
    // Initial assignment
    if (cellAssignments) {
      refreshCellAssignments(cellAssignments, tileStates, TILE_COLS, TILE_ROWS, gridCols, gridRows);
    }
  } catch (e) {
    console.error('Image load failed:', e);
  }
}

/* ── Render Loop ── */
function renderLoop(timestamp) {
  const now = timestamp / 1000;
  const dt = Math.min(now - lastTime, 0.1);
  lastTime = now;

  if (tileStates && glyphCache && cellAssignments) {
    // Mouse position in tile coordinates
    const cellsPerTileX = Math.max(1, Math.floor(gridCols / TILE_COLS));
    const cellsPerTileY = Math.max(1, Math.floor(gridRows / TILE_ROWS));
    const mouseTileX = mouseX / (cellW * cellsPerTileX);
    const mouseTileY = mouseY / (cellH * cellsPerTileY);

    // Measurement
    applyMeasurement(tileStates, TILE_COLS, TILE_ROWS, mouseTileX, mouseTileY, mousePresent);

    // Reqantization
    updateRequantization(tileStates, TILE_COLS, TILE_ROWS, mouseTileX, mouseTileY, mousePresent, dt);

    // Periodically re-roll unmeasured cell assignments (to create flicker)
    if (now - lastRefresh > REFRESH_INTERVAL) {
      refreshCellAssignments(cellAssignments, tileStates, TILE_COLS, TILE_ROWS, gridCols, gridRows);
      lastRefresh = now;
    }

    // Draw
    drawGrid(ctx, glyphCache, tileStates, TILE_COLS, TILE_ROWS, gridCols, gridRows, cellW, cellH, now, cellAssignments);
  }

  requestAnimationFrame(renderLoop);
}

/* ── UI ── */
function setupUI() {
  const select = document.getElementById('image-select');
  select.addEventListener('change', async (e) => {
    await loadImageAndInit(e.target.value);
  });

  const btnToggle = document.getElementById('btn-toggle-ui');
  const controls = document.getElementById('controls');
  const infoBar = document.getElementById('info-bar');

  btnToggle.addEventListener('click', () => {
    controls.classList.add('hidden');
    infoBar.classList.add('hidden');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') {
      controls.classList.toggle('hidden');
      infoBar.classList.toggle('hidden');
    }
  });
}

// Boot
init();
