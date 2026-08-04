/** Audio radar — angle/distance from sliders; live audio pulses magnitude. */

export function createAudioRadar() {
  let analyser = null;
  let data = null;
  let timeData = null;
  let audioCtx = null;
  let sourceNode = null;
  let hasAudio = false;
  let status = "no audio";

  /** Call from click handler BEFORE await getDisplayMedia — unlocks AudioContext. */
  async function warm() {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch {
        /* ignore */
      }
    }
    return audioCtx.state;
  }

  async function attachStream(stream) {
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        /* ignore */
      }
      sourceNode = null;
    }
    analyser = null;
    data = null;
    timeData = null;

    const tracks = stream?.getAudioTracks?.() || [];
    if (!tracks.length) {
      hasAudio = false;
      status = "no audio — zaznacz share audio";
      return false;
    }

    for (const t of tracks) {
      try {
        t.enabled = true;
      } catch {
        /* ignore */
      }
    }

    // wait briefly if track is still starting
    const live = tracks.filter((t) => t.readyState === "live");
    const use = live.length ? live : tracks;

    try {
      await warm();
      const audioOnly = new MediaStream(use);
      sourceNode = audioCtx.createMediaStreamSource(audioOnly);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      // keep graph alive (some browsers GC silent graphs)
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      sourceNode.connect(analyser);
      analyser.connect(gain);
      gain.connect(audioCtx.destination);

      data = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Uint8Array(analyser.fftSize);
      hasAudio = true;
      status = audioCtx.state === "running" ? "audio live" : "kliknij panel (resume)";
      return true;
    } catch (e) {
      console.warn("audio attach failed", e);
      hasAudio = false;
      status = "attach failed — share z audio jeszcze raz";
      return false;
    }
  }

  function stop() {
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        /* ignore */
      }
      sourceNode = null;
    }
    // keep AudioContext warm across re-shares (closing forces gesture again)
    analyser = null;
    data = null;
    timeData = null;
    hasAudio = false;
    status = "no audio";
  }

  function level() {
    if (!analyser || !timeData) return 0;
    analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    // also peek spectrum — game SFX often quiet in time domain after mix
    let peak = Math.sqrt(sum / timeData.length);
    if (data) {
      analyser.getByteFrequencyData(data);
      let s = 0;
      // skip very low bins (rumble) — focus footsteps/gun range-ish
      const n = data.length;
      for (let i = (n * 0.05) | 0; i < (n * 0.45) | 0; i++) s += data[i];
      const spec = s / ((n * 0.4) * 255);
      peak = Math.max(peak, spec);
    }
    return Math.min(1, peak * 5);
  }

  function draw(canvas, cfg) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(w / 2, h - 10, h - 22, Math.PI, 0);
    ctx.stroke();

    for (let i = 0; i <= 8; i++) {
      const a = Math.PI + (i / 8) * Math.PI;
      const r0 = h - 22;
      const x0 = w / 2 + Math.cos(a) * (r0 - 4);
      const y0 = h - 10 + Math.sin(a) * (r0 - 4);
      const x1 = w / 2 + Math.cos(a) * r0;
      const y1 = h - 10 + Math.sin(a) * r0;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    ctx.fillStyle = "#888";
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.fillText("audio radar", 8, 16);
    ctx.fillStyle = hasAudio ? "#6c6" : "#c66";
    ctx.fillText(status, 8, 30);

    const angSlider = (cfg.angle ?? 75) / 100;
    const distSlider = (cfg.distance ?? 35) / 100;
    const angle = Math.PI + angSlider * Math.PI;
    let mag = 0.2 + distSlider * 0.55;
    if (hasAudio) {
      const lvl = level();
      mag = Math.min(1, mag * 0.35 + lvl * 0.95);
      if (data) {
        analyser.getByteFrequencyData(data);
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        const bars = 24;
        const step = (data.length / bars) | 0;
        for (let i = 0; i < bars; i++) {
          let v = 0;
          for (let j = 0; j < step; j++) v += data[i * step + j];
          v = (v / step / 255) * 18;
          ctx.fillRect(8 + i * 6, h - 14 - v, 4, v);
        }
      }
    }

    const len = (h - 28) * mag;
    const x = w / 2 + Math.cos(angle) * len;
    const y = h - 10 + Math.sin(angle) * len;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2, h - 10);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w / 2, h - 10, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  async function resume() {
    if (audioCtx && audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
        if (hasAudio) status = "audio live";
      } catch {
        /* ignore */
      }
    }
  }

  return {
    warm,
    attachStream,
    stop,
    draw,
    resume,
    getHasAudio: () => hasAudio,
    getStatus: () => status,
  };
}
