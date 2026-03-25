/**
 * collapse-patterns.js — Image-based patterns revealed by observation.
 *
 * Loads pre-generated B&W images (interference, eye, cat).
 * Each pattern is a brightness map at cell resolution.
 * Dark pixels → '+' (cross), light pixels → '−' (horizontal bar only).
 *
 * Patterns cycle automatically. When tiles collapse, cells look up
 * the current pattern's brightness to determine +/−.
 */

const PATTERN_FILES = [
  { name: 'interference', src: 'images/interference.png' },
  { name: 'eye',          src: 'images/eye.png' },
  { name: 'cat',          src: 'images/cat.png' },
];

// Each entry: { name, brightness: Float32Array(cols × rows) }
let loadedPatterns = [];
let currentPatternIdx = 0;
let patternCols = 0, patternRows = 0;

/**
 * Load all pattern images and create brightness maps at given resolution.
 * Call once after cols/rows are known.
 */
export async function loadPatterns(cols, rows) {
  patternCols = cols;
  patternRows = rows;
  loadedPatterns = [];

  for (const pf of PATTERN_FILES) {
    try {
      const brightness = await loadImageAsBrightness(pf.src, cols, rows);
      loadedPatterns.push({ name: pf.name, brightness });
      console.log(`[pattern] Loaded: ${pf.name} (${cols}×${rows})`);
    } catch (e) {
      console.warn(`[pattern] Failed to load ${pf.name}:`, e.message);
    }
  }

  if (loadedPatterns.length === 0) {
    // Fallback: generate simple vertical stripes
    const fb = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const stripe = Math.sin(c / cols * Math.PI * 12);
        fb[r * cols + c] = (stripe + 1) / 2;
      }
    }
    loadedPatterns.push({ name: 'fallback-stripes', brightness: fb });
  }

  currentPatternIdx = 0;
}

/**
 * Load an image and convert to brightness map at target resolution.
 * Returns Float32Array of [0,1] where 0=black, 1=white.
 */
function loadImageAsBrightness(src, targetCols, targetRows) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetCols;
      canvas.height = targetRows;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, targetCols, targetRows);
      const data = ctx.getImageData(0, 0, targetCols, targetRows).data;
      const brightness = new Float32Array(targetCols * targetRows);
      for (let i = 0; i < targetCols * targetRows; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        brightness[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      }
      resolve(brightness);
    };
    img.onerror = () => reject(new Error(`Cannot load ${src}`));
    img.src = src;
  });
}

/**
 * Look up the current pattern at cell (c, r).
 * Returns true for '+', false for '−'.
 * Dark pixel (brightness < 0.5) → '+' (more ink = darker mark).
 */
export function getCurrentPatternAt(c, r) {
  if (loadedPatterns.length === 0) return Math.random() < 0.5;
  const pat = loadedPatterns[currentPatternIdx];
  const idx = r * patternCols + c;
  if (idx < 0 || idx >= pat.brightness.length) return Math.random() < 0.5;
  const b = pat.brightness[idx];
  // Dark pixel → high probability of '+' (cross = denser ink = darker)
  // Light pixel → high probability of '−' (bar only = less ink = lighter)
  return Math.random() < (1.0 - b);
}

/** Get current pattern name. */
export function getCurrentPatternName() {
  if (loadedPatterns.length === 0) return 'none';
  return loadedPatterns[currentPatternIdx].name;
}

/** Cycle to next pattern. Returns new pattern name. */
export function nextPattern() {
  if (loadedPatterns.length === 0) return 'none';
  currentPatternIdx = (currentPatternIdx + 1) % loadedPatterns.length;
  return loadedPatterns[currentPatternIdx].name;
}

/** Set pattern by index. Used for role-based offset (A≠B). */
export function setPattern(idx) {
  if (loadedPatterns.length === 0) return;
  currentPatternIdx = idx % loadedPatterns.length;
}
