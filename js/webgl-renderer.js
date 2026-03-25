/**
 * webgl-renderer.js — WebGL2 instanced renderer for ±Quantum grid.
 *
 * Replaces Canvas 2D fillRect with a single instanced draw call.
 * Each cell = two instanced quads (H bar + V bar).
 * Per-instance data: position, showPlus, alpha, isCollapsed, flashIntensity.
 *
 * Performance: ~8.5K cells × 2 bars = ~17K instances → 1 draw call.
 * Canvas 2D fallback: returns null from init() if WebGL2 unavailable.
 */

// ── Shaders ──────────────────────────────────────────────────────

const VERT_SRC = `#version 300 es
precision highp float;

// Per-vertex: unit quad [0,1]×[0,1]
in vec2 a_vertPos;

// Per-instance
in vec2  a_cellPos;       // cell center in pixels
in float a_showPlus;      // 0.0 = H-bar only (−), 1.0 = both bars (+)
in float a_alpha;         // overall alpha
in float a_isCollapsed;   // 0.0 or 1.0
in float a_flash;         // flash intensity 0.0-1.0
in float a_barType;       // 0.0 = H bar, 1.0 = V bar

uniform vec2 u_resolution;   // canvas width, height
uniform float u_barThick;    // bar thickness in pixels
uniform float u_halfLenH;    // half-length of H bar
uniform float u_halfLenV;    // half-length of V bar

out float v_alpha;
out float v_isCollapsed;
out float v_flash;

void main() {
  // Skip V bar if showPlus = 0
  float skip = a_barType * (1.0 - a_showPlus);
  if (skip > 0.5) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);  // offscreen
    return;
  }

  // Bar geometry
  vec2 size;
  if (a_barType < 0.5) {
    // H bar: width = halfLenH*2, height = barThick
    size = vec2(u_halfLenH * 2.0, u_barThick);
  } else {
    // V bar: width = barThick, height = halfLenV*2
    size = vec2(u_barThick, u_halfLenV * 2.0);
  }

  // Position: center of cell ± half size
  vec2 pos = a_cellPos + (a_vertPos - 0.5) * size;

  // Convert pixel coords to clip space [-1, 1]
  vec2 clipPos = (pos / u_resolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y;  // flip Y

  gl_Position = vec4(clipPos, 0.0, 1.0);
  v_alpha = a_alpha;
  v_isCollapsed = a_isCollapsed;
  v_flash = a_flash;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in float v_alpha;
in float v_isCollapsed;
in float v_flash;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;

  vec3 color;
  float a = v_alpha;

  if (v_isCollapsed > 0.5) {
    // Collapsed: warm white
    color = vec3(0.90, 0.88, 0.82);

    // Flash overlay: bright white burst on fresh collapse
    color = mix(color, vec3(1.0, 0.98, 0.94), v_flash * 0.6);
    a = a + v_flash * 0.3;
  } else {
    // Superposition: blue-white gradient based on wave density (encoded in alpha)
    float brightness = v_alpha;
    color = vec3(
      0.50 + brightness * 0.45,
      0.55 + brightness * 0.42,
      0.65 + brightness * 0.35
    );
  }

  fragColor = vec4(color, min(1.0, a));
}
`;

// ── Renderer Class ───────────────────────────────────────────────

export class WebGLRenderer {

  constructor() {
    this.gl = null;
    this.program = null;
    this.vao = null;
    this.instanceBuffer = null;
    this.maxInstances = 0;
    this.instanceCount = 0;
    this.instanceData = null;

    // Uniform locations
    this.uRes = null;
    this.uBarThick = null;
    this.uHalfLenH = null;
    this.uHalfLenV = null;
  }

  /**
   * Initialize WebGL2 context and buffers.
   * Returns false if WebGL2 unavailable.
   * @param {HTMLCanvasElement} canvas
   * @param {number} maxCells  Max number of cells (cols × rows × 2 for H+V bars)
   */
  init(canvas, maxCells) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      console.warn('[webgl] WebGL2 not available, falling back to Canvas 2D');
      return false;
    }

    this.gl = gl;
    this.maxInstances = maxCells * 2;  // H + V bars

    // Compile shaders
    const vs = this._compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return false;

    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('[webgl] Program link error:', gl.getProgramInfoLog(this.program));
      return false;
    }

    // Uniforms
    this.uRes = gl.getUniformLocation(this.program, 'u_resolution');
    this.uBarThick = gl.getUniformLocation(this.program, 'u_barThick');
    this.uHalfLenH = gl.getUniformLocation(this.program, 'u_halfLenH');
    this.uHalfLenV = gl.getUniformLocation(this.program, 'u_halfLenV');

    // Attribute locations
    const aVertPos = gl.getAttribLocation(this.program, 'a_vertPos');
    const aCellPos = gl.getAttribLocation(this.program, 'a_cellPos');
    const aShowPlus = gl.getAttribLocation(this.program, 'a_showPlus');
    const aAlpha = gl.getAttribLocation(this.program, 'a_alpha');
    const aIsCollapsed = gl.getAttribLocation(this.program, 'a_isCollapsed');
    const aFlash = gl.getAttribLocation(this.program, 'a_flash');
    const aBarType = gl.getAttribLocation(this.program, 'a_barType');

    // VAO
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // Unit quad (per-vertex: 2 triangles = 6 vertices)
    const quadVerts = new Float32Array([
      0, 0,  1, 0,  0, 1,
      0, 1,  1, 0,  1, 1,
    ]);
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aVertPos);
    gl.vertexAttribPointer(aVertPos, 2, gl.FLOAT, false, 0, 0);
    // divisor = 0 → per-vertex

    // Instance buffer: 7 floats per instance
    // [cellPos.x, cellPos.y, showPlus, alpha, isCollapsed, flash, barType]
    const FLOATS_PER_INSTANCE = 7;
    this.instanceData = new Float32Array(this.maxInstances * FLOATS_PER_INSTANCE);
    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_INSTANCE * 4;

    // a_cellPos: offset 0
    gl.enableVertexAttribArray(aCellPos);
    gl.vertexAttribPointer(aCellPos, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(aCellPos, 1);

    // a_showPlus: offset 8
    gl.enableVertexAttribArray(aShowPlus);
    gl.vertexAttribPointer(aShowPlus, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(aShowPlus, 1);

    // a_alpha: offset 12
    gl.enableVertexAttribArray(aAlpha);
    gl.vertexAttribPointer(aAlpha, 1, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(aAlpha, 1);

    // a_isCollapsed: offset 16
    gl.enableVertexAttribArray(aIsCollapsed);
    gl.vertexAttribPointer(aIsCollapsed, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(aIsCollapsed, 1);

    // a_flash: offset 20
    gl.enableVertexAttribArray(aFlash);
    gl.vertexAttribPointer(aFlash, 1, gl.FLOAT, false, stride, 20);
    gl.vertexAttribDivisor(aFlash, 1);

    // a_barType: offset 24
    gl.enableVertexAttribArray(aBarType);
    gl.vertexAttribPointer(aBarType, 1, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(aBarType, 1);

    gl.bindVertexArray(null);

    // Blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    console.log(`[webgl] Initialized. Max instances: ${this.maxInstances}`);
    return true;
  }

  /**
   * Build per-instance data from cell states.
   * Call this each frame before render().
   *
   * @param {object} params
   * @param {number} params.cols          Grid columns
   * @param {number} params.rows          Grid rows
   * @param {number} params.cellW         Cell width in pixels
   * @param {number} params.cellH         Cell height in pixels
   * @param {Float32Array} params.density Wave density per cell
   * @param {Uint8Array} params.cellOutcome  0=superposition, 1=+, 2=−
   * @param {object} params.tileSystem    QuantumTileSystem
   * @param {number} params.tileCols
   * @param {number} params.tileRows
   * @param {number} params.gamma
   * @param {number} params.time          performance.now()
   */
  buildInstances(params) {
    const {
      cols, rows, cellW, cellH,
      density, cellOutcome, tileSystem,
      tileCols, tileRows, gamma, time
    } = params;

    const cellsPerTileX = Math.max(1, Math.floor(cols / tileCols));
    const cellsPerTileY = Math.max(1, Math.floor(rows / tileRows));

    let idx = 0;
    const data = this.instanceData;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Tile mapping
        const tx = Math.min(tileCols - 1, Math.floor(c / cellsPerTileX));
        const ty = Math.min(tileRows - 1, Math.floor(r / cellsPerTileY));
        const tileIdx = ty * tileCols + tx;

        const isCollapsed = tileSystem.collapsed[tileIdx] !== 0;
        const fade = tileSystem.fadeProgress[tileIdx];

        // Cell center in pixels
        const cx = c * cellW + cellW / 2;
        const cy = r * cellH + cellH / 2;

        let showPlus, alpha, collapsed, flash;

        if (isCollapsed && fade < 1.0) {
          // ── COLLAPSED ──
          const cellIdx = r * cols + c;
          const outcome = cellOutcome[cellIdx];
          if (outcome === 0) continue;

          const collapseStrength = 1.0 - fade;

          // Edge softening
          const inTileX = (c % cellsPerTileX) / cellsPerTileX;
          const inTileY = (r % cellsPerTileY) / cellsPerTileY;
          const edgeDist = Math.min(inTileX, 1 - inTileX, inTileY, 1 - inTileY);
          const edgeFade = edgeDist < 0.15 ? (edgeDist / 0.15) : 1.0;

          alpha = 0.85 * collapseStrength * (0.5 + 0.5 * edgeFade);
          if (alpha < 0.04) continue;

          showPlus = outcome === 1 ? 1.0 : 0.0;
          collapsed = 1.0;

          // Flash: bright white burst within first 0.5s of collapse
          flash = fade < 0.1 ? ((0.1 - fade) / 0.1) : 0.0;

        } else {
          // ── SUPERPOSITION ──
          let d = density[r * cols + c] || 0;
          d = Math.pow(Math.max(0, d), gamma);
          if (d < 0.02) continue;

          const coh = tileSystem.getCoherence(tx, ty);

          // Coherence-driven decision
          const phase = tx * 7.3 + ty * 13.7 + c * 0.37 + r * 0.71;
          const rhythmic = 0.5 + 0.5 * Math.sin(time * 0.008 + phase);
          const noise = Math.random();
          const threshold = coh * rhythmic + (1 - coh) * noise;

          showPlus = threshold < d ? 1.0 : 0.0;

          // Enhanced alpha: stronger visual presence
          alpha = Math.min(0.80, d * 1.0);
          if (alpha < 0.03) continue;

          collapsed = 0.0;
          flash = 0.0;
        }

        // H bar instance
        const base = idx * 7;
        data[base + 0] = cx;
        data[base + 1] = cy;
        data[base + 2] = showPlus;
        data[base + 3] = alpha;
        data[base + 4] = collapsed;
        data[base + 5] = flash;
        data[base + 6] = 0.0;  // H bar
        idx++;

        // V bar instance (only if showPlus)
        if (showPlus > 0.5) {
          const base2 = idx * 7;
          data[base2 + 0] = cx;
          data[base2 + 1] = cy;
          data[base2 + 2] = 1.0;
          data[base2 + 3] = alpha;
          data[base2 + 4] = collapsed;
          data[base2 + 5] = flash;
          data[base2 + 6] = 1.0;  // V bar
          idx++;
        }
      }
    }

    this.instanceCount = idx;
  }

  /**
   * Render all instances.
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   * @param {number} scaledFont
   * @param {number} cellW
   * @param {number} cellH
   */
  render(canvasWidth, canvasHeight, scaledFont, cellW, cellH) {
    const gl = this.gl;
    if (!gl || this.instanceCount === 0) return;

    // Bar geometry
    const barThick = Math.max(1, Math.round(scaledFont * 0.14));
    const halfLenH = cellW * 0.35;
    const halfLenV = cellH * 0.35;

    // Clear
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0.039, 0.039, 0.047, 1.0);  // #0a0a0c
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Upload instance data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0,
      this.instanceData.subarray(0, this.instanceCount * 7));

    // Draw
    gl.useProgram(this.program);
    gl.uniform2f(this.uRes, canvasWidth, canvasHeight);
    gl.uniform1f(this.uBarThick, barThick);
    gl.uniform1f(this.uHalfLenH, halfLenH);
    gl.uniform1f(this.uHalfLenV, halfLenV);

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
    gl.bindVertexArray(null);
  }

  /**
   * Resize handling.
   */
  resize(width, height) {
    if (this.gl) {
      this.gl.viewport(0, 0, width, height);
    }
  }

  // ── Helpers ──

  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[webgl] Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
}
