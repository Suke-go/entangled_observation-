/**
 * measurement.js — Mouse-based pseudo-measurement with Gaussian collapse.
 *
 * Simulates quantum measurement triggered by the observer (mouse cursor).
 *   - Tiles near the cursor collapse probabilistically (pPlus determines outcome).
 *   - Gaussian weight: w_i = exp(-d²/2σ²)
 *   - Tiles that are no longer observed gradually reqantize back to superposition.
 */

import { resetToSuperposition } from './halftone.js';

/* ── Configuration ── */
export const MEASUREMENT_CONFIG = {
  gazeSigma:            4.0,    // Gaussian spread in tile units
  minThreshold:         0.05,   // Minimum strength to trigger measurement
  reqantizationDelay:   3.0,    // Seconds before reqantization begins
  reqantizationSpeed:   0.5,    // Blend speed (per second) back to superposition
};

/**
 * Process a mouse/gaze position and apply measurements to tiles.
 * @param {TileState[]} tiles
 * @param {number} tileCols
 * @param {number} tileRows
 * @param {number} mouseTileX    Mouse position in tile coords (fractional)
 * @param {number} mouseTileY
 * @param {boolean} mousePresent Whether the mouse is over the canvas
 */
export function applyMeasurement(tiles, tileCols, tileRows, mouseTileX, mouseTileY, mousePresent) {
  const sigma = MEASUREMENT_CONFIG.gazeSigma;
  const sigma2x2 = 2 * sigma * sigma;
  const minT = MEASUREMENT_CONFIG.minThreshold;

  for (let ty = 0; ty < tileRows; ty++) {
    for (let tx = 0; tx < tileCols; tx++) {
      const idx = ty * tileCols + tx;
      const tile = tiles[idx];

      if (!mousePresent) continue;

      const dx = tx - mouseTileX;
      const dy = ty - mouseTileY;
      const dist2 = dx * dx + dy * dy;
      const strength = Math.exp(-dist2 / sigma2x2);

      if (strength > minT) {
        // "Observe" this tile
        tile.reqantTimer = 0; // reset reqantization clock

        if (!tile.measured && Math.random() < strength * 0.15) {
          // Probabilistic collapse: outcome determined by pPlus
          tile.measured = true;
          tile.measuredValue = (Math.random() < tile.pPlus) ? '+' : '−';
          tile.coherence = 0;
        }
      }
    }
  }
}

/**
 * Update reqantization timers and gradually return unobserved tiles to superposition.
 * @param {TileState[]} tiles
 * @param {number} tileCols
 * @param {number} tileRows
 * @param {number} mouseTileX
 * @param {number} mouseTileY
 * @param {boolean} mousePresent
 * @param {number} dt              Frame delta time in seconds
 */
export function updateRequantization(tiles, tileCols, tileRows, mouseTileX, mouseTileY, mousePresent, dt) {
  const sigma = MEASUREMENT_CONFIG.gazeSigma;
  const sigma2x2 = 2 * sigma * sigma;
  const minT = MEASUREMENT_CONFIG.minThreshold;
  const delay = MEASUREMENT_CONFIG.reqantizationDelay;
  const speed = MEASUREMENT_CONFIG.reqantizationSpeed;

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!tile.measured) continue;

    // Check if mouse is near this tile
    const tx = i % tileCols;
    const ty = Math.floor(i / tileCols);
    let beingWatched = false;

    if (mousePresent) {
      const dx = tx - mouseTileX;
      const dy = ty - mouseTileY;
      const dist2 = dx * dx + dy * dy;
      const strength = Math.exp(-dist2 / sigma2x2);
      beingWatched = strength > minT;
    }

    if (beingWatched) {
      tile.reqantTimer = 0;
    } else {
      tile.reqantTimer += dt;
      if (tile.reqantTimer > delay) {
        // Gradually return to superposition
        resetToSuperposition(tile);
      }
    }
  }
}
