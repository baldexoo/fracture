export const DEFAULTS = {
  aim: {
    enabled: false,
    ignoreY: false,
    fov: 20,
    speed: 10,
    offset: 0,
    type: "hold",
    bone: "head",
  },
  detection: {
    color: true,
    tolerance: 10,
    method: "color",
    targetRGB: { r: 255, g: 0, b: 0 },
    targetHSV: { h: 0, s: 100, v: 100 },
  },
  holdKey: "ShiftLeft",
  triggerbot: {
    enabled: false,
    type: "hold",
    key: "AltLeft",
    delay: 40,
    hitRadius: 14,
    prediction: 0, // legacy
  },
  canvasScale: 0.5,
  scanStride: 2,
  visuals: {
    detectionOverlay: false,
    audioRadar: {
      enabled: false,
      distance: 35,
      angle: 75,
    },
  },
};

const KEY = "fracture_cfg_v1";

export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    return deepMerge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg) {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

function deepMerge(a, b) {
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) {
      a[k] = deepMerge(a[k] || {}, b[k]);
    } else {
      a[k] = b[k];
    }
  }
  return a;
}

export function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / d + 2) * 60;
        break;
      default:
        h = ((r - g) / d + 4) * 60;
    }
  }
  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;
  return { h, s, v };
}

export function hsvToRgb(h, s, v) {
  s /= 100;
  v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
