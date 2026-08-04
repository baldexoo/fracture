/** Detection overlay — crop around crosshair + line to target (drawn into any canvas). */

export function createOverlay() {
  function draw(canvas, sourceCanvas, target) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    if (!sw || !sh) {
      ctx.fillStyle = "#666";
      ctx.font = "12px sans-serif";
      ctx.fillText("waiting for screen…", 12, ch / 2);
      return;
    }

    const cropW = Math.min(sw, Math.max(80, (sw * 0.22) | 0));
    const cropH = Math.min(sh, Math.max(60, (sh * 0.22) | 0));
    const sx = Math.max(0, ((sw - cropW) / 2) | 0);
    const sy = Math.max(0, ((sh - cropH) / 2) | 0);

    ctx.drawImage(sourceCanvas, sx, sy, cropW, cropH, 0, 0, cw, ch);

    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.moveTo(cw / 2, 0);
    ctx.lineTo(cw / 2, ch);
    ctx.moveTo(0, ch / 2);
    ctx.lineTo(cw, ch / 2);
    ctx.stroke();

    if (target) {
      const tx = ((target.x - sx) / cropW) * cw;
      const ty = ((target.y - sy) / cropH) * ch;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cw / 2, ch / 2);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(tx, ty, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { draw };
}
