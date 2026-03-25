/**
 * quantum-tile.js — Tile-based quantum circuit engine (Layer 2).
 *
 * Each tile holds a k-qubit state vector (Complex[2^k]).
 * Implements: Hadamard, CNOT, projective measurement, POVM,
 * re-quantization, and A-B entanglement.
 *
 * Design: SPEC.md §4, QUANTUM_WALK.md §2
 *
 * For k=2 qubits per tile:
 *   State vector has 4 complex amplitudes:
 *     |00⟩, |01⟩, |10⟩, |11⟩
 *
 * Qubit 0: the "display qubit" — ⟨0|ρ|0⟩ = p_plus
 * Qubit 1: auxiliary qubit for entanglement / richer dynamics
 */

// ─── Complex number helpers ─────────────────────────────────────

/**
 * State vector: interleaved [re0, im0, re1, im1, ...] for 2^k amplitudes.
 * For k=2: length=8 (4 complex numbers × 2 floats).
 */
function createStateVector(k) {
  const sv = new Float64Array(2 * (1 << k));
  sv[0] = 1.0; // |00...0⟩
  return sv;
}

function copyStateVector(sv) {
  return new Float64Array(sv);
}

/** Norm² of state vector (should be ~1.0). */
function norm2(sv) {
  let n = 0;
  for (let i = 0; i < sv.length; i += 2) {
    n += sv[i] * sv[i] + sv[i + 1] * sv[i + 1];
  }
  return n;
}

/** Normalize state vector to unit norm. */
function normalize(sv) {
  const n = Math.sqrt(norm2(sv));
  if (n < 1e-15) return;
  const inv = 1.0 / n;
  for (let i = 0; i < sv.length; i++) {
    sv[i] *= inv;
  }
}

// ─── Single-qubit gates ─────────────────────────────────────────

/**
 * Apply a single-qubit gate U to qubit `target` in state vector `sv`.
 * U is [u00re, u00im, u01re, u01im, u10re, u10im, u11re, u11im].
 *
 * For k qubits, the state has 2^k amplitudes.
 * We iterate over pairs of amplitudes that differ only in bit `target`.
 */
function applySingleQubitGate(sv, k, target, U) {
  const dim = 1 << k;
  const step = 1 << target;

  for (let i = 0; i < dim; i++) {
    if (i & step) continue; // skip partner indices

    const j = i | step;
    const iRe = sv[2 * i], iIm = sv[2 * i + 1];
    const jRe = sv[2 * j], jIm = sv[2 * j + 1];

    // U[0,0] * |i⟩ + U[0,1] * |j⟩
    sv[2 * i]     = U[0] * iRe - U[1] * iIm + U[2] * jRe - U[3] * jIm;
    sv[2 * i + 1] = U[0] * iIm + U[1] * iRe + U[2] * jIm + U[3] * jRe;

    // U[1,0] * |i⟩ + U[1,1] * |j⟩
    sv[2 * j]     = U[4] * iRe - U[5] * iIm + U[6] * jRe - U[7] * jIm;
    sv[2 * j + 1] = U[4] * iIm + U[5] * iRe + U[6] * jIm + U[7] * jRe;
  }
}

/** Hadamard gate matrix: (1/√2)[[1,1],[1,-1]] */
const SQRT2_INV = 1.0 / Math.sqrt(2);
const HADAMARD = new Float64Array([
  SQRT2_INV, 0, SQRT2_INV, 0,   // row 0: [1/√2, 1/√2]
  SQRT2_INV, 0, -SQRT2_INV, 0,  // row 1: [1/√2, -1/√2]
]);

/** Pauli-X gate: [[0,1],[1,0]] */
const PAULI_X = new Float64Array([
  0, 0, 1, 0,
  1, 0, 0, 0,
]);

/**
 * Apply Hadamard to qubit `target`.
 * H|0⟩ = |+⟩ = (|0⟩+|1⟩)/√2
 * H|1⟩ = |−⟩ = (|0⟩−|1⟩)/√2
 */
function hadamard(sv, k, target) {
  applySingleQubitGate(sv, k, target, HADAMARD);
}

// ─── Two-qubit gates ────────────────────────────────────────────

/**
 * Apply CNOT with `control` and `target` qubits.
 * If control=|1⟩, flip target.
 */
function cnot(sv, k, control, target) {
  const dim = 1 << k;
  const controlBit = 1 << control;
  const targetBit = 1 << target;

  for (let i = 0; i < dim; i++) {
    // Only act when control bit is set AND target bit is 0
    if ((i & controlBit) && !(i & targetBit)) {
      const j = i | targetBit;
      // Swap amplitudes of |i⟩ and |j⟩
      const tmpRe = sv[2 * i], tmpIm = sv[2 * i + 1];
      sv[2 * i] = sv[2 * j];
      sv[2 * i + 1] = sv[2 * j + 1];
      sv[2 * j] = tmpRe;
      sv[2 * j + 1] = tmpIm;
    }
  }
}

// ─── Measurement ────────────────────────────────────────────────

/**
 * Compute probability of measuring qubit `target` as |0⟩.
 */
function prob0(sv, k, target) {
  const dim = 1 << k;
  const bit = 1 << target;
  let p = 0;
  for (let i = 0; i < dim; i++) {
    if (!(i & bit)) {
      p += sv[2 * i] * sv[2 * i] + sv[2 * i + 1] * sv[2 * i + 1];
    }
  }
  return p;
}

/**
 * Projective measurement on qubit `target`.
 * Collapses state vector. Returns 0 or 1.
 */
function measure(sv, k, target) {
  const p0 = prob0(sv, k, target);
  const outcome = (Math.random() < p0) ? 0 : 1;
  projectAndNormalize(sv, k, target, outcome);
  return outcome;
}

/**
 * Project state vector onto |outcome⟩ for qubit `target`,
 * then renormalize.
 */
function projectAndNormalize(sv, k, target, outcome) {
  const dim = 1 << k;
  const bit = 1 << target;

  // Zero out amplitudes inconsistent with outcome
  for (let i = 0; i < dim; i++) {
    const qubitVal = (i & bit) ? 1 : 0;
    if (qubitVal !== outcome) {
      sv[2 * i] = 0;
      sv[2 * i + 1] = 0;
    }
  }

  normalize(sv);
}

/**
 * Partial (weak) measurement — POVM.
 * Blends between no measurement and full projection.
 *
 * strength ∈ [0, 1]:
 *   0 = no measurement
 *   1 = full projective measurement
 *
 * Implementation: Kraus operators
 *   M_0 = √(1-s) · I + √s · |0⟩⟨0|
 *   → Simplified: interpolate between current state and projected state
 */
function weakMeasure(sv, k, target, strength) {
  if (strength <= 0) return -1;
  if (strength >= 1) return measure(sv, k, target);

  // Decide outcome probabilistically
  const p0 = prob0(sv, k, target);
  const outcome = (Math.random() < p0) ? 0 : 1;

  // Should we collapse?
  if (Math.random() > strength) return -1; // no collapse

  // Create projected state
  const projected = copyStateVector(sv);
  projectAndNormalize(projected, k, target, outcome);

  // Blend: sv = √(1-s) · sv + √s · projected
  const a = Math.sqrt(1 - strength);
  const b = Math.sqrt(strength);
  for (let i = 0; i < sv.length; i++) {
    sv[i] = a * sv[i] + b * projected[i];
  }
  normalize(sv);

  return outcome;
}

// ─── Observables ────────────────────────────────────────────────

/**
 * Get ⟨+|ρ|+⟩ for qubit `target` — probability of measuring +.
 * For our convention: + = |0⟩, − = |1⟩ (Pauli-Z eigenstates).
 */
function pPlus(sv, k, target) {
  return prob0(sv, k, target);
}

/**
 * Get coherence |⟨+|ρ|−⟩| for qubit `target`.
 * This is the off-diagonal element of the reduced density matrix.
 */
function coherence(sv, k, target) {
  const dim = 1 << k;
  const bit = 1 << target;

  // ρ_{01} = Σ_{other bits} α_{i with target=0} · conj(α_{i with target=1})
  let rhoRe = 0, rhoIm = 0;

  for (let i = 0; i < dim; i++) {
    if (i & bit) continue; // only iterate over target=0 states
    const j = i | bit;     // corresponding target=1 state

    const aRe = sv[2 * i], aIm = sv[2 * i + 1];     // α_{target=0}
    const bRe = sv[2 * j], bIm = sv[2 * j + 1];     // α_{target=1}

    // α · conj(β) = (aRe + i·aIm)(bRe - i·bIm)
    rhoRe += aRe * bRe + aIm * bIm;
    rhoIm += aIm * bRe - aRe * bIm;
  }

  return Math.sqrt(rhoRe * rhoRe + rhoIm * rhoIm);
}

// ─── QuantumTileSystem ──────────────────────────────────────────

/**
 * Tile-based quantum system managing 2D grid of k-qubit tiles.
 * Each tile has an independent state vector.
 * A-B entanglement is handled through joint measurement operations.
 */
export class QuantumTileSystem {
  /**
   * @param {number} tileCols  Tile grid columns
   * @param {number} tileRows  Tile grid rows
   * @param {number} k         Qubits per tile (default 2)
   */
  constructor(tileCols, tileRows, k = 2) {
    this.tileCols = tileCols;
    this.tileRows = tileRows;
    this.k = k;
    this.numTiles = tileCols * tileRows;

    // State vectors for all tiles
    this.states = new Array(this.numTiles);
    for (let i = 0; i < this.numTiles; i++) {
      this.states[i] = createStateVector(k);
    }

    // Measurement state tracking
    this.collapsed = new Uint8Array(this.numTiles);   // 0=superposition, 1='+', 2='−'
    this.collapseTime = new Float64Array(this.numTiles);
    this.fadeProgress = new Float32Array(this.numTiles); // 0=fully collapsed, 1=fully superposition

    // Image brightness per tile (drives pPlus bias)
    // brightness=0 → pPlus≈1 → + → dark;  brightness=1 → pPlus≈0 → − → light
    this.brightness = new Float32Array(this.numTiles);
    this.brightness.fill(0.5);  // default: unbiased

    // Time
    this.time = 0;

    // Partner system (for A-B entanglement)
    this.partner = null;
    this.entanglementStrength = 0.5;

    // Re-quantization delay and fade duration
    this.reqantDelay = 3.0;
    this.fadeOutDuration = 1.5;  // seconds to fade from collapsed → superposition

    // Callback for collapse events (used by entanglement client)
    // Signature: (tileIdx, outcome) => void    outcome: 0='+', 1='−'
    this.onCollapse = null;

    // Initialize all tiles in superposition: H|0⟩ = |+⟩
    this.initSuperposition();
  }

  /**
   * Initialize all tiles to superposition state.
   * Qubit 0 → |+⟩ (equal probability of + and −)
   * Qubit 1 → |0⟩ (auxiliary)
   */
  initSuperposition() {
    for (let i = 0; i < this.numTiles; i++) {
      this._initTileFromBrightness(i, this.brightness[i]);
      this.collapsed[i] = 0;
    }
  }

  /**
   * Initialize tile states from a brightness map (SPEC.md §3.2).
   *
   * brightness = 0.0 (black) → |+⟩  → pPlus = 1.0 → dense + → appears dark
   * brightness = 1.0 (white) → |−⟩  → pPlus = 0.0 → only − → appears light
   * brightness = 0.5          → equal superposition → maximum flickering
   *
   * @param {Float32Array} brightnessMap  [0,1] values, row-major, length = numTiles
   */
  initFromBrightness(brightnessMap) {
    for (let i = 0; i < this.numTiles; i++) {
      this.brightness[i] = brightnessMap[i] || 0.5;
      this._initTileFromBrightness(i, this.brightness[i]);
      this.collapsed[i] = 0;
      this.fadeProgress[i] = 1.0;
    }
    console.log(`[tiles] Initialized from brightness map (${this.numTiles} tiles)`);
  }

  /**
   * Set a single tile's state vector from brightness.
   * α = cos(b × π/2),  β = sin(b × π/2)
   * |ψ⟩ = α|0⟩ + β|1⟩  →  pPlus = α² = cos²(b × π/2)
   */
  _initTileFromBrightness(idx, b) {
    const sv = createStateVector(this.k);
    const alpha = Math.cos(b * Math.PI / 2);
    const beta  = Math.sin(b * Math.PI / 2);
    // Qubit 0: α|0⟩ + β|1⟩ (others stay |0⟩)
    sv[0] = alpha;  // |00⟩ real
    sv[1] = 0;      // |00⟩ imag
    const bit0 = 1 << 0;
    sv[2 * bit0] = beta;   // |01⟩ real (qubit 0 = 1)
    sv[2 * bit0 + 1] = 0;  // |01⟩ imag
    this.states[idx] = sv;
  }

  /**
   * Link to partner system for entanglement.
   */
  setPartner(partner) {
    this.partner = partner;
    partner.partner = this;
  }

  /**
   * Get p_plus for tile at (tx, ty).
   * p_plus = probability of qubit 0 being |0⟩ = +.
   */
  getPPlus(tx, ty) {
    const idx = ty * this.tileCols + tx;
    if (this.collapsed[idx] === 1) return 1.0;  // collapsed to +
    if (this.collapsed[idx] === 2) return 0.0;  // collapsed to −
    return pPlus(this.states[idx], this.k, 0);
  }

  /**
   * Get coherence for tile at (tx, ty).
   */
  getCoherence(tx, ty) {
    const idx = ty * this.tileCols + tx;
    if (this.collapsed[idx] !== 0) return 0.0;  // collapsed = no coherence
    return coherence(this.states[idx], this.k, 0);
  }

  /**
   * Apply Gaussian measurement centered at (cx, cy) in tile coordinates.
   * 
   * @param {number} cx     Center x (tile coords, fractional)
   * @param {number} cy     Center y (tile coords, fractional)
   * @param {number} sigma  Gaussian spread (tile units)
   * @param {number} baseStrength  Maximum measurement strength at center
   */
  applyGazeMeasurement(cx, cy, sigma, baseStrength = 1.0) {
    const sigma2x2 = 2 * sigma * sigma;
    const minStrength = 0.05;

    // Scan tiles in the Gaussian radius
    const radius = Math.ceil(sigma * 3);
    const tx0 = Math.max(0, Math.floor(cx - radius));
    const tx1 = Math.min(this.tileCols - 1, Math.ceil(cx + radius));
    const ty0 = Math.max(0, Math.floor(cy - radius));
    const ty1 = Math.min(this.tileRows - 1, Math.ceil(cy + radius));

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const dx = tx - cx;
        const dy = ty - cy;
        const dist2 = dx * dx + dy * dy;
        const strength = baseStrength * Math.exp(-dist2 / sigma2x2);

        if (strength < minStrength) continue;

        const idx = ty * this.tileCols + tx;

        // Skip already collapsed tiles (Zeno effect: re-enforce collapse)
        if (this.collapsed[idx] !== 0) {
          this.collapseTime[idx] = this.time; // reset timer
          continue;
        }

        // Weak measurement (POVM)
        const outcome = weakMeasure(this.states[idx], this.k, 0, strength);

        if (outcome >= 0) {
          // Collapsed!
          this.collapsed[idx] = (outcome === 0) ? 1 : 2;  // 1='+', 2='−'
          this.collapseTime[idx] = this.time;
          this.fadeProgress[idx] = 0.0;

          // Notify external listener (entanglement client)
          if (this.onCollapse) {
            this.onCollapse(idx, outcome);
          }
        }
      }
    }
  }

  /**
   * Re-quantize tiles whose collapse has timed out.
   * Tiles return to superposition after reqantDelay seconds.
   * Uses gradual fade: fadeProgress goes 0→1 over fadeOutDuration.
   */
  reqantize(dt) {
    this.time += dt;

    for (let i = 0; i < this.numTiles; i++) {
      if (this.collapsed[i] === 0) {
        this.fadeProgress[i] = Math.min(1.0, this.fadeProgress[i] + dt * 2.0);
        continue;
      }

      const age = this.time - this.collapseTime[i];

      if (age > this.reqantDelay) {
        // Start fading
        const fadeAge = age - this.reqantDelay;
        this.fadeProgress[i] = Math.min(1.0, fadeAge / this.fadeOutDuration);

        if (this.fadeProgress[i] >= 1.0) {
          // Fully faded — return to image-biased superposition
          this._initTileFromBrightness(i, this.brightness[i]);
          this.collapsed[i] = 0;
        }
      } else {
        this.fadeProgress[i] = 0.0;  // fully collapsed
      }
    }
  }

  /**
   * Apply unitary evolution to uncollapsed tiles.
   * This creates subtle dynamics in the quantum state.
   *
   * For each uncollapsed tile:
   *   - Apply slight rotation on qubit 1 (phase evolution)
   *   - Occasionally apply CNOT between qubits (internal entanglement)
   */
  evolve(dt) {
    // Phase rotation angle per step
    const theta = 0.1 * dt;

    for (let i = 0; i < this.numTiles; i++) {
      if (this.collapsed[i] !== 0) continue;

      const sv = this.states[i];

      // Slight rotation on qubit 1 (creates phase dynamics)
      if (this.k >= 2) {
        // Rz(θ) on qubit 1: phase shift
        const bit = 1 << 1;
        const dim = 1 << this.k;
        for (let j = 0; j < dim; j++) {
          if (j & bit) {
            // |...1...⟩ component gets phase e^{-iθ}
            const re = sv[2 * j];
            const im = sv[2 * j + 1];
            sv[2 * j]     = re * Math.cos(theta) + im * Math.sin(theta);
            sv[2 * j + 1] = im * Math.cos(theta) - re * Math.sin(theta);
          }
        }
      }
    }
  }

  /**
   * Apply CNOT entanglement between neighboring tiles.
   * Simulates spatial entanglement spreading.
   * Uses density-matrix level approximation.
   */
  spreadEntanglement(probability = 0.01) {
    // Randomly select some neighboring pairs
    for (let ty = 0; ty < this.tileRows; ty++) {
      for (let tx = 0; tx < this.tileCols - 1; tx++) {
        if (Math.random() > probability) continue;

        const idx1 = ty * this.tileCols + tx;
        const idx2 = ty * this.tileCols + tx + 1;

        if (this.collapsed[idx1] !== 0 || this.collapsed[idx2] !== 0) continue;

        // Correlate the neighbors: blend their p_plus slightly
        const p1 = pPlus(this.states[idx1], this.k, 0);
        const p2 = pPlus(this.states[idx2], this.k, 0);
        const avg = (p1 + p2) * 0.5;

        // Push both towards average by applying conditional rotation
        // (This is an approximation of CNOT-mediated entanglement)
        if (p1 > avg + 0.01) {
          // Slightly rotate qubit 0 towards |1⟩
          const angle = 0.05;
          const RY = new Float64Array([
            Math.cos(angle), 0, -Math.sin(angle), 0,
            Math.sin(angle), 0, Math.cos(angle), 0,
          ]);
          applySingleQubitGate(this.states[idx1], this.k, 0, RY);
        }
      }
    }
  }

  /**
   * Get tile data array for rendering.
   * Returns { pPlus, coherence, collapsed } for each tile.
   */
  getTileData() {
    const data = new Array(this.numTiles);
    for (let i = 0; i < this.numTiles; i++) {
      const ty = Math.floor(i / this.tileCols);
      const tx = i % this.tileCols;
      data[i] = {
        pPlus: this.getPPlus(tx, ty),
        coherence: this.getCoherence(tx, ty),
        collapsed: this.collapsed[i],
      };
    }
    return data;
  }

  /**
   * Get compact Float32 arrays for efficient transfer.
   */
  getCompactState() {
    const pp = new Float32Array(this.numTiles);
    const co = new Float32Array(this.numTiles);
    for (let i = 0; i < this.numTiles; i++) {
      const ty = Math.floor(i / this.tileCols);
      const tx = i % this.tileCols;
      pp[i] = this.getPPlus(tx, ty);
      co[i] = this.getCoherence(tx, ty);
    }
    return { pPlus: pp, coherence: co, collapsed: this.collapsed };
  }
}
