/**
 * image-loader.js — Load an image and convert it to a tile-resolution brightness map.
 *
 * Pipeline:
 *   Image → offscreen canvas → grayscale → resize to tile grid → histogram equalization → [0,1] Float32Array
 */

/**
 * Load an image URL and produce a brightness map sized (tileCols × tileRows).
 * @param {string} src                Image URL / path
 * @param {number} tileCols           Target tile columns
 * @param {number} tileRows           Target tile rows
 * @returns {Promise<Float32Array>}   Brightness values [0,1], row-major
 */
export async function loadAndProcess(src, tileCols, tileRows) {
  const img = await loadImage(src);

  // 1. Draw image to offscreen canvas at tile resolution
  const canvas = new OffscreenCanvas(tileCols, tileRows);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, tileCols, tileRows);

  const imageData = ctx.getImageData(0, 0, tileCols, tileRows);
  const pixels = imageData.data; // RGBA

  // 2. Grayscale conversion (luminance weights)
  const gray = new Float32Array(tileCols * tileRows);
  for (let i = 0; i < gray.length; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  // 3. Histogram equalization
  histogramEqualize(gray);

  return gray;
}

/* ── helpers ── */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/**
 * In-place histogram equalization on a [0,1] Float32Array.
 */
function histogramEqualize(data) {
  const BINS = 256;
  const hist = new Uint32Array(BINS);

  // Build histogram
  for (let i = 0; i < data.length; i++) {
    const bin = Math.min(BINS - 1, Math.floor(data[i] * BINS));
    hist[bin]++;
  }

  // Cumulative distribution
  const cdf = new Float32Array(BINS);
  cdf[0] = hist[0];
  for (let i = 1; i < BINS; i++) {
    cdf[i] = cdf[i - 1] + hist[i];
  }

  // Normalize CDF to [0,1]
  const cdfMin = cdf.find(v => v > 0) || 0;
  const denom = data.length - cdfMin;
  if (denom <= 0) return;

  for (let i = 0; i < BINS; i++) {
    cdf[i] = Math.max(0, (cdf[i] - cdfMin) / denom);
  }

  // Apply equalization
  for (let i = 0; i < data.length; i++) {
    const bin = Math.min(BINS - 1, Math.floor(data[i] * BINS));
    data[i] = cdf[bin];
  }
}
