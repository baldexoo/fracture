import {
  loadConfig,
  saveConfig,
  rgbToHsv,
  hsvToRgb,
  clamp,
} from "./utils.js";
import {
  requireSessionOrRedirect,
  getSession,
  clearSession,
  reconnectPaired,
  sendMove,
  sendClick,
} from "./hid.js";
import { createOverlay } from "./overlay.js";
import { createAudioRadar } from "./audio-radar.js";
import { openToolWindow } from "./popout.js";

if (!requireSessionOrRedirect()) {
  /* redirected */
}

const cfg = loadConfig();
const session = getSession();

const video = document.getElementById("screenVideo");
const canvas = document.getElementById("screenCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
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

const hidDot = document.getElementById("hidDot");
const hidStatus = document.getElementById("hidStatus");
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
let missFrames = 0;
let lastDebugPts = null;
let detectEvery = 0;
let showDebug = false;
let tracking = false;
let velX = 0;
let velY = 0;
let holdPressed = false;
let trigLatched = false;
let eyedropperOn = false;
let labSamples = null; // session: Lab triples from belly/patch pick (not in localStorage)
let frames = 0;
let fpsTimer = performance.now();
let lastTriggerAt = 0;
let loopStarted = false;

tokenStatus.textContent = session?.tokenMasked || maskToken(session?.token || "—");

reconnectPaired()
  .then((d) => {
    hidDevice = d;
    setHidUi(!!d);
  })
  .catch(() => setHidUi(false));

function setHidUi(on) {
  hidDot.classList.toggle("on", on);
  hidDot.classList.toggle("off", !on);
  hidStatus.textContent = on ? "connected" : "disconnected";
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
  trigPrediction: document.getElementById("trigPrediction"),
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
  els.trigPrediction.value = cfg.triggerbot.prediction;
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
  cfg.triggerbot.prediction = Number(els.trigPrediction.value);
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
  els.holdKey,
].forEach((el) => el.addEventListener("change", readUiToCfg));

els.detMethod.addEventListener("change", () => {
  tracking = false;
  lastTarget = null;
  smoothTarget = null;
  missFrames = 0;
  velX = velY = 0;
  readUiToCfg();
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
    // must run in user-gesture turn (checkbox) — never after await share
    overlayWin = await openToolWindow({
      name: "fracture-detection-overlay",
      title: "detection",
      width: 320,
      height: 240,
      canvasWidth: 320,
      canvasHeight: 200,
    });
    if (!overlayWin) {
      cfg.visuals.detectionOverlay = false;
      els.visOverlay.checked = false;
      saveConfig(cfg);
      targetStatus.textContent = "overlay: pozwól na popupy / Document PiP";
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
  if (radarWin && !radarWin.closed() && radarWin.canvas) {
    radarApi.draw(radarWin.canvas, c);
  }
}

async function toggleRadar() {
  if (cfg.visuals.audioRadar.enabled) {
    if (radarInline) radarInline.style.display = "block";
    if (!radarWin || radarWin.closed()) {
      radarWin = await openToolWindow({
        name: "fracture-audio-radar",
        title: "radar",
        width: 300,
        height: 220,
        canvasWidth: 300,
        canvasHeight: 180,
      });
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
  return (
    /could not start audio source/i.test(msg) ||
    e?.name === "NotReadableError" ||
    e?.name === "TrackStartError"
  );
}

function setAudioUi(ok, label) {
  const audioStatus = document.getElementById("audioStatus");
  if (audioStatus) audioStatus.textContent = ok ? label || "live" : "none";
  const hint = document.getElementById("radarHint");
  if (hint) {
    hint.style.color = ok ? "#6a6" : "#666";
    if (ok) {
      hint.textContent =
        "audio z share OK — puls z przechwyconego dźwięku (okno CS2 / ekran). suwaki = kierunek igły.";
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

async function bindShareStream(media) {
  stopCurrentStream();
  stream = media;

  const vtracks = stream.getVideoTracks();
  video.srcObject = new MediaStream(vtracks);
  video.muted = true;
  await video.play();
  placeholder.classList.add("hidden");

  // Surface info — window vs monitor (CS2 window audio ≠ mic)
  const vset = vtracks[0]?.getSettings?.() || {};
  const surface = vset.displaySurface || "?";
  const atracks = stream.getAudioTracks();
  console.info("[share]", {
    surface,
    audioTracks: atracks.map((t) => ({
      label: t.label,
      state: t.readyState,
      muted: t.muted,
    })),
  });

  let ok = false;
  try {
    ok = await radarApi.attachStream(stream);
  } catch {
    ok = false;
  }

  if (ok) {
    setAudioUi(true, surface === "window" ? "cs2?" : "sys");
  } else {
    setAudioUi(false);
    const hint = document.getElementById("radarHint");
    if (hint) {
      hint.style.color = "#c66";
      hint.innerHTML =
        "brak ścieżki audio z share. zrób share ponownie → <b>Okno</b> → CS2 → włącz dźwięk okna. " +
        "nie używamy mikrofonu / Discord.";
    }
  }

  if (cfg.visuals.audioRadar.enabled) {
    if (radarInline) radarInline.style.display = "block";
    paintRadar();
  }
  // nie otwieraj okienek tu — po await share nie ma user-gesture (blocker)

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

    // DOKŁADNIE jeden picker — bez fallback getDisplayMedia (to była pętla „udostępnij znowu”).
    // audio:true pokazuje toggle; jeśli OS nie da ścieżki, i tak dostajesz video (albo pusty audio).
    let media;
    try {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 } },
        audio: true,
        selfBrowserSurface: "exclude",
      });
    } catch (e) {
      if (isCancel(e)) return;
      // Nie otwieraj drugiego pickera. Przy błędzie audio-start użytkownik musi
      // odznaczyć dźwięk SAM w tym samym dialogu / spróbować później.
      if (isAudioStartError(e)) {
        const hint = document.getElementById("radarHint");
        if (hint) {
          hint.style.color = "#c66";
          hint.innerHTML =
            "Windows odrzucił audio share. W dialogu odznacz dźwięk i udostępnij sam obraz — " +
            "albo zamknij OBS/overlay i spróbuj <b>raz</b> z oknem CS2 + dźwięk. " +
            "<b>Nie ma drugiego okna share z kodu.</b>";
        }
        return;
      }
      throw e;
    }

    await bindShareStream(media);
  } catch (e) {
    if (isCancel(e)) return;
    if (isAudioStartError(e)) return;
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

document.getElementById("logoutBtn").addEventListener("click", () => {
  clearSession();
  location.href = "./index.html";
});

document.getElementById("resetLockBtn").addEventListener("click", () => {
  lastTarget = null;
  smoothTarget = null;
  missFrames = 0;
  lastDebugPts = null;
  tracking = false;
  velX = velY = 0;
  targetStatus.textContent = "lock reset";
});

/* —— keys —— */
window.addEventListener("keydown", (e) => {
  if (e.code === cfg.holdKey) holdPressed = true;
  if (cfg.triggerbot.type === "toggle" && e.code === cfg.holdKey && e.repeat === false) {
    trigLatched = !trigLatched;
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === cfg.holdKey) holdPressed = false;
});

function aimActive() {
  if (!cfg.aim.enabled) return false;
  if (cfg.aim.type === "always") return true;
  return holdPressed;
}

function triggerActive() {
  if (!cfg.triggerbot.enabled) return false;
  if (cfg.triggerbot.type === "toggle") return trigLatched;
  return holdPressed;
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
  worker = new Worker(kind === "ai" ? "./ai.worker.js" : "./color.worker.js");
  worker.onmessage = async (ev) => {
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
    const { target, matchCount, mode, warn, ms, ep } = data;
    lastDebugPts = null;

    if (mode === "bad-color" || mode === "ai-error") {
      tracking = false;
      lastTarget = null;
      smoothTarget = null;
      targetStatus.textContent = warn || mode;
      return;
    }
    if (mode === "ai-loading") {
      targetStatus.textContent = warn || mode;
      return;
    }

    if (target) {
      missFrames = 0;
      tracking = true;

      if (!smoothTarget) {
        smoothTarget = { x: target.x, y: target.y };
        velX = 0;
        velY = 0;
      } else {
        const dx = target.x - smoothTarget.x;
        const dy = target.y - smoothTarget.y;
        const dist = Math.hypot(dx, dy);
        // AI: hard cap jump — without this the line whips across FOV
        const maxStep = workerKind === "ai" ? 28 : 85;
        let tx = target.x;
        let ty = target.y;
        if (dist > maxStep) {
          const s = maxStep / dist;
          tx = smoothTarget.x + dx * s;
          ty = smoothTarget.y + dy * s;
        }
        const a =
          workerKind === "ai"
            ? dist < 6
              ? 0.35
              : 0.55
            : mode === "track"
              ? dist < 6
                ? 0.14
                : 0.28
              : 0.42;
        const nx = smoothTarget.x * (1 - a) + tx * a;
        const ny = smoothTarget.y * (1 - a) + ty * a;
        velX = nx - smoothTarget.x;
        velY = ny - smoothTarget.y;
        smoothTarget = { x: nx, y: ny };
      }
      lastTarget = smoothTarget;
      const extra =
        mode === "ai" && target.conf != null
          ? ` · ${NAMES_SHORT[target.cls] || target.cls} ${(target.conf * 100) | 0}%`
          : "";
      const timing = ms != null ? ` ${ms}ms` : "";
      const backend = ep ? ` · ${ep}` : "";
      targetStatus.textContent = `${mode} · ${lastTarget.x | 0},${lastTarget.y | 0} (${matchCount})${extra}${timing}${backend}`;
    } else {
      missFrames++;
      // AI: drop lock fast — no ghost coast (that was the crazy whip)
      const missLimit = workerKind === "ai" ? 2 : 12;
      const dropAt = workerKind === "ai" ? 3 : 18;
      if (missFrames <= missLimit && smoothTarget && workerKind !== "ai") {
        smoothTarget = {
          x: smoothTarget.x + velX * 0.55,
          y: smoothTarget.y + velY * 0.55,
        };
        velX *= 0.88;
        velY *= 0.88;
        lastTarget = smoothTarget;
      } else if (missFrames > dropAt) {
        tracking = false;
        lastTarget = null;
        smoothTarget = null;
        velX = velY = 0;
        targetStatus.textContent = warn || (matchCount ? `seek (${matchCount})` : "—");
      } else if (workerKind === "ai") {
        lastTarget = null;
        targetStatus.textContent = matchCount ? `seek (${matchCount})` : "—";
      }
    }

    if (aimActive() && lastTarget && detectionOn()) {
      let mx = lastTarget.x - canvas.width / 2;
      let my = cfg.aim.ignoreY ? 0 : lastTarget.y - canvas.height / 2;
      if (Math.abs(mx) < 2) mx = 0;
      if (Math.abs(my) < 2) my = 0;
      const speed = cfg.aim.speed / 100;
      await sendMove(hidDevice, mx * speed, my * speed + (cfg.aim.ignoreY ? 0 : cfg.aim.offset));
    }

    if (triggerActive() && lastTarget && detectionOn()) {
      const delay = cfg.triggerbot.prediction * 4;
      const now = performance.now();
      if (now - lastTriggerAt > 80 + delay) {
        lastTriggerAt = now;
        await sendClick(hidDevice, 1);
      }
    }
  };

  if (kind === "ai") {
    targetStatus.textContent = "loading ai…";
    worker.postMessage({ type: "init", modelUrl: "./models/enemy_yolo.onnx?v=ort121-webgpu" });
  }
}

const NAMES_SHORT = ["ct", "cth", "t", "th"];

function fovRadiusPx() {
  return Math.max(
    28,
    (Math.min(canvas.width, canvas.height) * (0.2 + (cfg.aim.fov / 20) * 0.45)) | 0
  );
}

function loop() {
  if (!video.srcObject) return;
  // AI: smaller canvas → cheaper getImageData (infer always @320 anyway)
  const scale =
    workerKind === "ai"
      ? Math.min(cfg.canvasScale || 0.5, 0.35)
      : Math.min(cfg.canvasScale || 0.5, 0.6);
  const w = Math.max(2, (video.videoWidth * scale) | 0);
  const h = Math.max(2, (video.videoHeight * scale) | 0);
  if (w && h && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
  if (canvas.width && video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const radius = fovRadiusPx();

    // No AI coast — extrapolating vel between slow WASM frames made the line thrash

    if (cfg.aim.enabled) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(canvas.width / 2, canvas.height / 2, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (showDebug && lastDebugPts && lastDebugPts.length) {
      ctx.fillStyle = "rgba(255, 0, 255, 0.5)";
      for (let i = 0; i < lastDebugPts.length; i += 2) {
        const p = lastDebugPts[i];
        ctx.fillRect(p.x, p.y, 2, 2);
      }
    }

    if (lastTarget) {
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(canvas.width / 2, canvas.height / 2);
      ctx.lineTo(lastTarget.x, lastTarget.y);
      ctx.stroke();
    }

    // overlay at half rate; radar via uiTick
    if ((frames & 1) === 0) {
      if (cfg.visuals.detectionOverlay && overlayWin && !overlayWin.closed()) {
        overlayApi.draw(overlayWin.canvas, canvas, lastTarget);
      }
    }

    detectEvery++;
    const wantDetect =
      !workerBusy &&
      worker &&
      detectionOn() &&
      (workerKind !== "ai" || aiReady) &&
      (workerKind === "ai" || detectEvery % 2 === 0);

    if (wantDetect) {
      workerBusy = true;
      const cx = canvas.width >> 1;
      const cy = canvas.height >> 1;
      const x0 = Math.max(0, cx - radius);
      const y0 = Math.max(0, cy - radius);
      const x1 = Math.min(canvas.width, cx + radius);
      const y1 = Math.min(canvas.height, cy + radius);
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
          fullW: canvas.width,
          fullH: canvas.height,
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

  frames++;
  const now = performance.now();
  if (now - fpsTimer >= 1000) {
    fpsStatus.textContent = String(frames);
    frames = 0;
    fpsTimer = now;
  }
  requestAnimationFrame(loop);
}

writeCfgToUi();
ensureWorker();
// okienka tylko po kliknięciu checkboxa (user gesture) — nie auto-open
if (cfg.visuals.audioRadar.enabled && radarInline) {
  radarInline.style.display = "block";
}

/* radar paints every frame when enabled */
function uiTick() {
  if (cfg.visuals.audioRadar.enabled) paintRadar();
  requestAnimationFrame(uiTick);
}
uiTick();
