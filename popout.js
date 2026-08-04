/**
 * Detached tool windows (overlay / radar).
 * Styled like a frameless HUD (dark + yellow rule). OS may still draw a thin
 * titlebar — websites cannot remove it; Document PiP is used when possible
 * (always-on-top, rounded, minimal chrome) for the first window.
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

function fillHud(doc, { title, canvasId, cw, ch }) {
  doc.title = title;
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
    .cap {
      flex: 0 0 28px; height: 28px;
      background: #222;
    }
    .rule {
      flex: 0 0 3px; height: 3px;
      background: #e8c84a;
    }
    .stage {
      flex: 1 1 auto; min-height: 0;
      background: #000; position: relative;
    }
    canvas {
      display: block; width: 100%; height: 100%;
      background: #000;
    }
  `;
  doc.head.appendChild(style);
  const hud = doc.createElement("div");
  hud.className = "hud";
  hud.innerHTML = `<div class="cap"></div><div class="rule"></div><div class="stage"></div>`;
  const canvas = doc.createElement("canvas");
  canvas.id = canvasId;
  canvas.width = cw;
  canvas.height = ch;
  hud.querySelector(".stage").appendChild(canvas);
  doc.body.appendChild(hud);
  return canvas;
}

function wrap(win, canvas, name) {
  let timer = null;
  const tick = () => {
    savePos(name, win);
    if (!win || win.closed) {
      if (timer) clearInterval(timer);
      return;
    }
  };
  timer = setInterval(tick, 400);
  try {
    win.addEventListener("pagehide", () => savePos(name, win));
  } catch {
    /* ignore */
  }
  return {
    win,
    canvas,
    kind: "popup",
    closed() {
      return !win || win.closed;
    },
    close() {
      savePos(name, win);
      if (timer) clearInterval(timer);
      try {
        if (win && !win.closed) win.close();
      } catch {
        /* ignore */
      }
      win = null;
    },
  };
}

let pipHolder = null; // only one Document PiP allowed by Chrome

async function openViaPip({ name, title, width, height, canvasId, cw, ch }) {
  if (!window.documentPictureInPicture?.requestWindow) return null;
  // Chrome: one document PiP at a time
  if (pipHolder && !pipHolder.closed()) {
    if (pipHolder._name === name) return pipHolder;
    return null;
  }
  const pos = loadPos(name);
  const w = Math.max(160, (pos?.w || width) | 0);
  const h = Math.max(120, (pos?.h || height) | 0);
  const win = await documentPictureInPicture.requestWindow({
    width: w,
    height: h,
    disallowReturnToOpener: true,
    preferInitialWindowPlacement: false, // reuse last PiP place
  });
  const canvas = fillHud(win.document, { title, canvasId, cw, ch });
  const api = wrap(win, canvas, name);
  api.kind = "pip";
  api._name = name;
  pipHolder = api;
  win.addEventListener("pagehide", () => {
    if (pipHolder === api) pipHolder = null;
  });
  return api;
}

function openViaPopup({ name, title, width, height, canvasId, cw, ch }) {
  const pos = loadPos(name);
  const w = Math.max(160, (pos?.w || width) | 0);
  const h = Math.max(120, (pos?.h || height) | 0);
  const left = pos?.x != null ? pos.x | 0 : 80;
  const top = pos?.y != null ? pos.y | 0 : 80;
  const features = [
    "popup=yes",
    `width=${w}`,
    `height=${h}`,
    `left=${left}`,
    `top=${top}`,
    "toolbar=no",
    "location=no",
    "status=no",
    "menubar=no",
    "scrollbars=no",
  ].join(",");

  let win = window.open("about:blank", name, features);
  if (!win) return null;
  try {
    try {
      win.resizeTo(w, h);
      win.moveTo(left, top);
    } catch {
      /* some browsers block move */
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

/**
 * Must be called from a direct user gesture (checkbox click), not after await.
 * Prefers Document PiP (looks like the HUD screenshot); falls back to popup.
 */
export async function openToolWindow(opts) {
  const cw = opts.canvasWidth || opts.width;
  const ch = opts.canvasHeight || opts.height;
  const args = { ...opts, cw, ch };
  try {
    const pip = await openViaPip(args);
    if (pip) return pip;
  } catch (e) {
    console.warn("pip failed", e);
  }
  return openViaPopup(args);
}
