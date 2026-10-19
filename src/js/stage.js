// Preview canvas: sizing, drawing and direct manipulation of the selected layer.
import { S, on, emit, checkpoint, changed, select, selClip, setProp, displayValue, toast } from './store.js';
import { Renderer, clipBox } from './render.js';
import { activeClips, clipDuration } from './model.js';

let stageEl, wrap, canvas, ctx, selbox, guides, engine;
const renderer = new Renderer();
let dirty = true;
let picking = null;
let dispW = 0, dispH = 0;

export function initStage(eng) {
  engine = eng;
  stageEl = document.getElementById('stage');
  wrap = document.getElementById('canvas-wrap');
  canvas = document.getElementById('preview');
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  selbox = document.getElementById('selbox');
  guides = document.getElementById('guides');
  new ResizeObserver(() => fit()).observe(stageEl);
  on('resize', () => fit());
  on('change', () => { dirty = true; });
  on('seek', () => { dirty = true; });
  on('pick-color', (cb) => { picking = cb; wrap.style.cursor = 'crosshair'; toast('Clique no reprodutor para escolher a cor-chave'); });
  wrap.addEventListener('pointerdown', onPointerDown);
  wrap.addEventListener('dblclick', () => {
    const f = selClip();
    if (f && f.clip.type === 'text') {
      S.inspTab.text = 'Texto';
      emit('change', 'select');
      setTimeout(() => { const ta = document.getElementById('text-input'); if (ta) { ta.focus(); ta.select(); } }, 30);
    }
  });
}

export const markDirty = () => { dirty = true; };
export const previewCanvas = () => canvas;

export function fit() {
  if (!S.project) return;
  const r = stageEl.getBoundingClientRect();
  const pad = 16;
  const aw = Math.max(50, r.width - pad * 2), ah = Math.max(50, r.height - pad * 2);
  const ar = S.project.width / S.project.height;
  dispW = Math.floor(Math.min(aw, ah * ar));
  dispH = Math.floor(dispW / ar);
  wrap.style.width = dispW + 'px';
  wrap.style.height = dispH + 'px';
  const dpr = window.devicePixelRatio || 1;
  const k = Math.min(1, (dispW * dpr) / S.project.width);
  const cw = Math.max(2, Math.round(S.project.width * k)), ch = Math.max(2, Math.round(S.project.height * k));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  document.getElementById('viewer-info').textContent = `${S.project.width}×${S.project.height} · ${S.project.fps} fps`;
  dirty = true;
}

const sources = (c) => engine.source(c, S.project);

export function draw(force = false) {
  if (!S.project || (!dirty && !force && !S.playing)) return;
  dirty = false;
  renderer.render(ctx, S.project, S.t, sources);
  updateSelBox();
}

function visualActiveAt(t) {
  const out = [];
  for (const track of S.project.tracks) {
    if (track.hidden || track.kind === 'audio' || track.kind === 'effect') continue;
    for (const c of activeClips(track, t)) out.push(c);
  }
  return out; // render order: bottom first
}

function boxOf(c) {
  const src = c.type === 'video' || c.type === 'image' ? sources(c) : null;
  if ((c.type === 'video' || c.type === 'image') && !src) return null;
  return clipBox(c, S.t, canvas.width, canvas.height, src);
}

function updateSelBox() {
  const f = selClip();
  const c = f?.clip;
  if (!c || c.type === 'audio' || c.type === 'effect' || f.track.hidden || !(S.t >= c.start && S.t < c.start + clipDuration(c)) || S.playing) {
    selbox.classList.add('hidden');
    return;
  }
  const b = boxOf(c);
  if (!b) { selbox.classList.add('hidden'); return; }
  const k = dispW / canvas.width;
  selbox.classList.remove('hidden');
  selbox.style.left = (b.cx - b.w / 2) * k + 'px';
  selbox.style.top = (b.cy - b.h / 2) * k + 'px';
  selbox.style.width = b.w * k + 'px';
  selbox.style.height = b.h * k + 'px';
  selbox.style.transform = `rotate(${b.rot}rad)`;
}

function hitTest(px, py) {
  const list = visualActiveAt(S.t).reverse();
  for (const c of list) {
    const b = boxOf(c);
    if (!b) continue;
    const dx = px - b.cx, dy = py - b.cy;
    const cs = Math.cos(-b.rot), sn = Math.sin(-b.rot);
    const lx = dx * cs - dy * sn, ly = dx * sn + dy * cs;
    if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return c;
  }
  return null;
}

function showGuides(v, hz) {
  guides.innerHTML = (v ? `<div class="g" style="left:50%;top:0;bottom:0;width:1px"></div>` : '') +
    (hz ? `<div class="g" style="top:50%;left:0;right:0;height:1px"></div>` : '');
}

function onPointerDown(e) {
  if (e.button !== 0 || !S.project) return;
  const rect = wrap.getBoundingClientRect();
  const k = canvas.width / rect.width;
  const px = (e.clientX - rect.left) * k, py = (e.clientY - rect.top) * k;

  if (picking) {
    const cb = picking;
    picking = null;
    wrap.style.cursor = '';
    const f = selClip();
    const was = f?.clip.chroma?.on;
    if (f && f.clip.chroma) f.clip.chroma.on = false;
    draw(true);
    const d = ctx.getImageData(Math.floor(px), Math.floor(py), 1, 1).data;
    if (f && f.clip.chroma) f.clip.chroma.on = was;
    cb('#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''));
    return;
  }

  emit('pause');
  const handle = e.target.dataset?.h;
  let f = selClip();
  if (!handle) {
    const hit = hitTest(px, py);
    if (!hit) { select(null); return; }
    if (!f || f.clip.id !== hit.id) { select({ kind: 'clip', id: hit.id }); f = selClip(); }
  }
  if (!f) return;
  const c = f.clip;
  const b = boxOf(c);
  if (!b) return;
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  const start = { x: displayValue(c, 'x'), y: displayValue(c, 'y'), scale: displayValue(c, 'scale'), rotation: displayValue(c, 'rotation') };
  const cxClient = rect.left + b.cx / k, cyClient = rect.top + b.cy / k;
  const d0 = Math.hypot(e.clientX - cxClient, e.clientY - cyClient) || 1;
  let started = false;
  const move = (ev) => {
    if (!started) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 2) return; checkpoint(); started = true; }
    if (handle === 'scale') {
      const d = Math.hypot(ev.clientX - cxClient, ev.clientY - cyClient);
      setProp(c, 'scale', Math.max(0.02, start.scale * (d / d0)));
    } else if (handle === 'rotate') {
      let a = (Math.atan2(ev.clientY - cyClient, ev.clientX - cxClient) * 180) / Math.PI + 90;
      a = ((a + 540) % 360) - 180;
      for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(a - s) < 4) a = s;
      setProp(c, 'rotation', a);
    } else {
      let nx = start.x + (ev.clientX - x0) / rect.width;
      let ny = start.y + (ev.clientY - y0) / rect.height;
      const tol = 6 / rect.width;
      const snapV = Math.abs(nx) < tol, snapH = Math.abs(ny) < 6 / rect.height;
      if (snapV) nx = 0;
      if (snapH) ny = 0;
      showGuides(snapV, snapH);
      setProp(c, 'x', nx); setProp(c, 'y', ny);
    }
    changed('props');
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    showGuides(false, false);
    if (started) changed('trim');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function snapshotThumb() {
  if (!canvas.width) return null;
  const c = document.createElement('canvas');
  const k = 320 / Math.max(canvas.width, canvas.height);
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.75);
}
