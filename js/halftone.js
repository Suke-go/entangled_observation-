/**
 * halftone.js — Map brightness values to tile states (pPlus / coherence).
 *
 * DESIGN.md / SPEC.md mapping:
 *   brightness = 0.0 (black) → |+⟩ → pPlus = 1 → dense cross → appears dark
 *   brightness = 1.0 (white) → |−⟩ → pPlus = 0 → horizontal bar only → appears light
 *   brightness = 0.5          → max superposition → pPlus = 0.5
 *
 * α = cos(brightness × π/2)   → P(+) = cos²(b × π/2)
 * β = sin(brightness × π/2)   → P(−) = sin²(b × π/2)
 */

/**
 * @typedef {Object} TileState
 * @property {number}    pPlus       Probability of being '+' [0,1]
 * @property {number}    coherence   Quantum coherence |⟨+|ρ|−⟩| [0,1]
 * @property {boolean}   measured    Whether this tile has been measured
 * @property {string|null} measuredValue  '+' or '−' if measured
 * @property {number}    reqantTimer  Seconds since gaze left (for reqantization)
 */

/**
 * Initialize tile states from a brightness map.
 * @param {Float32Array} brightnessMap  [0,1] values, row-major
 * @param {number} tileCols
 * @param {number} tileRows
 * @returns {TileState[]}
 */
export function initTileStates(brightnessMap, tileCols, tileRows) {
  const states = new Array(tileCols * tileRows);
  for (let i = 0; i < states.length; i++) {
    const b = brightnessMap[i];
    states[i] = brightnessToState(b);
  }
  return states;
}

/**
 * Convert a brightness value to a tile state.
 * @param {number} b  Brightness [0,1]
 * @returns {TileState}
 */
export function brightnessToState(b) {
  const alpha = Math.cos(b * Math.PI / 2);
  const pPlus = alpha * alpha; // |α|²

  // Coherence: |⟨+|ρ|−⟩| = |α||β| for pure states
  const beta = Math.sin(b * Math.PI / 2);
  const coherence = Math.abs(alpha * beta);
  // Max coherence is 0.5 at b=0.5; normalize to [0,1]
  const coherenceNorm = coherence * 2;

  return {
    pPlus,
    coherence: coherenceNorm,
    measured: false,
    measuredValue: null,
    reqantTimer: 0,
    // Store original brightness for reqantization reset
    _brightness: b,
  };
}

/**
 * Reset a tile to its original superposition state.
 * @param {TileState} tile
 */
export function resetToSuperposition(tile) {
  const fresh = brightnessToState(tile._brightness);
  tile.pPlus = fresh.pPlus;
  tile.coherence = fresh.coherence;
  tile.measured = false;
  tile.measuredValue = null;
  tile.reqantTimer = 0;
}
