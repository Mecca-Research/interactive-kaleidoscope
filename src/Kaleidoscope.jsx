import React, { useRef, useEffect, useState } from 'react';

/**
 * Interactive Kaleidoscope Generator — v1.1
 * Improvements:
 *  • Retina/high‑res rendering (DPR aware) so fine detail is crisp
 *  • Exaggerated textures (harmonic combos + swirl phase + time)
 *  • Color system FIXED: added colors now visibly affect strokes
 *    (segment‑batched stroking instead of one giant path)
 *  • New animation engine with explicit dt physics
 *    - Separate patternSpeed, rotationSpeed, swirlRate
 *    - Zoom: on/off, direction (in/out), speed slider
 *  • Safer resize, stable rAF
 */

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export default function Kaleidoscope() {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const dprRef = useRef(1);

  // Controls
  const [segments, setSegments] = useState(12);
  const [colors, setColors] = useState(['#ff0055', '#00d2ff', '#ffd166']);
  const [complexity, setComplexity] = useState(6); // harmonic layers

  // Animation parameters
  const [run, setRun] = useState(true);
  const [patternSpeed, setPatternSpeed] = useState(1.0);      // affects internal texture time
  const [rotationSpeed, setRotationSpeed] = useState(0.25);   // rad/s
  const [swirlRate, setSwirlRate] = useState(0.6);            // swirl phase speed

  // Zoom controls
  const [zoomEnabled, setZoomEnabled] = useState(false);
  const [zoomDirection, setZoomDirection] = useState('in'); // 'in' | 'out'
  const [zoomSpeed, setZoomSpeed] = useState(0.25);         // per second

  // Internal animation state
  const stateRef = useRef({
    t: 0,            // pattern time
    rot: 0,          // global rotation
    swirl: 0,        // swirl phase
    zoom: 1,         // camera zoom
    panX: 0,
    panY: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // HiDPI fit
    function fit() {
      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      dprRef.current = dpr;
      const cssW = canvas.clientWidth || window.innerWidth;
      const cssH = canvas.clientHeight || window.innerHeight;
      const needW = Math.floor(cssW * dpr);
      const needH = Math.floor(cssH * dpr);
      if (canvas.width !== needW || canvas.height !== needH) {
        canvas.width = needW; canvas.height = needH;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
      }
    }
    fit();
    const ro = new ResizeObserver(fit); ro.observe(canvas);

    let last = performance.now();
    const loop = (now) => {
      const dt = Math.max(0, (now - last) / 1000); // seconds
      last = now;

      const S = stateRef.current;
      if (run) {
        S.t += dt * patternSpeed;
        S.rot += dt * rotationSpeed;
        S.swirl += dt * swirlRate;
        if (zoomEnabled) {
          const dir = zoomDirection === 'in' ? 1 : -1;
          S.zoom = clamp(S.zoom * Math.exp(dir * zoomSpeed * dt), 0.25, 4);
        }
      }

      renderFrame(ctx, S, { segments, colors, complexity });
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, [segments, colors, complexity, run, patternSpeed, rotationSpeed, swirlRate, zoomEnabled, zoomDirection, zoomSpeed]);

  // ---- UI helpers ----
  const updateColor = (index, value) => {
    setColors((cs) => cs.map((c, i) => (i === index ? value : c)));
  };
  const addColor = () => setColors((cs) => (cs.length >= 12 ? cs : [...cs, '#ffffff']));
  const removeColor = () => setColors((cs) => (cs.length <= 3 ? cs : cs.slice(0, -1)));

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#0b0b0b' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '88vh', display: 'block', background: 'black' }} />

      <div style={{ position: 'absolute', top: 10, left: 10, background: '#0009', padding: 12, borderRadius: 12, color: '#fff', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13, display: 'grid', gap: 8, maxWidth: 420 }}>
        <div style={{ fontWeight: 700 }}>Kaleidoscope Controls (v1.1)</div>
        <div>Segments: <input type="range" min={3} max={64} value={segments} onChange={(e)=>setSegments(Number(e.target.value))} /></div>
        <div>Complexity: <input type="range" min={1} max={16} value={complexity} onChange={(e)=>setComplexity(Number(e.target.value))} /></div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <label>Run <input type="checkbox" checked={run} onChange={(e)=>setRun(e.target.checked)} /></label>
          <label>Pattern Speed <input type="range" min={0} max={3} step={0.01} value={patternSpeed} onChange={(e)=>setPatternSpeed(Number(e.target.value))} /></label>
          <label>Rotation Rate (rad/s) <input type="range" min={-2} max={2} step={0.01} value={rotationSpeed} onChange={(e)=>setRotationSpeed(Number(e.target.value))} /></label>
          <label>Swirl Rate <input type="range" min={0} max={4} step={0.01} value={swirlRate} onChange={(e)=>setSwirlRate(Number(e.target.value))} /></label>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'auto 1fr', alignItems:'center', gap:8 }}>
          <label>Zoom</label>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <label><input type="checkbox" checked={zoomEnabled} onChange={(e)=>setZoomEnabled(e.target.checked)} /> Enabled</label>
            <select value={zoomDirection} onChange={(e)=>setZoomDirection(e.target.value)}>
              <option value="in">In</option>
              <option value="out">Out</option>
            </select>
            <input type="range" min={0} max={2} step={0.01} value={zoomSpeed} onChange={(e)=>setZoomSpeed(Number(e.target.value))} />
          </div>
        </div>

        <div>
          Colors:
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap:6, marginTop:6 }}>
            {colors.map((c, i) => (
              <input key={i} type="color" value={c} onChange={(e)=>updateColor(i, e.target.value)} />
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

// ================== Rendering ==================
function renderFrame(ctx, S, { segments, colors, complexity }) {
  const w = ctx.canvas.clientWidth;
  const h = ctx.canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // Center + rotate + zoom
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(S.rot);
  ctx.scale(S.zoom, S.zoom);

  const radius = Math.min(w, h) * 0.55;
  const theta = TAU / clamp(segments|0, 2, 128);

  for (let i = 0; i < segments; i++) {
    ctx.save();
    ctx.rotate(i * theta);
    if (i % 2) ctx.scale(1, -1); // mirror alternate wedge
    drawWedge(ctx, radius, S, colors, complexity, theta);
    ctx.restore();
  }

  ctx.restore();
}

function drawWedge(ctx, radius, S, colors, complexity, theta) {
  // Clip to wedge (-theta/2 .. +theta/2)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radius, -theta/2, theta/2);
  ctx.closePath();
  ctx.clip();

  // Exaggerated texture: multi‑harmonic radial curve with time & swirl
  const L = Math.max(600, complexity * 450); // samples per wedge (resolution)
  const baseLW = Math.max(0.75, 2.5 / (S.zoom));

  let prev = null;
  let prevColorIndex = -1;
  for (let j = 0; j <= L; j++) {
    const t = j / L;
    const ang = (t - 0.5) * theta * (2 + 0.15 * complexity); // spread inside wedge

    // Harmonic radial field (exaggerated)
    const k1 = 6 + complexity * 0.9;
    const k2 = 10 + complexity * 1.2;
    const k3 = 14 + complexity * 0.6;
    const swirl = S.swirl;
    const Rnorm = 0.55
      + 0.30 * Math.sin(k1 * (t + 0.15 * Math.sin(swirl)) + 1.3 * S.t)
      + 0.15 * Math.cos(k2 * (t + 0.20 * Math.cos(swirl * 0.7)) - 0.7 * S.t)
      + 0.10 * Math.sin(k3 * (t * 1.2 + 0.05 * Math.sin(swirl * 1.4)) + 0.9 * S.t);

    const r = clamp(Rnorm, 0.05, 0.98) * radius;
    const pt = { x: Math.cos(ang) * r, y: Math.sin(ang) * r };

    // Decide color for this segment
    const colorIndex = Math.floor(t * colors.length) % colors.length;
    const color = colors[colorIndex];

    // Batch by color: when color changes, stroke the previous batch
    if (prev && colorIndex !== prevColorIndex) {
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineWidth = baseLW * (1 + 0.35 * Math.sin(6 * t + S.t));
      ctx.strokeStyle = color;
    }

    if (!prev) {
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineWidth = baseLW;
      ctx.strokeStyle = color;
    } else {
      ctx.lineTo(pt.x, pt.y);
    }

    prev = pt;
    prevColorIndex = colorIndex;
  }

  // Final stroke
  if (prev) ctx.stroke();
  ctx.restore();
}
