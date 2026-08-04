/** Small always-movable desktop popups (separate browser windows). */

export function openToolWindow({
  name,
  title,
  width,
  height,
  canvasId = "view",
  canvasWidth,
  canvasHeight,
}) {
  const cw = canvasWidth || width;
  const ch = canvasHeight || height;
  const features = [
    "popup=yes",
    `width=${width}`,
    `height=${height}`,
    "left=80",
    "top=80",
  ].join(",");

  let win = window.open("about:blank", name, features);
  if (!win) return null;

  try {
    const doc = win.document;
    doc.open();
    doc.title = title;
    const style = doc.createElement("style");
    style.textContent = `
      html, body {
        margin: 0; width: 100%; height: 100%;
        background: #000; overflow: hidden; color: #888;
        font: 11px Segoe UI, sans-serif;
      }
      canvas { display: block; width: 100%; height: 100%; background: #000; }
    `;
    doc.head.appendChild(style);
    const canvas = doc.createElement("canvas");
    canvas.id = canvasId;
    canvas.width = cw;
    canvas.height = ch;
    doc.body.appendChild(canvas);
    doc.close();
    try {
      win.focus();
    } catch {
      /* ignore */
    }
    return {
      win,
      canvas,
      closed() {
        return !win || win.closed;
      },
      close() {
        try {
          if (win && !win.closed) win.close();
        } catch {
          /* ignore */
        }
        win = null;
      },
    };
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
