/**
 * quantum-walk.js — Discrete Schrödinger equation on a 2D lattice.
 *
 * Physics:
 *   i ∂ψ/∂t = H ψ
 *   H = -J Σ_{<i,j>} (|i⟩⟨j| + |j⟩⟨i|)  +  Σ_i V_i(t)|i⟩⟨i|
 *
 * The first term is nearest-neighbor hopping (kinetic energy).
 * The second term is an on-site potential — used as wave sources.
 *
 * |ψ(i,j)|² gives the probability density at each cell,
 * which maps directly to the +/− display density.
 */

export class QuantumWalk {
  /**
   * @param {number} cols  Grid columns
   * @param {number} rows  Grid rows
   * @param {object} opts  Options
   */
  constructor(cols, rows, opts = {}) {
    this.cols = cols;
    this.rows = rows;
    this.N = cols * rows;

    // Physical parameters
    this.J = opts.J ?? 0.5;       // hopping strength
    this.dt = opts.dt ?? 0.02;    // time step
    this.damping = opts.damping ?? 0.9995; // slight damping for visual stability

    // Wave function: real and imaginary parts
    this.psiRe = new Float32Array(this.N);
    this.psiIm = new Float32Array(this.N);

    // Potential field V_i(t)
    this.potential = new Float32Array(this.N);

    // Temporary buffers for time integration
    this._dRe = new Float32Array(this.N);
    this._dIm = new Float32Array(this.N);
    this._tmpRe = new Float32Array(this.N);
    this._tmpIm = new Float32Array(this.N);

    // Wave sources
    this.sources = [];

    // Time
    this.time = 0;
    this.stepCount = 0;

    // Initialize with EMPTY state (all zeros)
    // Sources will inject amplitude over time
    this.psiRe.fill(0);
    this.psiIm.fill(0);
  }

  /**
   * Add a wave source.
   * Sources continuously inject amplitude into the field,
   * creating propagating wavefronts.
   */
  addSource(x, y, freq, amp, phase = 0) {
    this.sources.push({ x: Math.round(x), y: Math.round(y), freq, amp, phase });
  }

  /**
   * Inject amplitude from sources directly into the wavefunction.
   * This is a "driving" approach — sources continuously emit waves.
   */
  driveFromSources() {
    for (const src of this.sources) {
      const idx = src.y * this.cols + src.x;
      if (idx >= 0 && idx < this.N) {
        // Inject as oscillating real+imaginary parts (rotating phasor)
        const phase = src.freq * this.time + src.phase;
        const injection = src.amp * this.dt;
        this.psiRe[idx] += injection * Math.cos(phase);
        this.psiIm[idx] += injection * Math.sin(phase);
      }
    }
  }

  /**
   * Compute H|ψ⟩ — the Hamiltonian applied to the wavefunction.
   *
   * (Hψ)_i = -J Σ_{j∈neighbors(i)} ψ_j  +  V_i · ψ_i
   *
   * Schrödinger: i dψ/dt = Hψ
   * So: dψ_Re/dt = +(Hψ)_Im,  dψ_Im/dt = -(Hψ)_Re
   */
  computeDerivative() {
    const { cols, rows, J, psiRe, psiIm, potential, _dRe, _dIm } = this;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;

        // Hopping: -J * sum of neighbors (periodic BCs)
        const up    = ((r > 0 ? r : rows) - 1) * cols + c;
        const down  = ((r + 1) % rows) * cols + c;
        const left  = r * cols + ((c > 0 ? c : cols) - 1);
        const right = r * cols + ((c + 1) % cols);

        const hopRe = psiRe[up] + psiRe[down] + psiRe[left] + psiRe[right];
        const hopIm = psiIm[up] + psiIm[down] + psiIm[left] + psiIm[right];

        // Hψ = -J·hop + V·ψ  (diagonal shift: -4J accounts for self-energy)
        const V = potential[idx];
        const HpsiRe = -J * (hopRe - 4 * psiRe[idx]) + V * psiRe[idx];
        const HpsiIm = -J * (hopIm - 4 * psiIm[idx]) + V * psiIm[idx];

        // i dψ/dt = Hψ  →  dRe = +HpsiIm,  dIm = -HpsiRe
        _dRe[idx] = HpsiIm;
        _dIm[idx] = -HpsiRe;
      }
    }
  }

  /**
   * One time step using RK2 (midpoint method) for better stability.
   */
  step() {
    const { psiRe, psiIm, _dRe, _dIm, _tmpRe, _tmpIm, dt, N, damping } = this;

    // Drive from sources
    this.driveFromSources();

    // --- RK2 Step ---
    // k1 = f(ψ)
    this.computeDerivative();
    for (let i = 0; i < N; i++) {
      _tmpRe[i] = psiRe[i] + _dRe[i] * dt * 0.5;
      _tmpIm[i] = psiIm[i] + _dIm[i] * dt * 0.5;
    }

    // Swap to midpoint for k2 computation
    const savedRe = new Float32Array(psiRe);
    const savedIm = new Float32Array(psiIm);
    psiRe.set(_tmpRe);
    psiIm.set(_tmpIm);

    // k2 = f(ψ + k1·dt/2)
    this.computeDerivative();

    // Final update: ψ += k2 * dt
    for (let i = 0; i < N; i++) {
      psiRe[i] = (savedRe[i] + _dRe[i] * dt) * damping;
      psiIm[i] = (savedIm[i] + _dIm[i] * dt) * damping;
    }

    this.time += dt;
    this.stepCount++;
  }

  /**
   * Get probability density |ψ(i,j)|² as Float32Array.
   */
  getProbabilityDensity() {
    const { psiRe, psiIm, N } = this;
    const prob = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      prob[i] = psiRe[i] * psiRe[i] + psiIm[i] * psiIm[i];
    }
    return prob;
  }

  /**
   * Get density normalized for display.
   * Uses adaptive normalization to maintain good visual contrast:
   *  - Finds the 95th percentile to avoid outliers from sources
   *  - Maps to [0, 1] with saturation at the percentile
   */
  getDensityForDisplay() {
    const prob = this.getProbabilityDensity();

    // Find good normalization value (95th percentile)
    const sorted = Float32Array.from(prob).sort();
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1e-10;
    const maxVal = Math.max(p95 * 2, 1e-10); // some headroom

    for (let i = 0; i < prob.length; i++) {
      prob[i] = Math.min(prob[i] / maxVal, 1.0);
    }
    return prob;
  }

  /**
   * Inject a localized Gaussian wave packet.
   * Used for mouse interaction (proto-measurement).
   */
  injectWavePacket(x, y, sigma = 2.0, amplitude = 0.3) {
    const { cols, rows, psiRe } = this;
    const r0 = Math.max(0, Math.floor(y - sigma * 3));
    const r1 = Math.min(rows - 1, Math.ceil(y + sigma * 3));
    const c0 = Math.max(0, Math.floor(x - sigma * 3));
    const c1 = Math.min(cols - 1, Math.ceil(x + sigma * 3));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dx = c - x;
        const dy = r - y;
        const g = amplitude * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        psiRe[r * cols + c] += g;
      }
    }
  }

  /**
   * Get the total norm² of the wavefunction (for debugging).
   */
  getNorm() {
    let n = 0;
    for (let i = 0; i < this.N; i++) {
      n += this.psiRe[i] ** 2 + this.psiIm[i] ** 2;
    }
    return n;
  }
}
