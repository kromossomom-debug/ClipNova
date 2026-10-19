// Frame compositor shared by the live preview and the exporter.
import { activeClips, clipDuration, kfValues, clamp, easeOut, easeInOut, FILTERS } from './model.js';

const FILTER_MAP = Object.fromEntries(FILTERS.map((f) => [f.id, f]));
const measureCtx = document.createElement('canvas').getContext('2d');

export function textFont(c, H) {
  const px = Math.max(1, c.size * H);
  return { px, font: `${c.italic ? 'italic ' : ''}${c.bold ? '700' : '400'} ${px}px "${c.font}", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif` };
}

export function textLayout(c, H, ctx = measureCtx) {
  const { px, font } = textFont(c, H);
  ctx.font = font;
  ctx.letterSpacing = `${(c.letterSpacing || 0) * px * 0.1}px`;
  const lines = String(c.text ?? '').split('\n');
  const widths = lines.map((l) => ctx.measureText(l || ' ').width);
  const pad = (c.bg?.padding ?? 0.3) * px;
  const lineH = px * (c.lineHeight || 1.2);
  return { px, font, lines, widths, pad, lineH, w: Math.max(...widths) + pad * 2, h: lines.length * lineH + pad * 2 };
}

// Unanimated box of a visual clip in canvas pixels (center, size, rotation) — used for drawing and hit testing.
export function clipBox(c, t, W, H, src) {
  const kv = kfValues(c, t);
  const box = { cx: W / 2 + kv.x * W, cy: H / 2 + kv.y * H, rot: (kv.rotation * Math.PI) / 180, w: 0, h: 0, kv };
  if (c.type === 'text') {
    const L = textLayout(c, H);
    box.w = L.w * kv.scale; box.h = L.h * kv.scale;
  } else if (c.type === 'sticker') {
    box.w = box.h = c.size * H * kv.scale * 1.15;
  } else if (src) {
    const cr = c.crop || { l: 0, t: 0, r: 0, b: 0 };
    const s0 = Math.min(W / src.w, H / src.h);
    box.sx = cr.l * src.w; box.sy = cr.t * src.h;
    box.sw = Math.max(1, (1 - cr.l - cr.r) * src.w); box.sh = Math.max(1, (1 - cr.t - cr.b) * src.h);
    box.w = box.sw * s0 * kv.scale; box.h = box.sh * s0 * kv.scale;
  }
  return box;
}

function lerp(a, b, p) { return a + (b - a) * p; }

function cssFilter(c, W) {
  const a = c.adjust || {};
  const fp = FILTER_MAP[c.filter?.name] || FILTER_MAP.none;
  const f = fp.f || {};
  const i = c.filter?.intensity ?? 1;
  const parts = [];
  const br = (1 + (a.brightness || 0) * 0.5) * lerp(1, f.brightness ?? 1, i);
  const ct = (1 + (a.contrast || 0) * 0.6) * lerp(1, f.contrast ?? 1, i);
  const sa = (1 + (a.saturation || 0)) * lerp(1, f.saturate ?? 1, i);
  const se = (f.sepia || 0) * i, gr = (f.grayscale || 0) * i;
  const hue = (a.hue || 0) + (f.hue || 0) * i;
  const bl = (a.blur || 0) * W * 0.02;
  if (Math.abs(br - 1) > 1e-3) parts.push(`brightness(${br.toFixed(3)})`);
  if (Math.abs(ct - 1) > 1e-3) parts.push(`contrast(${ct.toFixed(3)})`);
  if (Math.abs(sa - 1) > 1e-3) parts.push(`saturate(${sa.toFixed(3)})`);
  if (se > 0) parts.push(`sepia(${se.toFixed(3)})`);
  if (gr > 0) parts.push(`grayscale(${gr.toFixed(3)})`);
  if (Math.abs(hue) > 0.01) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
  if (bl > 0.05) parts.push(`blur(${bl.toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

function washes(c) {
  const out = [];
  const a = c.adjust || {};
  const fp = FILTER_MAP[c.filter?.name];
  if (fp?.tint) out.push([fp.tint[0], fp.tint[1] * (c.filter.intensity ?? 1)]);
  if (a.temperature > 0) out.push(['#ff9b3d', a.temperature * 0.25]);
  if (a.temperature < 0) out.push(['#3d8bff', -a.temperature * 0.25]);
  if (a.tint > 0) out.push(['#ff3dd6', a.tint * 0.18]);
  if (a.tint < 0) out.push(['#3dff7a', -a.tint * 0.18]);
  return out;
}

function hexRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

const backOut = (p) => { const s = 1.70158; return 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2); };

export function animState(c, t) {
  const st = { alpha: 1, dx: 0, dy: 0, scale: 1, rot: 0, blur: 0, reveal: 1 };
  const anim = c.anim;
  if (!anim) return st;
  const dur = clipDuration(c);
  const rel = t - c.start;
  const apply = (type, q, dir, pRaw) => {
    switch (type) {
      case 'fade': st.alpha *= 1 - q; break;
      case 'slide-left': st.dx += 0.6 * q * dir; st.alpha *= 1 - q * 0.3; break;
      case 'slide-right': st.dx -= 0.6 * q * dir; st.alpha *= 1 - q * 0.3; break;
      case 'slide-up': st.dy += 0.4 * q * dir; st.alpha *= 1 - q * 0.3; break;
      case 'slide-down': st.dy -= 0.4 * q * dir; st.alpha *= 1 - q * 0.3; break;
      case 'zoom-in': st.scale *= dir > 0 ? 1 - 0.7 * q : 1 + 0.8 * q; st.alpha *= 1 - q; break;
      case 'zoom-out': st.scale *= dir > 0 ? 1 + 0.8 * q : 1 - 0.7 * q; st.alpha *= 1 - q; break;
      case 'pop': st.scale *= Math.max(0.001, backOut(pRaw)); st.alpha *= Math.min(1, pRaw * 3); break;
      case 'spin': st.rot += Math.PI * q * dir; st.scale *= 1 - 0.6 * q; st.alpha *= 1 - q; break;
      case 'blur': st.blur += q; st.alpha *= 1 - q * 0.5; break;
      case 'typewriter': st.reveal = pRaw; break;
    }
  };
  const ai = anim.in, ao = anim.out;
  const din = Math.min(ai?.dur || 0, dur), dout = Math.min(ao?.dur || 0, dur);
  if (ai && ai.type !== 'none' && rel < din) { const p = clamp(rel / din, 0, 1); apply(ai.type, 1 - easeOut(p), 1, p); }
  if (ao && ao.type !== 'none' && rel > dur - dout) { const p = clamp((rel - (dur - dout)) / dout, 0, 1); apply(ao.type, easeInOut(p), -1, 1 - p); }
  const lp = anim.loop;
  if (lp && lp.type !== 'none') {
    const ph = rel * (lp.speed || 1);
    switch (lp.type) {
      case 'pulse': st.scale *= 1 + 0.06 * Math.sin(2 * Math.PI * ph); break;
      case 'wobble': st.rot += 0.08 * Math.sin(2 * Math.PI * ph); break;
      case 'float': st.dy += 0.015 * Math.sin(2 * Math.PI * ph); break;
      case 'shake': st.dx += 0.006 * Math.sin(37 * ph); st.dy += 0.006 * Math.cos(29 * ph); break;
      case 'blink': st.alpha *= 0.55 + 0.45 * Math.cos(2 * Math.PI * ph); break;
    }
  }
  return st;
}

function makeNoise() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const img = x.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

export class Renderer {
  constructor() { this.slots = {}; this.noise = makeNoise(); }

  slot(name, W, H) {
    let c = this.slots[name];
    if (!c) { c = document.createElement('canvas'); this.slots[name] = c; }
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const x = c.getContext('2d', { willReadFrequently: name === 'layer' || name === 'fx' });
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none'; x.shadowColor = 'transparent';
    x.clearRect(0, 0, W, H);
    return c;
  }

  // sources: clip -> { el, w, h } | null
  render(ctx, project, t, sources) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.fillStyle = project.background.color || '#000';
    ctx.fillRect(0, 0, W, H);
    const main = project.tracks[0];
    if (project.background.mode === 'blur' && !main.hidden) {
      const c = activeClips(main, t)[0];
      const s = c && sources(c);
      if (s) {
        const sc = Math.max(W / s.w, H / s.h) * 1.1;
        ctx.filter = `blur(${(project.background.blur * W * 0.04).toFixed(1)}px)`;
        ctx.drawImage(s.el, W / 2 - (s.w * sc) / 2, H / 2 - (s.h * sc) / 2, s.w * sc, s.h * sc);
        ctx.filter = 'none';
      }
    }
    for (const track of project.tracks) {
      if (track.hidden || track.kind === 'audio') continue;
      const act = activeClips(track, t);
      if (track.kind === 'effect') { for (const c of act) this.applyEffect(ctx, c, t); continue; }
      if (track.kind === 'main' && act.length >= 2) {
        act.sort((a, b) => a.start - b.start);
        const A = act[0], B = act[1];
        const d = A._trDur || 0.0001;
        const p = clamp((t - B.start) / d, 0, 1);
        const ca = this.slot('ta', W, H), cb = this.slot('tb', W, H);
        this.drawClip(ca.getContext('2d'), A, t, sources);
        this.drawClip(cb.getContext('2d'), B, t, sources);
        this.transition(ctx, ca, cb, A.transition.type, easeInOut(p), W, H);
        continue;
      }
      for (const c of act) this.drawClip(ctx, c, t, sources);
    }
    ctx.restore();
  }

  drawClip(ctx, c, t, sources) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const src = c.type === 'video' || c.type === 'image' ? sources(c) : null;
    if ((c.type === 'video' || c.type === 'image') && !src) return;
    const anim = animState(c, t);
    const L = this.slot('layer', W, H);
    const l = L.getContext('2d', { willReadFrequently: true });
    const box = clipBox(c, t, W, H, src);
    l.save();
    l.translate(box.cx, box.cy);
    l.rotate(box.rot);
    l.scale(c.flipX ? -1 : 1, c.flipY ? -1 : 1);
    if (src) {
      l.filter = cssFilter(c, W);
      l.drawImage(src.el, box.sx, box.sy, box.sw, box.sh, -box.w / 2, -box.h / 2, box.w, box.h);
      l.filter = 'none';
    } else if (c.type === 'text') {
      l.scale(box.kv.scale, box.kv.scale);
      this.drawText(l, c, H, anim.reveal);
    } else if (c.type === 'sticker') {
      const px = c.size * H * box.kv.scale;
      l.font = `${px}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif`;
      l.textAlign = 'center'; l.textBaseline = 'middle';
      l.filter = cssFilter(c, W);
      l.fillText(c.text, 0, px * 0.05);
    }
    l.restore();

    if (src && c.chroma?.on) this.chromaKey(l, c, box, W, H);
    if (src && c.mask && c.mask.type !== 'none') this.applyMask(l, c, box, W, H);
    const ws = washes(c);
    if (ws.length || c.adjust?.vignette > 0) {
      l.save();
      l.globalCompositeOperation = 'source-atop';
      for (const [col, a] of ws) { l.globalAlpha = clamp(a, 0, 1); l.fillStyle = col; l.fillRect(0, 0, W, H); }
      if (c.adjust?.vignette > 0) {
        l.globalAlpha = 1;
        const g = l.createRadialGradient(box.cx, box.cy, Math.min(box.w, box.h) * 0.25, box.cx, box.cy, Math.hypot(box.w, box.h) * 0.55);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, `rgba(0,0,0,${c.adjust.vignette})`);
        l.fillStyle = g; l.fillRect(0, 0, W, H);
      }
      l.restore();
    }

    ctx.save();
    ctx.globalAlpha = clamp(box.kv.opacity * anim.alpha, 0, 1);
    ctx.globalCompositeOperation = c.blend || 'source-over';
    if (anim.blur > 0.001) ctx.filter = `blur(${(anim.blur * W * 0.02).toFixed(2)}px)`;
    ctx.translate(box.cx + anim.dx * W, box.cy + anim.dy * H);
    ctx.rotate(anim.rot);
    ctx.scale(anim.scale, anim.scale);
    ctx.translate(-box.cx, -box.cy);
    ctx.drawImage(L, 0, 0);
    ctx.restore();
  }

  drawText(l, c, H, reveal = 1) {
    const L = textLayout(c, H, l);
    l.textBaseline = 'middle';
    l.textAlign = c.align || 'center';
    if (c.bg && c.bg.opacity > 0) {
      l.save();
      l.globalAlpha = c.bg.opacity;
      l.fillStyle = c.bg.color;
      l.beginPath();
      l.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, (c.bg.radius || 0) * L.px);
      l.fill();
      l.restore();
    }
    const total = L.lines.reduce((s, x) => s + x.length, 0);
    let budget = reveal >= 1 ? Infinity : Math.floor(total * reveal);
    const ax = c.align === 'left' ? -L.w / 2 + L.pad : c.align === 'right' ? L.w / 2 - L.pad : 0;
    L.lines.forEach((line, i) => {
      const txt = budget === Infinity ? line : line.slice(0, Math.max(0, budget));
      if (budget !== Infinity) budget -= line.length;
      if (!txt) return;
      const y = -L.h / 2 + L.pad + L.lineH * (i + 0.5);
      if (c.glow && c.glow.opacity > 0) {
        l.save();
        l.shadowColor = c.glow.color; l.shadowBlur = L.px * 0.6 * c.glow.opacity;
        l.fillStyle = c.color;
        l.fillText(txt, ax, y); l.fillText(txt, ax, y);
        l.restore();
      }
      l.save();
      if (c.shadow && c.shadow.opacity > 0) {
        const [r, g, b] = hexRgb(c.shadow.color || '#000000');
        l.shadowColor = `rgba(${r},${g},${b},${c.shadow.opacity})`;
        l.shadowBlur = c.shadow.blur * L.px;
        const ang = ((c.shadow.angle ?? 45) * Math.PI) / 180;
        l.shadowOffsetX = Math.cos(ang) * c.shadow.distance * L.px;
        l.shadowOffsetY = Math.sin(ang) * c.shadow.distance * L.px;
      }
      if (c.stroke && c.stroke.width > 0) {
        l.lineJoin = 'round'; l.miterLimit = 2;
        l.lineWidth = c.stroke.width * L.px * 0.3;
        l.strokeStyle = c.stroke.color;
        l.strokeText(txt, ax, y);
        l.shadowColor = 'transparent';
      }
      l.fillStyle = c.color;
      l.fillText(txt, ax, y);
      l.restore();
      if (c.underline) {
        const w = l.measureText(txt).width;
        const x0 = c.align === 'left' ? ax : c.align === 'right' ? ax - w : ax - w / 2;
        l.fillStyle = c.color;
        l.fillRect(x0, y + L.px * 0.45, w, Math.max(1, L.px * 0.06));
      }
    });
  }

  chromaKey(l, c, box, W, H) {
    const r = Math.hypot(box.w, box.h) / 2 + 2;
    const x0 = Math.max(0, Math.floor(box.cx - r)), y0 = Math.max(0, Math.floor(box.cy - r));
    const x1 = Math.min(W, Math.ceil(box.cx + r)), y1 = Math.min(H, Math.ceil(box.cy + r));
    if (x1 <= x0 || y1 <= y0) return;
    const img = l.getImageData(x0, y0, x1 - x0, y1 - y0);
    const d = img.data;
    const [kr, kg, kb] = hexRgb(c.chroma.color);
    const kcb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
    const kcr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
    const lo = c.chroma.strength * 120, hi = lo + Math.max(1, c.chroma.smooth * 120);
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const cb = -0.168736 * R - 0.331264 * G + 0.5 * B;
      const cr = 0.5 * R - 0.418688 * G - 0.081312 * B;
      const dist = Math.hypot(cb - kcb, cr - kcr);
      if (dist < hi) {
        const a = dist <= lo ? 0 : (dist - lo) / (hi - lo);
        d[i + 3] = d[i + 3] * a;
        // spill suppression: pull the key channel toward the others
        if (kg >= kr && kg >= kb) d[i + 1] = Math.min(G, Math.max(R, B));
        else if (kb >= kr) d[i + 2] = Math.min(B, Math.max(R, G));
      }
    }
    l.putImageData(img, x0, y0);
  }

  applyMask(l, c, box, W, H) {
    const m = c.mask;
    const M = this.slot('mask', W, H);
    const x = M.getContext('2d');
    x.save();
    x.translate(box.cx, box.cy);
    x.rotate(box.rot);
    x.translate(m.x * box.w, m.y * box.h);
    x.rotate((m.rotation * Math.PI) / 180);
    const mw = m.w * box.w, mh = m.h * box.h, big = (W + H) * 4;
    if (m.feather > 0) x.filter = `blur(${(m.feather * Math.min(box.w, box.h) * 0.15).toFixed(1)}px)`;
    x.fillStyle = '#fff';
    x.beginPath();
    if (m.type === 'circle') x.ellipse(0, 0, Math.max(1, mw / 2), Math.max(1, mh / 2), 0, 0, Math.PI * 2);
    else if (m.type === 'rect') x.roundRect(-mw / 2, -mh / 2, mw, mh, Math.min(mw, mh) * 0.08);
    else if (m.type === 'linear') x.rect(-big, -big, big * 2, big);
    else if (m.type === 'band') x.rect(-big, -mh / 2, big * 2, mh);
    else if (m.type === 'heart') {
      const s = Math.min(mw, mh) / 2;
      x.moveTo(0, s * 0.9);
      x.bezierCurveTo(-s * 1.6, -s * 0.1, -s * 0.7, -s * 1.3, 0, -s * 0.45);
      x.bezierCurveTo(s * 0.7, -s * 1.3, s * 1.6, -s * 0.1, 0, s * 0.9);
    } else if (m.type === 'star') {
      const R = Math.min(mw, mh) / 2, r = R * 0.45;
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R;
        x.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      x.closePath();
    }
    x.fill();
    x.restore();
    l.save();
    l.globalCompositeOperation = m.invert ? 'destination-out' : 'destination-in';
    l.drawImage(M, 0, 0);
    l.restore();
  }

  transition(ctx, A, B, type, p, W, H) {
    const draw = (cv, alpha = 1, dx = 0, dy = 0, s = 1, rot = 0, blur = 0) => {
      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1);
      if (blur > 0.05) ctx.filter = `blur(${blur.toFixed(1)}px)`;
      ctx.translate(W / 2 + dx, H / 2 + dy); ctx.rotate(rot); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2);
      ctx.drawImage(cv, 0, 0);
      ctx.restore();
    };
    const clipDraw = (cv, pathFn) => { ctx.save(); ctx.beginPath(); pathFn(); ctx.clip(); ctx.drawImage(cv, 0, 0); ctx.restore(); };
    switch (type) {
      case 'black': case 'white': {
        draw(p < 0.5 ? A : B);
        ctx.save(); ctx.globalAlpha = 1 - Math.abs(p - 0.5) * 2; ctx.fillStyle = type === 'black' ? '#000' : '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore();
        break;
      }
      case 'slide-left': draw(A); draw(B, 1, (1 - p) * W); break;
      case 'slide-right': draw(A); draw(B, 1, -(1 - p) * W); break;
      case 'slide-up': draw(A); draw(B, 1, 0, (1 - p) * H); break;
      case 'push-left': draw(A, 1, -p * W); draw(B, 1, (1 - p) * W); break;
      case 'wipe-right': draw(A); clipDraw(B, () => ctx.rect(0, 0, p * W, H)); break;
      case 'wipe-down': draw(A); clipDraw(B, () => ctx.rect(0, 0, W, p * H)); break;
      case 'circle': draw(A); clipDraw(B, () => ctx.arc(W / 2, H / 2, p * Math.hypot(W, H) / 2, 0, Math.PI * 2)); break;
      case 'zoom-in': draw(A, 1 - p, 0, 0, 1 + p * 0.6); draw(B, p, 0, 0, 0.7 + 0.3 * p); break;
      case 'blur': draw(A, 1, 0, 0, 1, 0, p * W * 0.03); draw(B, p, 0, 0, 1, 0, (1 - p) * W * 0.03); break;
      case 'spin': draw(A, 1 - p, 0, 0, Math.max(0.01, 1 - p), p * Math.PI); draw(B, p, 0, 0, Math.max(0.01, p), -(1 - p) * Math.PI); break;
      default: draw(A); draw(B, p);
    }
  }

  applyEffect(ctx, c, t) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const q = c.intensity ?? 0.7;
    const rel = t - c.start;
    const snap = () => { const s = this.slot('fx', W, H); s.getContext('2d').drawImage(ctx.canvas, 0, 0); return s; };
    const redraw = (s, fn) => { ctx.save(); ctx.globalCompositeOperation = 'copy'; fn(); ctx.drawImage(s, 0, 0); ctx.restore(); };
    ctx.save();
    switch (c.effect) {
      case 'shake': {
        const s = snap();
        const dx = Math.sin(rel * 53) * q * 0.025 * W, dy = Math.cos(rel * 41) * q * 0.025 * H;
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(s, -W * 0.03 + dx, -H * 0.03 + dy, W * 1.06, H * 1.06);
        break;
      }
      case 'zoom-pulse': {
        const s = snap();
        const k = 1 + q * 0.15 * (0.5 - 0.5 * Math.cos(2 * Math.PI * rel * 2));
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(s, W / 2 - (W * k) / 2, H / 2 - (H * k) / 2, W * k, H * k);
        break;
      }
      case 'flash': {
        const ph = (rel * 1.5) % 1;
        ctx.globalAlpha = q * Math.max(0, 1 - ph * 3);
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
        break;
      }
      case 'strobe': {
        if (Math.floor(rel * 10) % 2) { ctx.globalAlpha = q * 0.85; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
        break;
      }
      case 'vignette': this.vignette(ctx, W, H, q); break;
      case 'letterbox': {
        const h = H * 0.12 * q;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, h); ctx.fillRect(0, H - h, W, h);
        break;
      }
      case 'glow': {
        const s = snap();
        ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = q * 0.7;
        ctx.filter = `blur(${(W * 0.012).toFixed(1)}px) brightness(1.2)`;
        ctx.drawImage(s, 0, 0);
        break;
      }
      case 'mirror': {
        const s = snap();
        ctx.translate(W, 0); ctx.scale(-1, 1);
        ctx.drawImage(s, 0, 0, W / 2, H, 0, 0, W / 2, H);
        break;
      }
      case 'invert': { const s = snap(); redraw(s, () => { ctx.filter = `invert(${q})`; }); break; }
      case 'blur-pulse': {
        const s = snap();
        redraw(s, () => { ctx.filter = `blur(${(q * W * 0.012 * (0.5 - 0.5 * Math.cos(2 * Math.PI * rel))).toFixed(2)}px)`; });
        break;
      }
      case 'grain': this.grain(ctx, W, H, q * 0.5, rel); break;
      case 'rgb-split': this.rgbSplit(ctx, W, H, Math.round(q * W * 0.01 * (1 + 0.5 * Math.sin(rel * 6)))); break;
      case 'vhs': {
        this.rgbSplit(ctx, W, H, Math.round(q * W * 0.006));
        ctx.globalAlpha = 0.18 * q; ctx.fillStyle = '#000';
        const step = Math.max(2, Math.round(H / 240));
        for (let y = 0; y < H; y += step * 2) ctx.fillRect(0, y, W, step);
        ctx.globalAlpha = 1;
        const band = (rel * 0.3 % 1) * H;
        const s = snap();
        ctx.drawImage(s, 0, band, W, H * 0.04, W * 0.01 * q, band, W, H * 0.04);
        this.grain(ctx, W, H, q * 0.25, rel);
        break;
      }
      case 'old-film': {
        const s = snap();
        const flick = 0.92 + 0.08 * Math.sin(rel * 47);
        redraw(s, () => { ctx.filter = `sepia(${q}) contrast(1.1) brightness(${flick.toFixed(3)})`; });
        this.grain(ctx, W, H, q * 0.45, rel);
        this.vignette(ctx, W, H, q * 0.8);
        if (Math.sin(rel * 13) > 0.6) { ctx.globalAlpha = 0.5 * q; ctx.fillStyle = '#ddd'; ctx.fillRect(((rel * 997) % 1) * W, 0, Math.max(1, W * 0.002), H); }
        break;
      }
    }
    ctx.restore();
  }

  vignette(ctx, W, H, q) {
    ctx.save();
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${clamp(q, 0, 1)})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  grain(ctx, W, H, alpha, rel) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = clamp(alpha, 0, 1);
    const pat = ctx.createPattern(this.noise, 'repeat');
    const k = Math.floor(rel * 24);
    ctx.translate((k * 73) % 256, (k * 151) % 256);
    ctx.fillStyle = pat; ctx.fillRect(-256, -256, W + 512, H + 512);
    ctx.restore();
  }

  rgbSplit(ctx, W, H, k) {
    if (k < 1) return;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data, src = new Uint8ClampedArray(d);
    for (let y = 0; y < H; y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        const i = row + x * 4;
        const xr = Math.min(W - 1, x + k), xb = Math.max(0, x - k);
        d[i] = src[row + xr * 4];
        d[i + 2] = src[row + xb * 4 + 2];
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}
