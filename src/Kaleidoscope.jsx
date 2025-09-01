import React, { useRef, useEffect, useState, useMemo } from 'react';

/**
 * Interactive Kaleidoscope — v1.6
 *
 * Focus:
 *  • Remove Render Quality (gone).
 *  • Keep FPS stable when Segments/Complexity > ~75%.
 *  • Fix flashes: stable DPR, safe clears, bounded numerics.
 *  • Big perf win: render ONE wedge per frame to offscreen bitmap, then stamp.
 *  • Precompute harmonic bases & angles (typed arrays), sublinear sample growth.
 */

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ===== Color utils =====
function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!m) return { r: 255, g: 255, b: 255 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function rgbToHex(r, g, b) {
  const to = (v) => v.toString(16).padStart(2, '0');
  return `#${to(clamp(Math.round(r), 0, 255))}${to(clamp(Math.round(b), 0, 255))}${to(clamp(Math.round(g), 0, 255))}`.replace('#', '#');
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}
function boostSaturation(hex, boost = 1.7) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const vibrance = 0.5;
  const s2 = clamp(s * (1 + vibrance * (1 - s)) * boost, 0, 1);
  const rgb = hslToRgb(h, s2, l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

// ===== Control mappers =====
const sliderGain = (x, k = 2.4) => { x = clamp(x, 0, 1); const d = 1 - Math.exp(-k); return (1 - Math.exp(-k * x)) / d; };
const sensShape = (s) => 0.22 + 0.50 * Math.pow(clamp(s, 0, 1), 1.15); // 0.22..0.72

export default function Kaleidoscope() {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const dprRef = useRef(1);

  // --- Controls ---
  const [segments, setSegments] = useState(12);
  const [colors, setColors] = useState(['#ff0055', '#00d2ff', '#ffd166']);
  const [complexity, setComplexity] = useState(6);

  const [run, setRun] = useState(true);
  const [patternUI, setPatternUI] = useState(0.6);
  const [rotationUI, setRotationUI] = useState(0.3); // -1..1
  const [swirlUI, setSwirlUI] = useState(0.5);
  const [sensitivityUI, setSensitivityUI] = useState(0.6);

  const [satBoost, setSatBoost] = useState(1.7);
  const [dprCap, setDprCap] = useState(1.75); // static DPR limit

  // Animation state (smoothed velocities)
  const stateRef = useRef({ t:0, rot:0, swirl:0, patV:0.4, rotV:0.12, swlV:0.4, fps:60, renderMs:0 });

  // Precompute boosted palette only when colors/satBoost change
  const palette = useMemo(() => Array.isArray(colors) ? colors.map((c, i) => (i === 0 ? c : boostSaturation(c, satBoost))) : ['#ffffff'], [colors, satBoost]);

  // Geometry cache (per L+theta+complexity)
  const geoRef = useRef({ key:'', sinAng:null, cosAng:null, t:null, sinPhi1:null, cosPhi1:null, sinPhi2:null, cosPhi2:null, sinPhi3:null, cosPhi3:null });

  // Offscreen wedge buffer
  const offRef = useRef({ canvas: null, ctx: null, size: 0, dpr: 1 });

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function fit() {
      const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
      dprRef.current = dpr;
      const cssW = canvas.clientWidth || window.innerWidth;
      const cssH = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    fit();
    const ro = new ResizeObserver(fit); ro.observe(canvas);

    // Speed caps
    const capPat = 1.8, capRot = 0.40, capSwl = 1.6;

    let last = performance.now();
    const loop = (now) => {
      const dtRaw = Math.max(0, (now - last) / 1000);
      const dt = Math.min(0.050, dtRaw);
      last = now;

      const S = stateRef.current;
      if (run) {
        const sens = sensShape(sensitivityUI);
        const tgtPat = capPat * sens * sliderGain(patternUI);
        const tgtRot = capRot * sens * sliderGain(Math.abs(rotationUI)) * Math.sign(rotationUI || 0);
        const tgtSwl = capSwl * sens * sliderGain(swirlUI);

        const a = 1 - Math.exp(-dt / 0.18);
        S.patV += (tgtPat - S.patV) * a;
        S.rotV += (tgtRot - S.rotV) * a;
        S.swlV += (tgtSwl - S.swlV) * a;

        S.t    += dt * S.patV;
        S.rot  += dt * S.rotV;
        S.swirl+= dt * S.swlV;

        // bound angles to avoid precision drift
        if (S.rot > TAU || S.rot < -TAU) S.rot = ((S.rot % TAU) + TAU) % TAU;
        if (S.t > 1e6 || S.t < -1e6) S.t = 0;
        if (S.swirl > 1e6 || S.swirl < -1e6) S.swirl = 0;
      }

      // Dimensions & per-frame constants
      const w = ctx.canvas.clientWidth, h = ctx.canvas.clientHeight;
      const radius = Math.min(w, h) * 0.55;
      const segs = clamp(segments|0, 2, 128);
      const theta = TAU / segs;

      // Samples per wedge — sublinear growth & segment-aware taper
      // Baseline chosen around segs≈12; as segs↑ (theta↓), we reduce L.
      const base = 320, perComp = 180;
      const thetaNorm = theta / (TAU / 12); // 1 at 12 segments, <1 when more segments
      const segTaper = Math.pow(clamp(thetaNorm, 0.25, 1), 0.75); // reduce work when many segments
      const L = Math.max(260, Math.floor((base + perComp * complexity) * segTaper));

      // Build geometry cache if needed
      const key = `${L}|${theta.toFixed(6)}|${complexity}`;
      const G = geoRef.current;
      if (G.key !== key) {
        G.key = key;
        G.t = new Float32Array(L+1);
        G.sinAng = new Float32Array(L+1);
        G.cosAng = new Float32Array(L+1);
        G.sinPhi1 = new Float32Array(L+1);
        G.cosPhi1 = new Float32Array(L+1);
        G.sinPhi2 = new Float32Array(L+1);
        G.cosPhi2 = new Float32Array(L+1);
        G.sinPhi3 = new Float32Array(L+1);
        G.cosPhi3 = new Float32Array(L+1);

        const spread = 2 + 0.15 * complexity;
        const k1 = 6 + complexity * 0.9;
        const k2 = 10 + complexity * 1.2;
        const k3 = 14 + complexity * 0.6;

        for (let j = 0; j <= L; j++) {
          const t = j / L; G.t[j] = t;
          const ang = (t - 0.5) * theta * spread;
          G.cosAng[j] = Math.cos(ang);
          G.sinAng[j] = Math.sin(ang);

          // precompute base phases (w/o time/swirl) for angle-add later
          const p1 = k1 * (t);
          const p2 = k2 * (t);
          const p3 = k3 * (t * 1.2);
          G.sinPhi1[j] = Math.sin(p1); G.cosPhi1[j] = Math.cos(p1);
          G.sinPhi2[j] = Math.sin(p2); G.cosPhi2[j] = Math.cos(p2);
          G.sinPhi3[j] = Math.sin(p3); G.cosPhi3[j] = Math.cos(p3);
        }
      }

      const t0 = performance.now();
      renderFrame(ctx, S, { palette, radius, theta, segments:segs, G, dpr: dprRef.current, offRef });
      S.renderMs = performance.now() - t0;

      // FPS EMA
      const instFps = dtRaw > 0 ? 1 / dtRaw : 60;
      S.fps += (instFps - S.fps) * 0.12;

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, [segments, colors, complexity, run, patternUI, rotationUI, swirlUI, sensitivityUI, satBoost, dprCap]);

  // UI helpers
  const updateColor = (index, value) => { setColors((cs) => cs.map((c, i) => (i === index ? value : c))); };
  const addColor = () => setColors((cs) => (cs.length >= 12 ? cs : [...cs, '#ffffff']));
  const removeColor = () => setColors((cs) => (cs.length <= 3 ? cs : cs.slice(0, -1)));

  const S = stateRef.current;
  const fmt = (x, d=2) => Number(x).toFixed(d);

  const sensEff = sensShape(sensitivityUI);
  const effPat = 1.8 * sensEff * sliderGain(patternUI);
  const effRot = 0.40 * sensEff * sliderGain(Math.abs(rotationUI)) * Math.sign(rotationUI||0);
  const effSwl = 1.6 * sensEff * sliderGain(swirlUI);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#0b0b0b' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '88vh', display: 'block', background: 'black' }} />

      <div style={{ position: 'absolute', top: 10, left: 10, background: '#0009', padding: 12, borderRadius: 12, color: '#fff', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13, display: 'grid', gap: 8, maxWidth: 560 }}>
        <div style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span>Kaleidoscope Controls (v1.6 — High‑seg/complexity optimizer)</span>
          <span style={{ opacity: 0.85 }}>FPS {fmt(S.fps,1)} · {fmt(S.renderMs,1)} ms</span>
        </div>

        <div>Segments: <input type="range" min={3} max={64} value={segments} onChange={(e)=>setSegments(Number(e.target.value))} /></div>
        <div>Complexity: <input type="range" min={1} max={16} value={complexity} onChange={(e)=>setComplexity(Number(e.target.value))} /></div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <label style={{ display:'flex', alignItems:'center', gap:6 }}>Run <input type="checkbox" checked={run} onChange={(e)=>setRun(e.target.checked)} /></label>

          <label>
            Sensitivity · {fmt(sensitivityUI,2)} (eff× {fmt(sensEff,2)})
            <input type="range" min={0} max={1} step={0.001} value={sensitivityUI} onChange={(e)=>setSensitivityUI(Number(e.target.value))} />
          </label>

          <label>
            Pattern Speed · eff {fmt(effPat,3)}
            <input type="range" min={0} max={1} step={0.001} value={patternUI} onChange={(e)=>setPatternUI(Number(e.target.value))} />
          </label>

          <label>
            Rotation Rate (rad/s) · eff {fmt(effRot,3)}
            <input type="range" min={-1} max={1} step={0.001} value={rotationUI} onChange={(e)=>setRotationUI(Number(e.target.value))} />
          </label>

          <label>
            Swirl Rate · eff {fmt(effSwl,3)}
            <input type="range" min={0} max={1} step={0.001} value={swirlUI} onChange={(e)=>setSwirlUI(Number(e.target.value))} />
          </label>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <label>
            Saturation Boost · {fmt(satBoost, 2)}
            <input type="range" min={1.0} max={2.2} step={0.01} value={satBoost} onChange={(e)=>setSatBoost(Number(e.target.value))} />
          </label>
          <label>
            DPR Cap · {fmt(dprCap,2)}
            <input type="range" min={1} max={2.5} step={0.01} value={dprCap} onChange={(e)=>setDprCap(Number(e.target.value))} />
          </label>
        </div>

        <div>
          Colors:
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap:6, marginTop:6 }}>
            {palette.map((c, i) => (
              <input key={i} type="color" value={colors[i]} onChange={(e)=>updateColor(i, e.target.value)} />
            ))}
          </div>
          <div style={{ display:'flex', gap:8, marginTop:6 }}>
            <button onClick={addColor}>+ Color</button>
            <button onClick={removeColor}>− Color</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== Rendering =====
function renderFrame(ctx, S, { palette, radius, theta, segments, G, dpr, offRef }) {
  // Clear safely in device pixels
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  // Build/update offscreen wedge
  const size = Math.ceil(radius * 2);
  let off = offRef.current;
  if (!off.canvas || off.size !== size || off.dpr !== dpr) {
    const offCanvas = ('OffscreenCanvas' in window) ? new OffscreenCanvas(size * dpr, size * dpr) : document.createElement('canvas');
    if (!(offCanvas instanceof OffscreenCanvas)) { offCanvas.width = size * dpr; offCanvas.height = size * dpr; }
    const offCtx = offCanvas.getContext('2d');
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    offRef.current = off = { canvas: offCanvas, ctx: offCtx, size, dpr };
  }

  // Paint the wedge once per frame
  const octx = off.ctx;
  octx.save();
  // clear offscreen
  octx.setTransform(1,0,0,1,0,0);
  octx.clearRect(0,0,off.canvas.width, off.canvas.height);
  octx.setTransform(dpr,0,0,dpr,0,0);

  octx.translate(size/2, size/2);
  drawWedge(octx, radius, S, palette, theta, G);
  octx.restore();

  // Stamp wedges around the circle
  ctx.save();
  ctx.translate(ctx.canvas.clientWidth/2, ctx.canvas.clientHeight/2);
  ctx.rotate(S.rot);
  for (let i = 0; i < segments; i++) {
    ctx.save();
    ctx.rotate(i * theta);
    if (i % 2) ctx.scale(1, -1);
    ctx.drawImage(off.canvas, -radius, -radius, size, size);
    ctx.restore();
  }
  ctx.restore();
}

function drawWedge(ctx, radius, S, colors, theta, G) {
  ctx.save();
  // Clip to wedge
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radius, -theta/2, theta/2);
  ctx.closePath();
  ctx.clip();

  const L = G.t.length - 1;
  const lw = 1.15; // simple & fast

  // Frame phases (angle-add)
  const a1 = 1.3 * S.t + 0.15 * Math.sin(S.swirl);
  const a2 = -0.7 * S.t + 0.20 * Math.cos(S.swirl * 0.7);
  const a3 = 0.9 * S.t + 0.05 * Math.sin(S.swirl * 1.4);
  const sa1 = Math.sin(a1), ca1 = Math.cos(a1);
  const sa2 = Math.sin(a2), ca2 = Math.cos(a2);
  const sa3 = Math.sin(a3), ca3 = Math.cos(a3);

  // One batched stroke per color
  const nColors = colors.length;
  for (let cIdx = 0; cIdx < nColors; cIdx++) {
    ctx.beginPath();
    let started = false;
    for (let j = 0; j <= L; j++) {
      const t = G.t[j];
      const idx = Math.floor(t * nColors) % nColors;
      if (idx !== cIdx) continue;

      const s1 = G.sinPhi1[j] * ca1 + G.cosPhi1[j] * sa1;
      const s2 = G.sinPhi2[j] * ca2 + G.cosPhi2[j] * sa2;
      const s3 = G.sinPhi3[j] * ca3 + G.cosPhi3[j] * sa3;

      const Rnorm = 0.55 + 0.30 * s1 + 0.15 * s2 + 0.10 * s3;
      const r = clamp(Rnorm, 0.05, 0.98) * radius;

      const x = G.cosAng[j] * r;
      const y = G.sinAng[j] * r;

      if (!started) { ctx.moveTo(x, y); started = true; }
      else { ctx.lineTo(x, y); }
    }
    if (started) {
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.strokeStyle = colors[cIdx];
      ctx.stroke();
    }
  }

  ctx.restore();
}
