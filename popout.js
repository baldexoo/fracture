/**
 * Detached tool windows. Open popup SYNCHRONOUSLY first (user-gesture),
 * then optionally upgrade to Document PiP. Awaiting PiP before window.open
 * burns the gesture and the fallback gets blocked — that was the bug.
 */
const POS_KEY = "fracture.popout.pos.v1";

function loadPos(name) {
  try {
    const all = JSON.parse(localStorage.getItem(POS_KEY) || "{}");
    return all[name] || null;
  } catch {
    return null;
  }
}

function savePos(name, win) {
  if (!win || win.closed) return;
  try {
    const all = JSON.parse(localStorage.getItem(POS_KEY) || "{}");
    all[name] = {
      x: win.screenX,
      y: win.screenY,
      w: win.outerWidth,
      h: win.outerHeight,
    };
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

function ensureDoc(doc) {
  if (doc.body && doc.head) return;
  doc.open();
  doc.write("<!doctype html><html><head></head><body></body></html>");
  doc.close();
}

function fillHud(doc, { title, canvasId, cw, ch }) {
  ensureDoc(doc);
  doc.title = title || "";
  while (doc.head.firstChild) doc.head.removeChild(doc.head.firstChild);
  while (doc.body.firstChild) doc.body.removeChild(doc.body.firstChild);

  const style = doc.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; }
    html, body {
      margin: 0; width: 100%; height: 100%;
      background: #141414; overflow: hidden;
      font: 11px "Segoe UI", sans-serif; color: #888;
      user-select: none;
    }
    .hud {
      display: flex; flex-direction: column;
      width: 100%; height: 100%;
      background: #1a1a1a;
    }
    .cap { flex: 0 0 28px; height: 28px; background: #222; }
    .rule { flex: 0 0 3px; height: 3px; background: #e8c84a; }
    .stage { flex: 1 1 auto; min-height: 0; background: #000; }
    canvas { display: block; width: 100%; height: 100%; background: #000; }
  `;
  doc.head.appendChild(style);
  const hud = doc.createElement("div");
  hud.className = "hud";
  const cap = doc.createElement("div");
  cap.className = "cap";
  const rule = doc.createElement("div");
  rule.className = "rule";
  const stage = doc.createElement("div");
  stage.className = "stage";
  const canvas = doc.createElement("canvas");
  canvas.id = canvasId || "view";
  canvas.width = cw;
  canvas.height = ch;
  stage.appendChild(canvas);
  hud.appendChild(cap);
  hud.appendChild(rule);
  hud.appendChild(stage);
  doc.body.appendChild(hud);
  return canvas;
}

function wrap(win, canvas, name) {
  let alive = win;
  const timer = setInterval(() => {
    if (!alive || alive.closed) {
      clearInterval(timer);
      return;
    }
    savePos(name, alive);
  }, 400);
  try {
    alive.addEventListener("pagehide", () => savePos(name, alive));
  } catch {
    /* ignore */
  }
  return {
    win: alive,
    canvas,
    kind: "popup",
    closed() {
      return !alive || alive.closed;
    },
    close() {
      savePos(name, alive);
      clearInterval(timer);
      try {
        if (alive && !alive.closed) alive.close();
      } catch {
        /* ignore */
      }
      alive = null;
    },
  };
}

let pipHolder = null;

function openViaPopup({ name, title, width, height, canvasId, cw, ch }) {
  const pos = loadPos(name);
  const w = Math.max(180, (pos?.w || width) | 0);
  const h = Math.max(140, (pos?.h || height) | 0);
  const left = pos?.x != null ? pos.x | 0 : Math.max(40, (screen.availWidth - w) >> 2);
  const top = pos?.y != null ? pos.y | 0 : Math.max(40, (screen.availHeight - h) >> 2);
  const features = [
    "popup=yes",
    `width=${w}`,
    `height=${h}`,
    `left=${left}`,
    `top=${top}`,
  ].join(",");

  const win = window.open("about:blank", name, features);
  if (!win) return null;
  try {
    try {
      win.resizeTo(w, h);
      win.moveTo(left, top);
    } catch {
      /* ignore */
    }
    const canvas = fillHud(win.document, { title, canvasId, cw, ch });
    try {
      win.focus();
    } catch {
      /* ignore */
    }
    return wrap(win, canvas, name);
  } catch (e) {
    console.warn("popout failed", e);
    try {
      win.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function tryUpgradePip(popup, { name, title, width, height, canvasId, cw, ch }) {
  if (!window.documentPictureInPicture?.requestWindow) return popup;
  if (pipHolder && !pipHolder.closed() && pipHolder._name !== name) return popup;

  try {
    const pos = loadPos(name);
    const w = Math.max(160, (pos?.w || width) | 0);
    const h = Math.max(120, (pos?.h || height) | 0);
    const win = await documentPictureInPicture.requestWindow({
      width: w,
      height: h,
      disallowReturnToOpener: true,
    });
    const canvas = fillHud(win.document, { title, canvasId, cw, ch });
    if (popup) popup.close();
    const api = wrap(win, canvas, name);
    api.kind = "pip";
    api._name = name;
    pipHolder = api;
    win.addEventListener("pagehide", () => {
      if (pipHolder === api) pipHolder = null;
    });
    return api;
  } catch (e) {
    console.warn("pip upgrade skipped", e);
    return popup;
  }
}

/** Call from checkbox click — opens popup in the same turn, then may upgrade to PiP. */
export async function openToolWindow(opts) {
  const cw = opts.canvasWidth || opts.width;
  const ch = opts.canvasHeight || opts.height;
  const args = { ...opts, cw, ch };

  // 1) sync — keeps user gesture for the popup blocker
  const popup = openViaPopup(args);
  if (!popup) return null;

  // 2) optional PiP upgrade (always-on-top / less chrome)
  return tryUpgradePip(popup, args);
}
