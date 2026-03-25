/**
 * grid.js — Canvas 2D grid renderer for +/- halftone display.
 *
 * Halftone uses THREE visual states for maximum contrast:
 *   '+' (cross) — most ink — represents dark areas
 *   '−' (dash)  — medium ink — represents mid-tone areas
 *   ' ' (blank) — no ink    — represents bright areas
 *
 * From a distance, the density of characters creates a grayscale image.
 * The blank cells are critical: "presence vs absence of character" creates
 * far stronger perceptual contrast than "which character is shown".
 *
 * Each cell is assigned stochastically based on pPlus:
 *   pPlus ≈ 1.0 → almost always '+'  (dark)
 *   pPlus ≈ 0.5 → mix of '+', '−', some blanks (mid)
 *   pPlus ≈ 0.0 → mostly blank, rare '−' (bright)
 */

const BG_COLOR = '#0a0a0c';

/**
 * Calculate grid dimensions.
 */
export function calcGridDimensions(canvasW, canvasH, fontSize) {
  const cellW = Math.ceil(fontSize * 0.6);
  const cellH = Math.ceil(fontSize * 1.1);
  const cols = Math.floor(canvasW / cellW);
  const rows = Math.floor(canvasH / cellH);
  return { cellW, cellH, cols, rows };
}

/**
 * Pre-render '+' and '−' glyph bitmaps.
 */
export function createGlyphCache(cellW, cellH, fontSize) {
  const font = `${fontSize}px 'IBM Plex Mono', 'Source Code Pro', 'Consolas', monospace`;
  const cache = {};

  for (const [key, ch] of [['plus', '+'], ['minus', '–']]) {
    const c = new OffscreenCanvas(cellW, cellH);
    const cCtx = c.getContext('2d');
    cCtx.font = font;
    cCtx.textAlign = 'center';
    cCtx.textBaseline = 'middle';
    cCtx.fillStyle = '#ffffff';
    cCtx.fillText(ch, cellW / 2, cellH / 2);
    cache[key] = c;
  }

  return cache;
}

/**
 * Cell assignment values:
 *   0 = blank (no character)
 *   1 = '−'
 *   2 = '+'
 */
export function createCellAssignments(totalCells) {
  return new Uint8Array(totalCells);
}

/**
 * Assign each cell to blank / '−' / '+' based on tile pPlus.
 *
 * Mapping (pPlus → character distribution):
 *   pPlus = 1.0: 100% '+', 0% '−', 0% blank  → darkest
 *   pPlus = 0.7:  60% '+', 30% '−', 10% blank
 *   pPlus = 0.5:  30% '+', 35% '−', 35% blank → mid-tone
 *   pPlus = 0.3:  10% '+', 25% '−', 65% blank
 *   pPlus = 0.0:   0% '+', 0% '−', 100% blank → brightest (empty)
 */
export function refreshCellAssignments(assignments, tileStates, tileCols, tileRows, cols, rows) {
  const cellsPerTileX = Math.max(1, Math.floor(cols / tileCols));
  const cellsPerTileY = Math.max(1, Math.floor(rows / tileRows));

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const tx = Math.min(tileCols - 1, Math.floor(cx / cellsPerTileX));
      const ty = Math.min(tileRows - 1, Math.floor(cy / cellsPerTileY));
      const tileIdx = ty * tileCols + tx;
      const tile = tileStates[tileIdx];
      if (!tile) continue;

      const cellIdx = cy * cols + cx;

      if (tile.measured) {
        // Measured tiles: fixed character
        assignments[cellIdx] = (tile.measuredValue === '+') ? 2 : 1;
      } else {
        // Unmeasured: stochastic 3-way assignment
        const p = tile.pPlus;

        // Probability of '+': steep curve, mostly '+' when p > 0.5
        const pChar = p * p;  // e.g. p=0.7 → 0.49, p=1.0 → 1.0, p=0.3 → 0.09
        // Probability of '−': peaks at mid-tones
        const pMinus = 2 * p * (1 - p); // e.g. p=0.5 → 0.5, p=0.7 → 0.42, p=0.3 → 0.42
        // Remaining probability is blank
        // pBlank = 1 - pChar - pMinus = (1-p)²

        const roll = Math.random();
        if (roll < pChar) {
          assignments[cellIdx] = 2; // '+'
        } else if (roll < pChar + pMinus) {
          assignments[cellIdx] = 1; // '−'
        } else {
          assignments[cellIdx] = 0; // blank
        }
      }
    }
  }
}

/**
 * Draw the full grid.
 */
export function drawGrid(ctx, glyphCache, tileStates, tileCols, tileRows, cols, rows, cellW, cellH, time, cellAssignments) {
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;

  // Clear
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, canvasW, canvasH);

  const cellsPerTileX = Math.max(1, Math.floor(cols / tileCols));
  const cellsPerTileY = Math.max(1, Math.floor(rows / tileRows));

  const plusGlyph = glyphCache['plus'];
  const minusGlyph = glyphCache['minus'];

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const cellIdx = cy * cols + cx;
      const val = cellAssignments[cellIdx];
      if (val === 0) continue; // blank — skip entirely

      const tx = Math.min(tileCols - 1, Math.floor(cx / cellsPerTileX));
      const ty = Math.min(tileRows - 1, Math.floor(cy / cellsPerTileY));
      const tileIdx = ty * tileCols + tx;
      const tile = tileStates[tileIdx];
      if (!tile) continue;

      const glyph = (val === 2) ? plusGlyph : minusGlyph;
      const x = cx * cellW;
      const y = cy * cellH;

      if (tile.measured) {
        // Measured: full brightness
        ctx.globalAlpha = 1.0;
        ctx.drawImage(glyph, x, y);
      } else {
        // Unmeasured: dimmer with coherence flicker
        let alpha = 0.5;
        if (tile.coherence > 0.1) {
          const phase = (tx * 7.31 + ty * 13.17);
          alpha = 0.4 + 0.3 * Math.sin(time * 5.5 + phase) * tile.coherence;
        }
        ctx.globalAlpha = alpha;
        ctx.drawImage(glyph, x, y);
      }
    }
  }

  ctx.globalAlpha = 1.0;
}
