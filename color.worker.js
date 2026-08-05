/**
 * Color aim tracker (method=color) — acquire → sticky track.
 * HSV for neon; Lab ΔE for fabric.
 * Near-black picks are rejected (map shadows) — see user recording v7SqjrKY2uo.
 */

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;
  return { h, s, v };
}

function rgbToLab(r, g, b) {
  let R = r / 255,
    G = g / 255,
    B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

function pixelMatch(r, g, b, targetRGB, targetHSV, targetLab, labSamples, tol) {
  if (!targetRGB || !targetLab) return false;
  const t = Math.max(0, tol);

  if (targetLab.L < 18 || (targetRGB.r + targetRGB.g + targetRGB.b) / 3 < 40) {
    return false;
  }

  const lab = rgbToLab(r, g, b);

  // Patch signature (belly / torso): match if close to ANY sample from the pick
  if (labSamples && labSamples.length >= 12) {
    const limit = 5.5 + t * 0.18;
    const lim2 = limit * limit;
    for (let i = 0; i < labSamples.length; i += 3) {
      const dL = (lab.L - labSamples[i]) * 0.55;
      const da = lab.a - labSamples[i + 1];
      const db = lab.b - labSamples[i + 2];
      if (dL * dL + da * da + db * db <= lim2) return true;
    }
    return false;
  }

  if (targetHSV && targetHSV.s >= 40) {
    const hsv = rgbToHsv(r, g, b);
    let dh = Math.abs(hsv.h - targetHSV.h);
    if (dh > 180) dh = 360 - dh;
    if (
      dh <= 4 + t * 0.7 &&
      Math.abs(hsv.s - targetHSV.s) <= 18 + t * 1.4 &&
      Math.abs(hsv.v - targetHSV.v) <= 22 + t * 2 &&
      hsv.s >= Math.max(18, targetHSV.s * 0.4)
    ) {
      return true;
    }
    return false;
  }

  const dL = (lab.L - targetLab.L) * 0.55;
  const da = lab.a - targetLab.a;
  const db = lab.b - targetLab.b;
  const de = Math.sqrt(dL * dL + da * da + db * db);
  return de <= 7 + t * 0.22;
}

function collect(data, w, h, stride, tol, rgb, hsv, lab, samples, maskCx, maskCy, maskR2) {
  const matches = [];
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      if (maskR2 != null) {
        const dx = x - maskCx;
        const dy = y - maskCy;
        if (dx * dx + dy * dy > maskR2) continue;
      }
      const i = (y * w + x) * 4;
      if (pixelMatch(data[i], data[i + 1], data[i + 2], rgb, hsv, lab, samples, tol)) {
        matches.push(x, y);
      }
    }
  }
  return matches;
}

function bestBlob(flat, stride, minN, preferX, preferY, stickX, stickY, stickStrong, fovSpan) {
  const nPts = (flat.length / 2) | 0;
  if (!nPts) return null;

  const set = new Map();
  const key = (x, y) => ((y / stride) | 0) * 8192 + ((x / stride) | 0);
  for (let i = 0; i < nPts; i++) set.set(key(flat[i * 2], flat[i * 2 + 1]), i);

  const visited = new Uint8Array(nPts);
  const dirs = [
    [stride, 0],
    [-stride, 0],
    [0, stride],
    [0, -stride],
    [stride, stride],
    [stride, -stride],
    [-stride, stride],
    [-stride, -stride],
  ];

  let bestScore = -Infinity;
  let best = null;
  const maxOk = Math.max(28, fovSpan * 0.42); // player-sized, not wall of darkness

  for (let i = 0; i < nPts; i++) {
    if (visited[i]) continue;
    const stack = [i];
    visited[i] = 1;
    let n = 0,
      sx = 0,
      sy = 0,
      minY = 1e9,
      maxY = -1e9,
      minX = 1e9,
      maxX = -1e9;
    while (stack.length) {
      const idx = stack.pop();
      const x = flat[idx * 2];
      const y = flat[idx * 2 + 1];
      n++;
      sx += x;
      sy += y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      for (const [dx, dy] of dirs) {
        const j = set.get(key(x + dx, y + dy));
        if (j !== undefined && !visited[j]) {
          visited[j] = 1;
          stack.push(j);
        }
      }
    }
    if (n < minN) continue;

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const maxDim = Math.max(bw, bh);
    // Giant dark region / floor blob — kill (was 260k matches in user video)
    if (maxDim > maxOk) continue;
    if (n > (fovSpan * fovSpan) / (stride * stride) * 0.12) continue;

    const mx = sx / n;
    const my = minY + (maxY - minY) * 0.16;
    const aspect = bh / Math.max(1, bw);
    const distPref = Math.hypot(mx - preferX, my - preferY);

    let score = n * 14 - distPref * 6;
    if (aspect >= 1.1) score += n * 7;
    if (aspect >= 1.6) score += n * 4;
    // Prefer compact player-like size
    const ideal = fovSpan * 0.12;
    score -= Math.abs(maxDim - ideal) * 2;

    if (stickX != null) {
      const distStick = Math.hypot(mx - stickX, my - stickY);
      score += stickStrong
        ? Math.max(0, 320 - distStick * 4)
        : Math.max(0, 100 - distStick);
    }

    if (score > bestScore) {
      bestScore = score;
      best = { x: mx, y: my, n, score, minX, maxX, minY, maxY };
    }
  }
  return best;
}

self.onmessage = (ev) => {
  const { id, imageData, width, height, ox, oy, fullW, fullH, cfg } = ev.data;
  const data = imageData;
  const stride = Math.max(1, cfg.scanStride || 2);
  const tol = cfg.tolerance ?? 14;
  const rgb = cfg.targetRGB;
  const hsv = cfg.targetHSV || (rgb ? rgbToHsv(rgb.r, rgb.g, rgb.b) : null);
  const lab = rgb ? rgbToLab(rgb.r, rgb.g, rgb.b) : null;
  const samples = cfg.labSamples || null;
  const prev = cfg.prevTarget;
  const tracking = !!cfg.tracking && prev;
  const fovSpan = Math.min(width, height);

  // Hard fail early — near-black pick (user video: 34,37,38)
  if (rgb && ((rgb.r + rgb.g + rgb.b) / 3 < 40 || (lab && lab.L < 18))) {
    self.postMessage({
      id,
      matchCount: 0,
      target: null,
      move: null,
      mode: "bad-color",
      warn: "pick too dark — choose model cloth/outline, not shadow",
    });
    return;
  }

  let targetPt = null;
  let matchCount = 0;
  let mode = "acquire";

  if (tracking) {
    const lx = prev.x - ox;
    const ly = prev.y - oy;
    const tw = Math.max(48, fovSpan * 0.38);
    const x0 = Math.max(0, (lx - tw) | 0);
    const y0 = Math.max(0, (ly - tw) | 0);
    const x1 = Math.min(width, (lx + tw) | 0);
    const y1 = Math.min(height, (ly + tw) | 0);

    const flat = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        if (pixelMatch(data[i], data[i + 1], data[i + 2], rgb, hsv, lab, samples, tol * 1.25)) {
          flat.push(x, y);
        }
      }
    }
    matchCount = (flat.length / 2) | 0;
    const blob = bestBlob(flat, 1, 4, lx, ly, lx, ly, true, fovSpan);
    if (blob && Math.hypot(blob.x - lx, blob.y - ly) < tw * 0.95) {
      targetPt = {
        x: blob.x + ox,
        y: blob.y + oy,
        n: blob.n,
        x1: blob.minX + ox,
        y1: blob.minY + oy,
        x2: blob.maxX + ox,
        y2: blob.maxY + oy,
      };
      mode = "track";
    }
  }

  if (!targetPt) {
    const cx = width / 2;
    const cy = height / 2;
    const r2 = (fovSpan * 0.5) ** 2;
    const flat = collect(data, width, height, stride, tol, rgb, hsv, lab, samples, cx, cy, r2);
    matchCount = (flat.length / 2) | 0;
    // High match count = map noise, but still try player-sized blob (don't hard-fail)
    const noisy = matchCount > 4000;
    const stickX = prev ? prev.x - ox : null;
    const stickY = prev ? prev.y - oy : null;
    const blob = bestBlob(flat, stride, 4, cx, cy, stickX, stickY, !!prev, fovSpan);
    if (blob) {
      targetPt = {
        x: blob.x + ox,
        y: blob.y + oy,
        n: blob.n,
        x1: blob.minX + ox,
        y1: blob.minY + oy,
        x2: blob.maxX + ox,
        y2: blob.maxY + oy,
      };
      mode = noisy ? "acquire-noisy" : "acquire";
    } else if (noisy) {
      mode = "noisy";
    }
  }

  let move = null;
  if (targetPt) {
    let mx = targetPt.x - fullW / 2;
    let my = targetPt.y - fullH / 2;
    if (cfg.ignoreY) my = 0;
    const speed = (cfg.speed ?? 10) / 100;
    move = { x: mx * speed, y: my * speed + (cfg.offset ?? 0) };
  }

  self.postMessage({
    id,
    matchCount,
    target: targetPt,
    move,
    mode,
    warn:
      mode === "noisy"
        ? "za dużo matchy — Shift+pipeta na brzuch / wyższy kontrast"
        : undefined,
  });
};
