import {
  loadConfig,
  saveConfig,
  rgbToHsv,
  hsvToRgb,
  clamp,
} from "./utils.js?v=trig8";
import {
  requireSessionOrRedirect,
  getSession,
  clearSession,
  reconnectPaired,
  sendMove,
  sendClick,
  connectSerial,
  serialConnected,
  serialSupported,
  testClick,
} from "./hid.js?v=trig8";
import { createOverlay } from "./overlay.js?v=trig8";
import { createAudioRadar } from "./audio-radar.js?v=trig8";
import { openToolWindow } from "./popout.js?v=trig8";

if (!requireSessionOrRedirect()) {
  /* redirected */
}

const cfg = loadConfig();
const session = getSession();

const video = document.getElementById("screenVideo");
const canvas = document.getElementById("screenCanvas");
const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
const placeholder = document.getElementById("stagePlaceholder");
const overlayApi = createOverlay();
const radarApi = createAudioRadar();
const radarInline = document.getElementById("radarInline");
let overlayWin = null;
let radarWin = null;
let radarAudioWarned = false;
const magnifier = document.getElementById("magnifier");
const magCanvas = document.getElementById("magnifierCanvas");
const magCtx = magCanvas.getContext("2d");

/** Fixed-size GPU downsample target for AI (avoids big getImageData). */
const DETECT_SZ = 320;
const detectCanvas = document.createElement("canvas");
detectCanvas.width = DETECT_SZ;
detectCanvas.height = DETECT_SZ;
const detectCtx = detectCanvas.getContext("2d", {
  willReadFrequently: true,
  alpha: false,
});

let lastStatusAt = 0;
let lastOverlayAt = 0;
let lastRadarAt = 0;
let lastDetectAt = 0;
let lastInferMs = 50;
let detectSentAt = 0;
let rawPrev = null; // last raw detection {x,y,t}
let trackVx = 0; // px/s from raw dets only (not from smoothed line)
let trackVy = 0;
let loopPrevT = performance.now();

const hidDot = document.getElementById("hidDot");
const hidStatus = document.getElementById("hidStatus");
const trigStatus = document.getElementById("trigStatus");
const tokenStatus = document.getElementById("tokenStatus");
const targetStatus = document.getElementById("targetStatus");
const fpsStatus = document.getElementById("fpsStatus");

let hidDevice = null;
let stream = null;
let worker = null;
let workerKind = null; // "color" | "ai"
let workerBusy = false;
let aiReady = false;
let lastTarget = null;
let smoothTarget = null;
/** Raw enemy boxes for trigger — never the aim-line tip / lead. */
let lastHitBox = null;
/** @type {{x1:number,y1:number,x2:number,y2:number,head?:boolean}[]} */
let lastHitBoxes = [];
/** When lastHitBoxes were captured (performance.now). */
let hitBoxesAt = 0;
let missFrames = 0;
let lastDebugPts = null;
let detectEvery = 0;
let showDebug = false;
let tracking = false;
let velX = 0;
let velY = 0;
let holdPressed = false;
let trigPressed = false;
let trigLatched = false;
let eyedropperOn = false;
let labSamples = null; // session: Lab triples from belly/patch pick (not in localStorage)
let frames = 0;
let fpsTimer = performance.now();
let lastTriggerAt = 0;
let trigOnSince = 0;
let loopStarted = false;

tokenStatus.textContent = session?.tokenMasked || maskToken(session?.token || "—");

reconnectPaired()
  .then((d) => {
    hidDevice = d;
    setHidUi(!!d);
  })
  .catch(() => setHidUi(false));

function setHidUi(on) {
  const ser = serialConnected();
  hidDot.classList.toggle("on", on && ser);
  hidDot.classList.toggle("off", !(on && ser));
  if (!on) hidStatus.textContent = "disconnected";
  else if (!ser) hidStatus.textContent = "hid · no serial";
  else hidStatus.textContent = "hid+serial";
}

function maskToken(t) {
  if (!t || t.length < 8) return t;
  return `${t.slice(0, 3)}***${t.slice(-3)}`;
}

/* —— tabs —— */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

/* —— sliders —— */
function syncSlider(input) {
  const wrap = input.closest(".slider-wrap");
  if (!wrap) return;
  const min = Number(input.min);
  const max = Number(input.max);
  const val = Number(input.value);
  const pct = ((val - min) / (max - min)) * 100;
  const fill = wrap.querySelector(".slider-fill");
  const label = wrap.querySelector(".slider-value");
  if (fill) fill.style.width = `${pct}%`;
  if (label) {
    label.textContent = String(val);
    label.style.left = `${pct}%`;
  }
}

document.querySelectorAll(".slider-wrap input[type=range]").forEach((input) => {
  syncSlider(input);
  input.addEventListener("input", () => {
    syncSlider(input);
    readUiToCfg();
  });
});

/* —— bind config —— */
const els = {
  aimEnabled: document.getElementById("aimEnabled"),
  aimIgnoreY: document.getElementById("aimIgnoreY"),
  aimFov: document.getElementById("aimFov"),
  aimSpeed: document.getElementById("aimSpeed"),
  aimOffset: document.getElementById("aimOffset"),
  aimType: document.getElementById("aimType"),
  aimBone: document.getElementById("aimBone"),
  detColor: document.getElementById("detColor"),
  detTolerance: document.getElementById("detTolerance"),
  detMethod: document.getElementById("detMethod"),
  trigEnabled: document.getElementById("trigEnabled"),
  trigType: document.getElementById("trigType"),
  trigKey: document.getElementById("trigKey"),
  trigDelay: document.getElementById("trigDelay"),
  trigHit: document.getElementById("trigHit"),
  trigTap: document.getElementById("trigTap"),
  trigDelayLabel: document.getElementById("trigDelayLabel"),
  trigHitLabel: document.getElementById("trigHitLabel"),
  trigTapLabel: document.getElementById("trigTapLabel"),
  visOverlay: document.getElementById("visOverlay"),
  visRadar: document.getElementById("visRadar"),
  radarDistance: document.getElementById("radarDistance"),
  radarAngle: document.getElementById("radarAngle"),
  holdKey: document.getElementById("holdKey"),
  canvasScale: document.getElementById("canvasScale"),
  hue: document.getElementById("hue"),
  rgbR: document.getElementById("rgbR"),
  rgbG: document.getElementById("rgbG"),
  rgbB: document.getElementById("rgbB"),
  swatch: document.getElementById("swatch"),
  colorTools: document.getElementById("colorTools"),
};

function writeCfgToUi() {
  els.aimEnabled.checked = cfg.aim.enabled;
  els.aimIgnoreY.checked = cfg.aim.ignoreY;
  els.aimFov.value = cfg.aim.fov;
  els.aimSpeed.value = cfg.aim.speed;
  els.aimOffset.value = cfg.aim.offset;
  els.aimType.value = cfg.aim.type;
  els.aimBone.value = cfg.aim.bone === "body" ? "body" : "head";
  els.detColor.checked = cfg.detection.color;
  els.detTolerance.value = cfg.detection.tolerance;
  els.detMethod.value = cfg.detection.method;
  els.trigEnabled.checked = cfg.triggerbot.enabled;
  els.trigType.value = cfg.triggerbot.type;
  els.trigKey.value = cfg.triggerbot.key || "KeyX";
  if (!els.trigKey.querySelector(`option[value="${els.trigKey.value}"]`)) {
    els.trigKey.value = "KeyX";
  }
  els.trigDelay.value = cfg.triggerbot.delay ?? 10;
  els.trigHit.value = cfg.triggerbot.hitRadius ?? 10;
  if (els.trigTap) els.trigTap.value = cfg.triggerbot.tapInterval ?? 280;
  if (els.trigDelayLabel) els.trigDelayLabel.textContent = String(els.trigDelay.value);
  if (els.trigHitLabel) els.trigHitLabel.textContent = String(els.trigHit.value);
  if (els.trigTapLabel) els.trigTapLabel.textContent = String(els.trigTap?.value ?? 280);
  els.visOverlay.checked = cfg.visuals.detectionOverlay;
  els.visRadar.checked = cfg.visuals.audioRadar.enabled;
  els.radarDistance.value = cfg.visuals.audioRadar.distance;
  els.radarAngle.value = cfg.visuals.audioRadar.angle;
  els.holdKey.value = cfg.holdKey;
  els.canvasScale.value = Math.round(cfg.canvasScale * 100);
  const rgb = cfg.detection.targetRGB;
  els.rgbR.value = rgb.r;
  els.rgbG.value = rgb.g;
  els.rgbB.value = rgb.b;
  els.hue.value = Math.round(cfg.detection.targetHSV.h);
  updateSwatch();
  toggleColorTools();
  document.querySelectorAll(".slider-wrap input[type=range]").forEach(syncSlider);
}

function readUiToCfg() {
  cfg.aim.enabled = els.aimEnabled.checked;
  cfg.aim.ignoreY = els.aimIgnoreY.checked;
  cfg.aim.fov = Number(els.aimFov.value);
  cfg.aim.speed = Number(els.aimSpeed.value);
  cfg.aim.offset = Number(els.aimOffset.value);
  cfg.aim.type = els.aimType.value;
  cfg.aim.bone = els.aimBone.value === "body" ? "body" : "head";
  cfg.detection.color = els.detColor.checked;
  cfg.detection.tolerance = Number(els.detTolerance.value);
  cfg.detection.method = els.detMethod.value;
  cfg.triggerbot.enabled = els.trigEnabled.checked;
  cfg.triggerbot.type = els.trigType.value;
  cfg.triggerbot.key = els.trigKey.value;
  cfg.triggerbot.delay = Number(els.trigDelay.value);
  cfg.triggerbot.hitRadius = Number(els.trigHit.value);
  cfg.triggerbot.tapInterval = Number(els.trigTap?.value ?? 280);
  if (els.trigDelayLabel) els.trigDelayLabel.textContent = String(cfg.triggerbot.delay);
  if (els.trigHitLabel) els.trigHitLabel.textContent = String(cfg.triggerbot.hitRadius);
  if (els.trigTapLabel) els.trigTapLabel.textContent = String(cfg.triggerbot.tapInterval);
  cfg.visuals.detectionOverlay = els.visOverlay.checked;
  cfg.visuals.audioRadar.enabled = els.visRadar.checked;
  cfg.visuals.audioRadar.distance = Number(els.radarDistance.value);
  cfg.visuals.audioRadar.angle = Number(els.radarAngle.value);
  cfg.holdKey = els.holdKey.value;
  cfg.canvasScale = Number(els.canvasScale.value) / 100;
  saveConfig(cfg);
  toggleColorTools();
  ensureWorker();
}

function detectionOn() {
  if (cfg.detection.method === "ai") return true;
  return cfg.detection.method === "color" && cfg.detection.color;
}

[
  els.aimEnabled,
  els.aimIgnoreY,
  els.aimType,
  els.aimBone,
  els.detColor,
  els.trigEnabled,
  els.trigType,
  els.trigKey,
  els.holdKey,
].forEach((el) => el.addEventListener("change", readUiToCfg));

els.detMethod.addEventListener("change", () => {
  tracking = false;
  lastTarget = null;
  smoothTarget = null;
  lastHitBox = null;
  lastHitBoxes = [];
  missFrames = 0;
  velX = velY = 0;
  readUiToCfg();
});

els.aimBone.addEventListener("change", () => {
  readUiToCfg();
  smoothTarget = null;
  lastTarget = null;
  lastHitBox = null;
  lastHitBoxes = [];
  velX = velY = 0;
  trackVx = trackVy = 0;
  rawPrev = null;
  tracking = false;
  if (worker && workerKind === "ai") worker.postMessage({ type: "reset" });
});

els.visOverlay.addEventListener("change", () => {
  readUiToCfg();
  void toggleOverlay();
});
els.visRadar.addEventListener("change", () => {
  readUiToCfg();
  void toggleRadar();
});

document.getElementById("overlayPopBtn")?.addEventListener("click", () => {
  els.visOverlay.checked = true;
  readUiToCfg();
  void toggleOverlay();
});
document.getElementById("radarPopBtn")?.addEventListener("click", () => {
  els.visRadar.checked = true;
  readUiToCfg();
  void toggleRadar();
});
els.radarDistance.addEventListener("input", () => {
  readUiToCfg();
  syncSlider(els.radarDistance);
  if (cfg.visuals.audioRadar.enabled) paintRadar();
});
els.radarAngle.addEventListener("input", () => {
  readUiToCfg();
  syncSlider(els.radarAngle);
  if (cfg.visuals.audioRadar.enabled) paintRadar();
});


function updateSwatch() {
  const { r, g, b } = cfg.detection.targetRGB;
  els.swatch.style.background = `rgb(${r},${g},${b})`;
  els.swatch.title = labSamples?.length
    ? `patch ${labSamples.length / 3 | 0} samples`
    : "single color";
}

/** Sample a torso-sized patch around (cx,cy) on the share canvas → mean RGB + Lab list. */
function samplePatchAt(cx, cy, radius = 14) {
  if (workerKind === "ai" && video.videoWidth) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }
  const x0 = clamp(cx - radius, 0, canvas.width - 1);
  const y0 = clamp(cy - radius, 0, canvas.height - 1);
  const x1 = clamp(cx + radius, 0, canvas.width - 1);
  const y1 = clamp(cy + radius, 0, canvas.height - 1);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = ctx.getImageData(x0, y0, w, h).data;
  let rSum = 0,
    gSum = 0,
    bSum = 0,
    n = 0;
  const samples = [];
  const step = Math.max(1, (Math.max(w, h) / 8) | 0); // ~8×8 grid across patch
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // skip near-black outliers inside patch (scope UI / gaps)
      if ((r + g + b) / 3 < 28) continue;
      rSum += r;
      gSum += g;
      bSum += b;
      n++;
      const lab = (() => {
        // inline light Lab — same as worker; keep pick self-contained
        let R = r / 255,
          G = g / 255,
          B = b / 255;
        R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
        G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
        B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
        let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
        let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1;
        let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
        const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        X = f(X);
        Y = f(Y);
        Z = f(Z);
        return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
      })();
      samples.push(lab[0], lab[1], lab[2]);
    }
  }
  if (n < 4) return null;
  return {
    r: (rSum / n) | 0,
    g: (gSum / n) | 0,
    b: (bSum / n) | 0,
    labSamples: samples,
  };
}

function setRgb(r, g, b, samples = null) {
  r = clamp(r | 0, 0, 255);
  g = clamp(g | 0, 0, 255);
  b = clamp(b | 0, 0, 255);
  const avg = (r + g + b) / 3;
  if (avg < 40) {
    alert(
      "Ten kolor jest za ciemny (prawie czerń/cień mapy).\n" +
        "Color aim złapie pół FOV i będzie „trackował” ściany.\n\n" +
        "Wybierz jaśniejszy / bardziej unikalny kolor z modelu\n" +
        "(mundur, hełm, outline) — nie cień pod nogami."
    );
    return;
  }
  cfg.detection.targetRGB = { r, g, b };
  cfg.detection.targetHSV = rgbToHsv(r, g, b);
  labSamples = samples && samples.length >= 12 ? samples : null;
  const hsv = cfg.detection.targetHSV;
  if (!labSamples && hsv.s < 22) {
    alert(
      "Ten kolor jest prawie szary (niska saturacja).\n" +
        "Lepiej: eyedropper → kliknij na BRZUCH modelu na podglądzie share\n" +
        "(bierze plamę ~30px, nie jeden piksel)."
    );
  }
  if (hsv.s < 35 || hsv.v < 40) {
    cfg.detection.tolerance = Math.max(cfg.detection.tolerance, 16);
    els.detTolerance.value = cfg.detection.tolerance;
    syncSlider(els.detTolerance);
  } else if (hsv.h > 180 && hsv.h < 260) {
    cfg.detection.tolerance = Math.max(cfg.detection.tolerance, 15);
    els.detTolerance.value = cfg.detection.tolerance;
    syncSlider(els.detTolerance);
  }
  els.rgbR.value = r;
  els.rgbG.value = g;
  els.rgbB.value = b;
  els.hue.value = Math.round(cfg.detection.targetHSV.h);
  updateSwatch();
  saveConfig(cfg);
  lastTarget = null;
  smoothTarget = null;
  lastHitBox = null;
  lastHitBoxes = [];
  missFrames = 0;
  tracking = false;
  velX = velY = 0;
  if (labSamples) {
    targetStatus.textContent = `patch · ${labSamples.length / 3 | 0} samples`;
  }
}

els.rgbR.addEventListener("change", () =>
  setRgb(+els.rgbR.value, +els.rgbG.value, +els.rgbB.value)
);
els.rgbG.addEventListener("change", () =>
  setRgb(+els.rgbR.value, +els.rgbG.value, +els.rgbB.value)
);
els.rgbB.addEventListener("change", () =>
  setRgb(+els.rgbR.value, +els.rgbG.value, +els.rgbB.value)
);
els.hue.addEventListener("input", () => {
  const h = Number(els.hue.value);
  const { s, v } = cfg.detection.targetHSV;
  const rgb = hsvToRgb(h, Math.max(s, 40), Math.max(v, 40));
  setRgb(rgb.r, rgb.g, rgb.b);
});

function toggleColorTools() {
  const show = cfg.detection.color && cfg.detection.method === "color";
  els.colorTools.classList.toggle("hidden", !show);
}

async function toggleOverlay() {
  if (cfg.visuals.detectionOverlay) {
    if (overlayWin && !overlayWin.closed()) return overlayWin;
    // sync open — must stay in the click turn (no await before this)
    overlayWin = openToolWindow({
      name: "fracture-detection-overlay",
      page: "./overlay.html",
      width: 340,
      height: 260,
    });
    if (!overlayWin) {
      cfg.visuals.detectionOverlay = false;
      els.visOverlay.checked = false;
      saveConfig(cfg);
      targetStatus.textContent = "overlay: zablokowane popupy — Allow dla tej strony";
    }
    return overlayWin;
  }
  if (overlayWin) {
    overlayWin.close();
    overlayWin = null;
  }
  return null;
}

function paintRadar() {
  const c = cfg.visuals.audioRadar;
  if (radarInline) radarApi.draw(radarInline, c);
  if (radarWin && !radarWin.closed()) {
    if (!radarWin.canvas) {
      try {
        radarWin.canvas = radarWin.win.document.getElementById("view");
      } catch {
        /* ignore */
      }
    }
    if (radarWin.canvas) radarApi.draw(radarWin.canvas, c);
  }
}

async function toggleRadar() {
  if (cfg.visuals.audioRadar.enabled) {
    if (radarInline) radarInline.style.display = "block";
    if (!radarWin || radarWin.closed()) {
      radarWin = openToolWindow({
        name: "fracture-audio-radar",
        page: "./radar.html",
        width: 320,
        height: 240,
      });
      if (!radarWin) {
        targetStatus.textContent = "radar: zablokowane popupy — Allow dla tej strony";
      }
    }
    paintRadar();
    radarApi.resume();
    if (stream && !radarApi.getHasAudio() && !radarAudioWarned) {
      radarAudioWarned = true;
      alert(
        "Audio radar: brak ścieżki audio.\n\nShare ponownie → Entire screen → włącz „Also share system audio”.\n(Okno / karta gry zwykle nie dają system audio.)"
      );
    }
  } else {
    if (radarInline) radarInline.style.display = "none";
    if (radarWin) {
      radarWin.close();
      radarWin = null;
    }
  }
}

/* —— eyedropper (system-wide via EyeDropper API) —— */
const eyedropperBtn = document.getElementById("eyedropperBtn");

function hexToRgb(hex) {
  const h = hex.replace("#", "").trim();
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function stopCanvasEyedropper() {
  eyedropperOn = false;
  eyedropperBtn.classList.remove("active");
  magnifier.classList.remove("on");
}

eyedropperBtn.addEventListener("click", async (e) => {
  // Shift = plama z podglądu share (brzuch). Bez Shift = OS pipette (cały ekran / gra).
  if (e.shiftKey && canvas.width && video.srcObject) {
    eyedropperOn = !eyedropperOn;
    eyedropperBtn.classList.toggle("active", eyedropperOn);
    magnifier.classList.toggle("on", eyedropperOn);
    if (eyedropperOn) {
      targetStatus.textContent = "patch: kliknij brzuch na podglądzie";
    }
    return;
  }

  if (window.EyeDropper) {
    eyedropperBtn.classList.add("active");
    eyedropperOn = false;
    magnifier.classList.remove("on");
    try {
      const dropper = new EyeDropper();
      const result = await dropper.open();
      const rgb = hexToRgb(result.sRGBHex);
      setRgb(rgb.r, rgb.g, rgb.b, null);
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("EyeDropper failed:", err);
    } finally {
      eyedropperBtn.classList.remove("active");
    }
    return;
  }

  // No EyeDropper API — canvas only
  if (canvas.width && video.srcObject) {
    eyedropperOn = !eyedropperOn;
    eyedropperBtn.classList.toggle("active", eyedropperOn);
    magnifier.classList.toggle("on", eyedropperOn);
    return;
  }
  alert("Brak EyeDropper — najpierw share screen, potem Shift+pipeta = plama z podglądu.");
});

canvas.addEventListener("mousemove", (e) => {
  if (!eyedropperOn || !canvas.width) return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = clamp(((e.clientX - rect.left) * scaleX) | 0, 0, canvas.width - 1);
  const y = clamp(((e.clientY - rect.top) * scaleY) | 0, 0, canvas.height - 1);

  magnifier.style.left = `${e.clientX + 18}px`;
  magnifier.style.top = `${e.clientY + 18}px`;

  const src = 15;
  magCtx.imageSmoothingEnabled = false;
  magCtx.fillStyle = "#000";
  magCtx.fillRect(0, 0, 120, 120);
  magCtx.drawImage(canvas, x - src, y - src, src * 2, src * 2, 0, 0, 120, 120);
  magCtx.strokeStyle = "rgba(255,255,255,0.15)";
  const cell = 120 / (src * 2);
  for (let i = 0; i <= src * 2; i++) {
    magCtx.beginPath();
    magCtx.moveTo(i * cell, 0);
    magCtx.lineTo(i * cell, 120);
    magCtx.moveTo(0, i * cell);
    magCtx.lineTo(120, i * cell);
    magCtx.stroke();
  }
  magCtx.strokeStyle = "#fff";
  magCtx.strokeRect(60 - cell / 2, 60 - cell / 2, cell, cell);
});

canvas.addEventListener("click", (e) => {
  if (!eyedropperOn || !canvas.width) return;
  const rect = canvas.getBoundingClientRect();
  const x = clamp(
    (((e.clientX - rect.left) * canvas.width) / rect.width) | 0,
    0,
    canvas.width - 1
  );
  const y = clamp(
    (((e.clientY - rect.top) * canvas.height) / rect.height) | 0,
    0,
    canvas.height - 1
  );
  // ~half belly: radius scales with canvas (share is downscaled)
  const radius = Math.max(12, Math.min(28, (Math.min(canvas.width, canvas.height) * 0.04) | 0));
  const patch = samplePatchAt(x, y, radius);
  if (!patch) {
    alert("Za ciemna plama — kliknij w jaśniejszą część torsu.");
    return;
  }
  setRgb(patch.r, patch.g, patch.b, patch.labSamples);
  stopCanvasEyedropper();
});

/* —— share screen (CS2 picture + optional game audio from same picker) —— */
function isCancel(e) {
  return e?.name === "NotAllowedError" || e?.name === "AbortError";
}

function isAudioStartError(e) {
  const msg = String(e?.message || e || "");
  if (/could not start audio source/i.test(msg)) return true;
  if (e?.name === "NotReadableError" && /audio/i.test(msg)) return true;
  if (e?.name === "TrackStartError" && /audio/i.test(msg)) return true;
  // Chrome sometimes throws bare NotReadableError when share-audio checkbox is on
  if (e?.name === "NotReadableError" && /start/i.test(msg)) return true;
  return false;
}

/** Mic permission unlocks Chrome system-audio capture on many Windows setups. */
async function ensureMicPermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    for (const t of s.getTracks()) t.stop();
    return true;
  } catch {
    return false;
  }
}

function displayMediaOpts(wantAudio) {
  const opts = {
    video: { frameRate: { ideal: 60 } },
    selfBrowserSurface: "exclude",
    preferCurrentTab: false,
  };
  if (!wantAudio) {
    opts.audio = false;
    return opts;
  }
  opts.audio = true;
  // Chromium hints (ignored if unsupported)
  try {
    opts.systemAudio = "include";
  } catch {
    /* ignore */
  }
  try {
    opts.windowAudio = "system";
  } catch {
    /* ignore */
  }
  return opts;
}

async function requestDisplayStream() {
  // 1) try with audio
  try {
    return {
      media: await navigator.mediaDevices.getDisplayMedia(displayMediaOpts(true)),
      audioAttempt: true,
    };
  } catch (e) {
    if (isCancel(e)) throw e;
    if (!isAudioStartError(e)) throw e;
  }
  // 2) same click turn: video-only so share still works
  return {
    media: await navigator.mediaDevices.getDisplayMedia(displayMediaOpts(false)),
    audioAttempt: false,
    audioFailed: true,
  };
}

function setAudioUi(ok, label) {
  const audioStatus = document.getElementById("audioStatus");
  if (audioStatus) audioStatus.textContent = ok ? label || "live" : "none";
  const hint = document.getElementById("radarHint");
  if (hint) {
    hint.style.color = ok ? "#6a6" : "#666";
    if (ok) {
      hint.innerHTML =
        "audio OK — radar pulsuje z share. " +
        "suwaki = kierunek igły (nie direction-finding z mic).";
    }
  }
  paintRadar();
}

function stopCurrentStream() {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }
  stream = null;
}

async function bindShareStream(media, meta = {}) {
  stopCurrentStream();
  stream = media;

  const vtracks = stream.getVideoTracks();
  if (!vtracks.length) throw new Error("Brak ścieżki video z share.");

  video.srcObject = new MediaStream(vtracks);
  video.muted = true;
  await video.play();
  placeholder.classList.add("hidden");

  const vset = vtracks[0]?.getSettings?.() || {};
  const surface = vset.displaySurface || "?";
  const atracks = stream.getAudioTracks();
  console.info("[share]", {
    surface,
    audioFailed: !!meta.audioFailed,
    audioTracks: atracks.map((t) => ({
      label: t.label,
      state: t.readyState,
      muted: t.muted,
      enabled: t.enabled,
    })),
  });

  for (const t of atracks) {
    t.enabled = true;
    t.addEventListener("ended", () => {
      setAudioUi(false);
      const hint = document.getElementById("radarHint");
      if (hint) {
        hint.style.color = "#c66";
        hint.textContent = "audio track ended — share ponownie z dźwiękiem.";
      }
    });
  }

  let ok = false;
  try {
    ok = await radarApi.attachStream(stream);
  } catch {
    ok = false;
  }

  if (ok) {
    setAudioUi(true, surface === "window" ? "window" : surface === "monitor" ? "system" : "live");
  } else {
    setAudioUi(false);
    const hint = document.getElementById("radarHint");
    if (hint) {
      hint.style.color = "#c66";
      if (meta.audioFailed) {
        hint.innerHTML =
          "Windows/Chrome nie uruchomił audio (często headset surround / exclusive mode). " +
          "Share obrazu OK. Spróbuj: <b>Cały ekran</b> + „Share system audio”, stereo 48 kHz, " +
          "albo ustawienia Chrome → mikrofon Allow dla tej strony.";
      } else if (!atracks.length) {
        hint.innerHTML =
          "Udostępniłeś obraz <b>bez</b> dźwięku. Share ponownie → zaznacz " +
          "<b>Also share system audio / Udostępnij dźwięk</b> " +
          "(najpewniej: zakładka <b>Cały ekran</b>, nie samo okno).";
      } else {
        hint.innerHTML =
          "Jest track audio, ale attach się wywalił — kliknij panel (AudioContext) i share jeszcze raz.";
      }
    }
  }

  if (cfg.visuals.audioRadar.enabled) {
    if (radarInline) radarInline.style.display = "block";
    paintRadar();
  }

  vtracks[0]?.addEventListener("ended", () => {
    placeholder.classList.remove("hidden");
    radarApi.stop();
    setAudioUi(false);
  });

  ensureWorker();
  if (!loopStarted) {
    loopStarted = true;
    loop();
  }
}

document.getElementById("shareBtn").addEventListener("click", async () => {
  try {
    radarAudioWarned = false;
    await radarApi.warm();
    // Chrome often needs mic permission before system-audio capture works
    await ensureMicPermission();
    await radarApi.warm();

    const { media, audioFailed } = await requestDisplayStream();
    await bindShareStream(media, { audioFailed });
  } catch (e) {
    if (isCancel(e)) return;
    console.warn("share failed", e);
    const hint = document.getElementById("radarHint");
    if (hint) {
      hint.style.color = "#c66";
      hint.textContent = `share error: ${e?.message || e}`;
    }
    alert(e?.message || String(e));
  }
});

document.addEventListener(
  "pointerdown",
  () => {
    radarApi.resume();
  },
  { passive: true }
);

document.getElementById("serialBtn")?.addEventListener("click", async () => {
  try {
    if (!serialSupported()) throw new Error("Web Serial niedostępne — Chrome / Edge.");
    await connectSerial({ requestIfNeeded: true });
    setHidUi(!!hidDevice);
  } catch (e) {
    alert(e?.message || String(e));
  }
});

document.getElementById("testClickBtn")?.addEventListener("click", async () => {
  if (!serialConnected()) {
    alert("Najpierw connect serial (misc) — status musi być hid+serial.");
    return;
  }
  const ok = await testClick();
  if (trigStatus) trigStatus.textContent = ok ? "clicked" : "click FAIL";
  if (!ok) alert("Serial write fail — reconnect serial / sprawdź kabel RP2040.");
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  clearSession();
  location.href = "./index.html";
});

document.getElementById("resetLockBtn").addEventListener("click", () => {
  lastTarget = null;
  smoothTarget = null;
  lastHitBox = null;
  lastHitBoxes = [];
  missFrames = 0;
  lastDebugPts = null;
  tracking = false;
  velX = velY = 0;
  targetStatus.textContent = "lock reset";
});

/* —— keys —— */
function trigKeyCode() {
  return cfg.triggerbot.key || "AltLeft";
}

function isTrigMouseKey() {
  const k = trigKeyCode();
  return k === "Mouse4" || k === "Mouse5";
}

function mouseBtnForTrig() {
  // browser: 3 = back (mouse4), 4 = forward (mouse5)
  return trigKeyCode() === "Mouse5" ? 4 : 3;
}

function setTrigDown(down, fromToggleEdge) {
  if (cfg.triggerbot.type === "always") return;
  if (cfg.triggerbot.type === "toggle") {
    if (down && fromToggleEdge) trigLatched = !trigLatched;
    updateTrigStatus();
    return;
  }
  trigPressed = down;
  if (!down) trigOnSince = 0;
  updateTrigStatus();
}

function eventMatchesTrigKey(e) {
  const code = trigKeyCode();
  if (e.code === code) return true;
  // OSK / layouts sometimes omit Left/Right suffix
  if (code === "AltLeft" || code === "AltRight") return e.key === "Alt";
  if (code === "ShiftLeft" || code === "ShiftRight") return e.key === "Shift";
  if (code === "ControlLeft" || code === "ControlRight") return e.key === "Control";
  return false;
}

window.addEventListener(
  "keydown",
  (e) => {
    if (e.code === cfg.holdKey) holdPressed = true;
    if (!isTrigMouseKey() && eventMatchesTrigKey(e) && e.repeat === false) {
      e.preventDefault();
      setTrigDown(true, true);
    }
  },
  true
);
window.addEventListener(
  "keyup",
  (e) => {
    if (e.code === cfg.holdKey) holdPressed = false;
    if (!isTrigMouseKey() && eventMatchesTrigKey(e)) {
      setTrigDown(false, false);
    }
  },
  true
);
window.addEventListener("mousedown", (e) => {
  if (!isTrigMouseKey() || e.button !== mouseBtnForTrig()) return;
  e.preventDefault();
  setTrigDown(true, true);
});
window.addEventListener("mouseup", (e) => {
  if (!isTrigMouseKey() || e.button !== mouseBtnForTrig()) return;
  setTrigDown(false, false);
});
// stop Chrome back/forward on side buttons while panel focused
window.addEventListener(
  "mouseup",
  (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  },
  true
);
window.addEventListener("blur", () => {
  trigPressed = false;
  holdPressed = false;
  trigOnSince = 0;
  updateTrigStatus();
});

function aimActive() {
  if (!cfg.aim.enabled) return false;
  if (cfg.aim.type === "always") return true;
  return holdPressed;
}

function triggerActive() {
  if (!cfg.triggerbot.enabled) return false;
  if (cfg.triggerbot.type === "always") return true;
  if (cfg.triggerbot.type === "toggle") return trigLatched;
  return trigPressed;
}

function updateTrigStatus() {
  if (!trigStatus) return;
  if (!cfg.triggerbot.enabled) {
    trigStatus.textContent = "off";
    return;
  }
  if (!serialConnected()) {
    trigStatus.textContent = "no serial";
    return;
  }
  if (cfg.triggerbot.type === "always") {
    trigStatus.textContent = csCrosshairOnEnemy() ? "FIRE" : "always";
    return;
  }
  if (!triggerActive()) {
    trigStatus.textContent = "wait key";
    return;
  }
  trigStatus.textContent = csCrosshairOnEnemy() ? "FIRE" : "KEY↓";
}

function frameSize() {
  if (workerKind === "ai") {
    return {
      w: video.videoWidth || canvas.width,
      h: video.videoHeight || canvas.height,
    };
  }
  return { w: canvas.width, h: canvas.height };
}

/** Mild torso pad for head boxes — big expand caused late strafe shots. */
function triggerVolume(b) {
  const bw = Math.max(1, b.x2 - b.x1);
  const bh = Math.max(1, b.y2 - b.y1);
  const tall = bh / bw > 2.1;
  if (b.head && !tall) {
    return {
      x1: b.x1 - bw * 0.08,
      x2: b.x2 + bw * 0.08,
      y1: b.y1,
      y2: b.y1 + bh * 1.85,
    };
  }
  return b;
}

/**
 * CS crosshair = frame center, vs boxes extrapolated to NOW (kills late strafe fire).
 * Stale dets / led aim-line tip are ignored.
 */
function csCrosshairOnEnemy() {
  const { w, h } = frameSize();
  if (!w || !h) return false;
  const list = lastHitBoxes.length
    ? lastHitBoxes
    : lastHitBox
      ? [lastHitBox]
      : [];
  if (!list.length || !hitBoxesAt) return false;

  const now = performance.now();
  // capture→infer lag already in detectSentAt; boxes timestamped on result
  const ageMs = now - hitBoxesAt;
  if (ageMs > 70) return false; // too old — enemy likely strafed off

  const ageSec = ageMs / 1000;
  // push box with raw track velocity so we test where enemy is NOW, not in the old frame
  const ex = trackVx * ageSec;
  const ey = trackVy * ageSec;

  const cx = w * 0.5;
  const cy = h * 0.5;
  const pad = cfg.triggerbot.hitRadius ?? 14;

  for (const raw of list) {
    const box = triggerVolume(raw);
    const x1 = box.x1 + ex - pad;
    const x2 = box.x2 + ex + pad;
    const y1 = cfg.aim.ignoreY ? -1e9 : box.y1 + ey - pad;
    const y2 = cfg.aim.ignoreY ? 1e9 : box.y2 + ey + pad;
    if (cx < x1 || cx > x2 || cy < y1 || cy > y2) continue;

    // leaving gate: box center fleeing crosshair → don't shoot
    const bx = (box.x1 + box.x2) * 0.5 + ex;
    const by = (box.y1 + box.y2) * 0.5 + ey;
    const toBx = bx - cx;
    const toBy = cfg.aim.ignoreY ? 0 : by - cy;
    const dist = Math.hypot(toBx, toBy);
    if (dist > 2) {
      const leave = (trackVx * toBx + trackVy * toBy) / dist; // px/s away from center
      if (leave > 450) continue; // already strafing off hard
    }
    return true;
  }
  return false;
}

function tickTriggerbot() {
  updateTrigStatus();
  if (!triggerActive() || !detectionOn()) {
    trigOnSince = 0;
    return;
  }
  const now = performance.now();
  if (!csCrosshairOnEnemy()) {
    trigOnSince = 0;
    return;
  }
  if (!trigOnSince) trigOnSince = now;
  const delay = cfg.triggerbot.delay ?? 40;
  if (now - trigOnSince < delay) return;
  // final check right before click (delay window can go stale)
  if (!csCrosshairOnEnemy()) {
    trigOnSince = 0;
    return;
  }
  const tap = Math.max(120, cfg.triggerbot.tapInterval ?? 280);
  if (now - lastTriggerAt < tap) return;
  if (!serialConnected()) return;
  lastTriggerAt = now;
  void sendClick(hidDevice, 1);
}

function ensureWorker() {
  const kind = cfg.detection.method === "ai" ? "ai" : "color";
  if (worker && workerKind === kind) return;

  if (worker) {
    worker.terminate();
    worker = null;
    workerBusy = false;
  }
  workerKind = kind;
  aiReady = kind !== "ai";
  worker = new Worker(kind === "ai" ? "./ai.worker.js?v=trig5" : "./color.worker.js?v=trig5");
  worker.onmessage = (ev) => {
    const data = ev.data || {};
    if (data.type === "ready") {
      aiReady = true;
      const bits = [data.ep || "wasm"];
      if (data.threads) bits.push(`${data.threads}t`);
      if (data.gpu === false) bits.push("no-gpu");
      targetStatus.textContent = `ai ready · ${bits.join(" · ")}`;
      return;
    }
    if (data.type === "error") {
      aiReady = false;
      targetStatus.textContent = data.error || "ai-error";
      workerBusy = false;
      return;
    }

    workerBusy = false;
    const { target, matchCount, mode, warn, ms, ep, boxes } = data;
    lastDebugPts = null;

    if (mode === "bad-color" || mode === "ai-error") {
      tracking = false;
      lastTarget = null;
      smoothTarget = null;
      lastHitBox = null;
      lastHitBoxes = [];
      targetStatus.textContent = warn || mode;
      return;
    }
    if (mode === "ai-loading") {
      targetStatus.textContent = warn || mode;
      return;
    }

    if (Array.isArray(boxes) && boxes.length) {
      lastHitBoxes = boxes;
      lastHitBox = boxes[0];
      hitBoxesAt = performance.now();
    } else if (!target) {
      // no dets this frame — drop trigger boxes immediately (don't coast into strafe)
      lastHitBoxes = [];
      lastHitBox = null;
      hitBoxesAt = 0;
    }

    if (target) {
      missFrames = 0;
      tracking = true;
      lastInferMs = ms != null ? ms : lastInferMs;
      const now = performance.now();

      if (!lastHitBoxes.length) {
        if (
          target.x1 != null &&
          target.y1 != null &&
          target.x2 != null &&
          target.y2 != null
        ) {
          lastHitBox = { x1: target.x1, y1: target.y1, x2: target.x2, y2: target.y2 };
          lastHitBoxes = [lastHitBox];
          hitBoxesAt = now;
        } else {
          const r = 8;
          lastHitBox = {
            x1: target.x - r,
            y1: target.y - r,
            x2: target.x + r,
            y2: target.y + r,
          };
          lastHitBoxes = [lastHitBox];
          hitBoxesAt = now;
        }
      }

      let tx = target.x;
      let ty = target.y;

      if (workerKind === "ai") {
        // velocity from RAW detections only — never from smoothed line (that orbited)
        if (rawPrev && now - rawPrev.t > 10 && now - rawPrev.t < 400) {
          const jump = Math.hypot(target.x - rawPrev.x, target.y - rawPrev.y);
          if (jump > 120) {
            trackVx = 0;
            trackVy = 0;
          } else {
            const dt = (now - rawPrev.t) / 1000;
            const vx = (target.x - rawPrev.x) / dt;
            const vy = (target.y - rawPrev.y) / dt;
            trackVx = trackVx * 0.4 + vx * 0.6;
            trackVy = trackVy * 0.4 + vy * 0.6;
            const sp = Math.hypot(trackVx, trackVy);
            if (sp > 1800) {
              trackVx = (trackVx / sp) * 1800;
              trackVy = (trackVy / sp) * 1800;
            }
          }
        }
        rawPrev = { x: target.x, y: target.y, t: now };

        // lead = how late this box is (capture→now), capped so it can't overshoot hard
        const ageSec = Math.min(0.095, Math.max(0.02, (now - detectSentAt) / 1000));
        let lx = trackVx * ageSec;
        let ly = trackVy * ageSec;
        const lead = Math.hypot(lx, ly);
        const maxLead = 22; // px — catch-up without flying past model
        if (lead > maxLead) {
          lx *= maxLead / lead;
          ly *= maxLead / lead;
        }
        tx = target.x + lx;
        ty = target.y + ly;

        // AI line = led raw point (no laggy blend)
        smoothTarget = { x: tx, y: ty };
        velX = trackVx / 60;
        velY = trackVy / 60;
      } else if (!smoothTarget) {
        smoothTarget = { x: tx, y: ty };
        velX = 0;
        velY = 0;
      } else {
        const dx = tx - smoothTarget.x;
        const dy = ty - smoothTarget.y;
        const dist = Math.hypot(dx, dy);
        const maxStep = 85;
        let sx = tx;
        let sy = ty;
        if (dist > maxStep) {
          const s = maxStep / dist;
          sx = smoothTarget.x + dx * s;
          sy = smoothTarget.y + dy * s;
        }
        const a =
          mode === "track"
            ? dist < 6
              ? 0.14
              : 0.28
            : 0.42;
        const nx = smoothTarget.x * (1 - a) + sx * a;
        const ny = smoothTarget.y * (1 - a) + sy * a;
        velX = nx - smoothTarget.x;
        velY = ny - smoothTarget.y;
        smoothTarget = { x: nx, y: ny };
      }
      lastTarget = smoothTarget;
      lastDetectAt = now;
      if (now - lastStatusAt > 80) {
        lastStatusAt = now;
        const extra =
          mode === "ai" && target.conf != null
            ? ` · ${NAMES_SHORT[target.cls] || target.cls} ${(target.conf * 100) | 0}%`
            : "";
        const timing = ms != null ? ` ${ms}ms` : "";
        const backend = ep ? ` · ${ep}` : "";
        targetStatus.textContent = `${mode} · ${lastTarget.x | 0},${lastTarget.y | 0} (${matchCount})${extra}${timing}${backend}`;
      }
    } else {
      missFrames++;
      const missLimit = workerKind === "ai" ? 2 : 12;
      const dropAt = workerKind === "ai" ? 4 : 18;
      if (missFrames <= missLimit && smoothTarget) {
        lastTarget = smoothTarget;
        trackVx *= 0.7;
        trackVy *= 0.7;
      } else if (missFrames > dropAt) {
        tracking = false;
        lastTarget = null;
        smoothTarget = null;
        lastHitBox = null;
        lastHitBoxes = [];
        hitBoxesAt = 0;
        velX = velY = 0;
        trackVx = trackVy = 0;
        rawPrev = null;
        targetStatus.textContent = warn || (matchCount ? `seek (${matchCount})` : "—");
      } else if (workerKind === "ai") {
        targetStatus.textContent = matchCount ? `seek (${matchCount})` : "—";
      }
    }

    if (aimActive() && lastTarget && detectionOn() && serialConnected()) {
      const { w, h } = frameSize();
      let mx = lastTarget.x - w / 2;
      let my = cfg.aim.ignoreY ? 0 : lastTarget.y - h / 2;
      if (Math.abs(mx) < 2) mx = 0;
      if (Math.abs(my) < 2) my = 0;
      const speed = cfg.aim.speed / 100;
      void sendMove(hidDevice, mx * speed, my * speed + (cfg.aim.ignoreY ? 0 : cfg.aim.offset));
    }

    tickTriggerbot();
  };

  if (kind === "ai") {
    targetStatus.textContent = "loading ai…";
    worker.postMessage({ type: "init", modelUrl: "./models/enemy_yolo.onnx?v=ort121-webgpu" });
  }
}

const NAMES_SHORT = ["ct", "cth", "t", "th"];

function fovRadiusPx(bw, bh) {
  const w = bw || canvas.width;
  const h = bh || canvas.height;
  return Math.max(28, (Math.min(w, h) * (0.2 + (cfg.aim.fov / 20) * 0.45)) | 0);
}

function syncPreviewMode() {
  const ai = workerKind === "ai";
  video.classList.toggle("is-hidden", !ai);
}

function loop() {
  if (!video.srcObject) {
    requestAnimationFrame(loop);
    return;
  }

  const ai = workerKind === "ai";
  syncPreviewMode();

  const vw = video.videoWidth | 0;
  const vh = video.videoHeight | 0;
  if (!vw || !vh || video.readyState < 2) {
    requestAnimationFrame(loop);
    return;
  }

  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0.008, (now - loopPrevT) / 1000));
  loopPrevT = now;

  if (ai) {
    // HUD canvas in video pixel space; video element is the live 60fps preview
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }
    ctx.clearRect(0, 0, vw, vh);

    const radius = fovRadiusPx(vw, vh);

    // between inferences: nudge line with RAW track velocity (half-rate = no overshoot spiral)
    if (workerBusy && lastTarget && (trackVx !== 0 || trackVy !== 0)) {
      const sp = Math.hypot(trackVx, trackVy);
      if (sp > 30 && sp < 1600) {
        lastTarget = {
          x: lastTarget.x + trackVx * dt * 0.45,
          y: lastTarget.y + trackVy * dt * 0.45,
        };
        smoothTarget = lastTarget;
      }
    }

    if (cfg.aim.enabled) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(vw / 2, vh / 2, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (lastTarget) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(vw / 2, vh / 2);
      ctx.lineTo(lastTarget.x, lastTarget.y);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    if (
      !workerBusy &&
      worker &&
      detectionOn() &&
      aiReady
    ) {
      workerBusy = true;
      detectSentAt = performance.now();
      const cx = vw >> 1;
      const cy = vh >> 1;
      const side = Math.max(96, Math.min(vw, vh, radius * 2));
      const x0 = Math.max(0, Math.min(vw - side, cx - (side >> 1)));
      const y0 = Math.max(0, Math.min(vh - side, cy - (side >> 1)));
      detectCtx.drawImage(video, x0, y0, side, side, 0, 0, DETECT_SZ, DETECT_SZ);
      const imageData = detectCtx.getImageData(0, 0, DETECT_SZ, DETECT_SZ);
      worker.postMessage(
        {
          id: frames,
          imageData: imageData.data,
          width: DETECT_SZ,
          height: DETECT_SZ,
          ox: x0,
          oy: y0,
          fullW: vw,
          fullH: vh,
          mapScale: side / DETECT_SZ,
          cropIsFov: true,
          cfg: {
            tolerance: cfg.detection.tolerance,
            bone: cfg.aim.bone || "head",
          },
        },
        [imageData.data.buffer]
      );
    }
  } else {
    // color path: composite video onto canvas (needs pixels for scan)
    video.classList.add("is-hidden");
    const scale = Math.min(cfg.canvasScale || 0.5, 0.55);
    const w = Math.max(2, (vw * scale) | 0);
    const h = Math.max(2, (vh * scale) | 0);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const radius = fovRadiusPx(w, h);
    if (cfg.aim.enabled) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (lastTarget) {
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2);
      ctx.lineTo(lastTarget.x, lastTarget.y);
      ctx.stroke();
    }
    detectEvery++;
    if (!workerBusy && worker && detectionOn() && detectEvery % 2 === 0) {
      workerBusy = true;
      const cx = w >> 1;
      const cy = h >> 1;
      const x0 = Math.max(0, cx - radius);
      const y0 = Math.max(0, cy - radius);
      const x1 = Math.min(w, cx + radius);
      const y1 = Math.min(h, cy + radius);
      const cw = Math.max(1, x1 - x0);
      const ch = Math.max(1, y1 - y0);
      const imageData = ctx.getImageData(x0, y0, cw, ch);
      worker.postMessage(
        {
          id: frames,
          imageData: imageData.data,
          width: cw,
          height: ch,
          ox: x0,
          oy: y0,
          fullW: w,
          fullH: h,
          cfg: {
            targetRGB: cfg.detection.targetRGB,
            targetHSV: cfg.detection.targetHSV,
            labSamples,
            tolerance: cfg.detection.tolerance,
            speed: cfg.aim.speed,
            offset: cfg.aim.offset,
            ignoreY: cfg.aim.ignoreY,
            bone: cfg.aim.bone || "head",
            scanStride: 2,
            prevTarget: smoothTarget,
            tracking,
          },
        },
        [imageData.data.buffer]
      );
    }
  }

  if (cfg.visuals.detectionOverlay && overlayWin && !overlayWin.closed() && now - lastOverlayAt > 66) {
    lastOverlayAt = now;
    if (!overlayWin.canvas) {
      try {
        overlayWin.canvas = overlayWin.win.document.getElementById("view");
      } catch {
        /* ignore */
      }
    }
    if (overlayWin.canvas) {
      if (ai) {
        // cheap: draw FOV crop from video into overlay
        const oc = overlayWin.canvas;
        const octx = oc.getContext("2d");
        const side = Math.min(vw, vh) * 0.22;
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        octx.fillStyle = "#000";
        octx.fillRect(0, 0, oc.width, oc.height);
        octx.drawImage(video, sx, sy, side, side, 0, 0, oc.width, oc.height);
        if (lastTarget) {
          const tx = ((lastTarget.x - sx) / side) * oc.width;
          const ty = ((lastTarget.y - sy) / side) * oc.height;
          octx.strokeStyle = "#fff";
          octx.beginPath();
          octx.moveTo(oc.width / 2, oc.height / 2);
          octx.lineTo(tx, ty);
          octx.stroke();
        }
      } else {
        overlayApi.draw(overlayWin.canvas, canvas, lastTarget);
      }
    }
  }

  frames++;
  if (now - fpsTimer >= 1000) {
    fpsStatus.textContent = String(frames);
    frames = 0;
    fpsTimer = now;
  }
  tickTriggerbot();
  requestAnimationFrame(loop);
}

writeCfgToUi();
ensureWorker();
// okienka tylko po kliknięciu checkboxa (user gesture) — nie auto-open
if (cfg.visuals.audioRadar.enabled && radarInline) {
  radarInline.style.display = "block";
}

/* radar paints ~15Hz when enabled */
function uiTick() {
  const now = performance.now();
  if (cfg.visuals.audioRadar.enabled && now - lastRadarAt > 66) {
    lastRadarAt = now;
    paintRadar();
  }
  requestAnimationFrame(uiTick);
}
uiTick();
