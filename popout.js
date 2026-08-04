/**
 * Detached HUD windows — open real same-origin HTML (not about:blank).
 * Must be called synchronously from a click/change handler.
 */
const POS_KEY = "fracture.popout.pos.v1";

function loadPos(name) {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) || "{}")[name] || null;
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

function wrap(win, canvas, name) {
  let alive = win;
  const timer = setInterval(() => {
    if (!alive || alive.closed) {
      clearInterval(timer);
      return;
    }
    savePos(name, alive);
  }, 500);
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

/**
 * @param {{ name: string, page: string, width: number, height: number }} opts
 * @returns {{ win: Window, canvas: HTMLCanvasElement, closed: Function, close: Function } | null}
 */
export function openToolWindow({ name, page, width, height }) {
  const pos = loadPos(name);
  const w = Math.max(200, (pos?.w || width) | 0);
  const h = Math.max(160, (pos?.h || height) | 0);
  const left = pos?.x != null ? pos.x | 0 : Math.max(40, ((screen.availWidth - w) / 3) | 0);
  const top = pos?.y != null ? pos.y | 0 : Math.max(40, ((screen.availHeight - h) / 4) | 0);

  const url = new URL(page, location.href);
  url.searchParams.set("v", "2");

  const features = `popup=yes,width=${w},height=${h},left=${left},top=${top}`;
  const win = window.open(url.href, name, features);
  if (!win) return null;

  try {
    win.focus();
  } catch {
    /* ignore */
  }

  // canvas may not exist for a tick while the page loads
  let canvas = null;
  try {
    canvas = win.document?.getElementById("view") || null;
  } catch {
    canvas = null;
  }

  const api = wrap(win, canvas, name);

  const bindCanvas = () => {
    try {
      const c = win.document?.getElementById("view");
      if (c) api.canvas = c;
    } catch {
      /* ignore */
    }
  };
  const iv = setInterval(() => {
    if (!win || win.closed) {
      clearInterval(iv);
      return;
    }
    bindCanvas();
    if (api.canvas) clearInterval(iv);
  }, 50);
  setTimeout(() => clearInterval(iv), 3000);

  try {
    win.addEventListener("load", bindCanvas);
  } catch {
    /* ignore */
  }

  return api;
}
