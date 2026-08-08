/**
 * YOLO ONNX aim — WebGPU first, threaded WASM fallback.
 * Status: ep + ms. 179ms·wasm = CPU; webgpu ≈ 15–40ms.
 * Rust/C++ „na stronie” i tak ląduje jako WASM — bez GPU ten sam limit.
 */
importScripts("./vendor/ort/ort.webgpu.min.js");

const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
ort.env.wasm.numThreads = Math.min(4, Math.max(1, hw >> 1));
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = new URL("./vendor/ort/", self.location.href).href;
ort.env.webgpu = { powerPreference: "high-performance" };

const IMGSZ = 320;
const HEAD = new Set([1, 3]); // CT_head, T_head
const FILL = 114 / 255;
const NMS_IOU = 0.45;
const CONF_MIN = 0.42;
const CONF_LOCK = 0.32; // once sticky, keep tracking weaker dets

let session = null;
let ready = false;
let loadError = null;
let tensorBuf = null;
let activeEp = "wasm";
let lock = null;

async function createSession(modelUrl, eps) {
  return ort.InferenceSession.create(modelUrl, {
    executionProviders: eps,
    graphOptimizationLevel: "all",
  });
}

async function init(modelUrl) {
  try {
    const hasGpu =
      typeof navigator !== "undefined" &&
      !!navigator.gpu &&
      typeof navigator.gpu.requestAdapter === "function";

    const attempts = [];
    if (hasGpu) attempts.push(["webgpu"]);
    attempts.push(["wasm"]);

    let lastErr = null;
    for (const eps of attempts) {
      try {
        session = await createSession(modelUrl, eps);
        activeEp = eps[0];
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        session = null;
      }
    }
    if (!session) throw lastErr || new Error("ORT init failed");

    tensorBuf = new Float32Array(3 * IMGSZ * IMGSZ);
    ready = true;
    loadError = null;
    lock = null;
    self.postMessage({
      type: "ready",
      ep: activeEp,
      threads: ort.env.wasm.numThreads,
      gpu: hasGpu,
    });
  } catch (e) {
    ready = false;
    loadError = String(e?.message || e);
    self.postMessage({ type: "error", error: loadError, mode: "ai-error", warn: loadError });
  }
}

function letterbox(rgba, w, h) {
  const scale = Math.min(IMGSZ / w, IMGSZ / h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const padX = ((IMGSZ - nw) / 2) | 0;
  const padY = ((IMGSZ - nh) / 2) | 0;
  const tensor = tensorBuf;
  const plane = IMGSZ * IMGSZ;

  // fast path: already model size (GPU-scaled crop from main thread)
  if (w === IMGSZ && h === IMGSZ) {
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      tensor[i] = rgba[p] * (1 / 255);
      tensor[plane + i] = rgba[p + 1] * (1 / 255);
      tensor[plane * 2 + i] = rgba[p + 2] * (1 / 255);
    }
    return { tensor, scale: 1, padX: 0, padY: 0 };
  }

  tensor.fill(FILL);
  const inv = 1 / scale;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, ((y + 0.5) * inv) | 0);
    const dy = padY + y;
    const row = sy * w;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, ((x + 0.5) * inv) | 0);
      const si = (row + sx) << 2;
      const di = dy * IMGSZ + (padX + x);
      tensor[di] = rgba[si] * (1 / 255);
      tensor[plane + di] = rgba[si + 1] * (1 / 255);
      tensor[plane * 2 + di] = rgba[si + 2] * (1 / 255);
    }
  }
  return { tensor, scale, padX, padY };
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const ua = a.w * a.h + b.w * b.h - inter;
  return ua > 0 ? inter / ua : 0;
}

function nms(boxes) {
  boxes.sort((a, b) => b.conf - a.conf);
  const keep = [];
  const killed = new Uint8Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    if (killed[i]) continue;
    keep.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (killed[j]) continue;
      if (iou(boxes[i], boxes[j]) >= NMS_IOU) killed[j] = 1;
    }
  }
  return keep;
}

function decode(out, confTh, scale, padX, padY, ox, oy, fovCx, fovCy, fovR2, mapScale) {
  const data = out.data;
  const num = out.dims[2];
  const attrs = out.dims[1];
  const ms = mapScale || 1;
  const boxes = [];
  for (let i = 0; i < num; i++) {
    let best = 0;
    let bestCls = 0;
    for (let c = 4; c < attrs; c++) {
      const s = data[c * num + i];
      if (s > best) {
        best = s;
        bestCls = c - 4;
      }
    }
    if (best < confTh) continue;

    const cx = data[i];
    const cy = data[num + i];
    const bw = data[2 * num + i];
    const bh = data[3 * num + i];

    const x1 = ((cx - bw / 2 - padX) / scale) * ms;
    const y1 = ((cy - bh / 2 - padY) / scale) * ms;
    const x2 = ((cx + bw / 2 - padX) / scale) * ms;
    const y2 = ((cy + bh / 2 - padY) / scale) * ms;
    const mx = ox + (x1 + x2) * 0.5;
    const my = oy + (y1 + y2) * 0.5;
    const dx = mx - fovCx;
    const dy = my - fovCy;
    if (dx * dx + dy * dy > fovR2) continue;

    const ax1 = ox + x1;
    const ay1 = oy + y1;
    const ax2 = ox + x2;
    const ay2 = oy + y2;
    boxes.push({
      x: mx,
      y: my,
      x1: ax1,
      y1: ay1,
      x2: ax2,
      y2: ay2,
      w: Math.max(1, ax2 - ax1),
      h: Math.max(1, ay2 - ay1),
      conf: best,
      cls: bestCls,
      head: HEAD.has(bestCls),
    });
  }
  return nms(boxes);
}

function aimPoint(b, wantHead) {
  const tall = b.h / Math.max(1, b.w) > 2.1;
  const x = (b.x1 + b.x2) * 0.5;
  let y;
  if (wantHead) {
    y = b.head && !tall ? b.y1 + b.h * 0.42 : b.y1 + b.h * 0.08;
  } else if (b.head && !tall) {
    // only head box available — estimate torso center below head
    y = b.y1 + b.h * 2.1;
  } else {
    // body box → exact geometric center of torso
    y = (b.y1 + b.y2) * 0.5;
  }
  return {
    x,
    y,
    conf: b.conf,
    cls: b.cls,
    head: wantHead && b.head && !tall,
    // raw det box — trigger uses this vs CS crosshair, not the aim-line tip
    x1: b.x1,
    y1: b.y1,
    x2: b.x2,
    y2: b.y2,
  };
}

function pickTarget(boxes, cx, cy, bone) {
  if (!boxes.length) {
    if (lock) {
      lock.miss = (lock.miss || 0) + 1;
      if (lock.miss > 2) lock = null;
    }
    return null;
  }

  const wantHead = bone !== "body";
  const heads = boxes.filter((b) => b.head);
  const bodies = boxes.filter((b) => !b.head);
  let pool;

  if (wantHead) {
    const realHeads = heads.filter((b) => b.h / Math.max(1, b.w) <= 2.1);
    pool = realHeads.length ? realHeads : bodies.length ? bodies : boxes;
  } else {
    // body mode: ONLY bodies when available — don't stick line to head boxes
    pool = bodies.length ? bodies : heads;
  }

  // weak sticky — strong stick lagged behind strafe reverses
  const stickR = lock ? 40 : 0;
  const stickR2 = stickR * stickR;

  let best = null;
  let bestScore = Infinity;
  for (const b of pool) {
    const p = aimPoint(b, wantHead);
    const dCross = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy);
    // primarily: closest to crosshair, then conf
    let score = dCross / (0.35 + b.conf);

    if (lock && stickR2 > 0) {
      const dLock = (p.x - lock.x) * (p.x - lock.x) + (p.y - lock.y) * (p.y - lock.y);
      if (dLock <= stickR2) score *= 0.88; // mild — don't glue to old strafe side
    }
    if (wantHead && p.head) score *= 0.75;
    if (!wantHead && !b.head) score *= 0.75;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }

  if (!best) return null;

  // never freeze on old lock — that lagged behind flicks
  lock = { x: best.x, y: best.y, conf: best.conf, cls: best.cls, miss: 0 };
  return best;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg?.type === "init") {
    await init(msg.modelUrl || "./models/enemy_yolo.onnx");
    return;
  }
  if (msg?.type === "reset") {
    lock = null;
    return;
  }

  if (!ready) {
    self.postMessage({
      target: null,
      matchCount: 0,
      mode: loadError ? "ai-error" : "ai-loading",
      warn: loadError || "loading model…",
    });
    return;
  }

  const t0 = performance.now();
  try {
    const { imageData, width, height, ox, oy, fullW, fullH, cfg, mapScale } = msg;
    const tol = cfg?.tolerance ?? 10;
    const locked = !!lock;
    const confTh = locked
      ? Math.max(CONF_LOCK, 0.38 - tol * 0.003)
      : Math.max(CONF_MIN, Math.min(0.6, 0.48 - tol * 0.003));
    const { tensor, scale, padX, padY } = letterbox(imageData, width, height);
    const input = new ort.Tensor("float32", tensor, [1, 3, IMGSZ, IMGSZ]);
    const results = await session.run({ [session.inputNames[0]]: input });
    const out = results[session.outputNames[0]];

    const fovCx = fullW * 0.5;
    const fovCy = fullH * 0.5;
    // crop already is FOV square → don't shrink again
    const fovR2 = msg.cropIsFov
      ? Infinity
      : (Math.min(width, height) * 0.42 * (mapScale || 1)) ** 2;
    const boxes = decode(
      out,
      confTh,
      scale,
      padX,
      padY,
      ox,
      oy,
      fovCx,
      fovCy,
      fovR2,
      mapScale || 1
    );
    const target = pickTarget(boxes, fovCx, fovCy, cfg?.bone || "head");
    const ms = (performance.now() - t0) | 0;
    self.postMessage({
      target,
      // all dets — trigger checks CS crosshair vs ANY box (not only aim-bone tip)
      boxes: boxes.map((b) => ({
        x1: b.x1,
        y1: b.y1,
        x2: b.x2,
        y2: b.y2,
        head: !!b.head,
      })),
      matchCount: boxes.length,
      mode: target ? "ai" : "seek",
      warn: null,
      ms,
      ep: activeEp,
    });
  } catch (e) {
    self.postMessage({
      target: null,
      matchCount: 0,
      mode: "ai-error",
      warn: String(e?.message || e),
    });
  }
};
