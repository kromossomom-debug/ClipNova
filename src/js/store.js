// Editor state, change notifications, undo/redo and editing operations.
import {
  uid, deepClone, clamp, layout, clipDuration, findClip, trackKindForClip, makeMediaClip, sourceTime, KF_PROPS, kfValues,
  hasSourceRange, isVisual, TRACK_LABEL, RATIOS, sizeForRatio,
} from './model.js';
import { importFile, ensureVisuals } from './media.js';

export const S = {
  project: null,
  sel: null, // { kind: 'clip' | 'junction', id }
  t: 0,
  playing: false,
  pps: 60,
  snap: true,
  libTab: 'media',
  inspTab: {},
};

const handlers = {};
export const on = (ev, fn) => (handlers[ev] ||= []).push(fn);
export const emit = (ev, data) => (handlers[ev] || []).forEach((f) => f(data));

export function toast(msg, err = false) { emit('toast', { msg, err }); }

// ---------- history ----------
const undoStack = [], redoStack = [];
let lastKey = null, lastAt = 0;
const snap = () => JSON.stringify(S.project);

export function checkpoint(key = null) {
  const now = performance.now();
  if (key && key === lastKey && now - lastAt < 700) { lastAt = now; return; }
  lastKey = key; lastAt = now;
  undoStack.push(snap());
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  emit('history');
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export function undo() { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); }
export function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); }
function restore(s) {
  S.project = JSON.parse(s);
  lastKey = null;
  if (S.sel && !findClip(S.project, S.sel.id)) S.sel = null;
  changed('structure');
  emit('history');
}
export function resetHistory() { undoStack.length = 0; redoStack.length = 0; emit('history'); }

export function changed(kind = 'structure') {
  layout(S.project);
  S.project.updatedAt = Date.now();
  emit('change', kind);
}

export function select(sel) {
  S.sel = sel;
  emit('change', 'select');
}

export function selClip() {
  if (!S.sel || S.sel.kind !== 'clip') return null;
  return findClip(S.project, S.sel.id);
}

export function seek(t) {
  S.t = clamp(t, 0, Math.max(0, S.project.duration));
  emit('seek', S.t);
}

// ---------- property edits (keyframe aware) ----------
export function getPath(o, path) { return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
export function setPath(o, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  const tgt = ks.reduce((a, k) => a[k], o);
  tgt[last] = v;
}

export function kfAt(c, t) {
  const rel = t - c.start;
  const tol = 0.5 / (S.project.fps || 30);
  return (c.keyframes || []).find((k) => Math.abs(k.t - rel) <= tol) || null;
}

export function displayValue(c, path) {
  if (KF_PROPS.includes(path) && c.keyframes?.length) return kfValues(c, S.t)[path];
  return getPath(c, path);
}

export function setProp(c, path, v) {
  if (KF_PROPS.includes(path) && c.keyframes?.length) {
    let k = kfAt(c, S.t);
    if (!k) {
      k = { t: clamp(S.t - c.start, 0, clipDuration(c)), ...kfValues(c, S.t) };
      c.keyframes.push(k);
      c.keyframes.sort((a, b) => a.t - b.t);
    }
    k[path] = v;
  } else setPath(c, path, v);
}

export function toggleKeyframe(c) {
  checkpoint();
  c.keyframes ||= [];
  const k = kfAt(c, S.t);
  if (k) {
    c.keyframes.splice(c.keyframes.indexOf(k), 1);
    if (!c.keyframes.length) { /* bake nothing: base values remain */ }
  } else {
    const v = kfValues(c, S.t);
    if (!c.keyframes.length) Object.assign(c, v);
    c.keyframes.push({ t: clamp(S.t - c.start, 0, clipDuration(c)), ...v });
    c.keyframes.sort((a, b) => a.t - b.t);
  }
  changed('structure');
}

// ---------- tracks ----------
export function mainTrack() { return S.project.tracks[0]; }

export function overlaps(track, start, end, exceptId) {
  return track.clips.some((c) => c.id !== exceptId && start < c.start + clipDuration(c) - 1e-4 && end > c.start + 1e-4);
}

export function newTrack(kind) {
  const n = S.project.tracks.filter((t) => t.kind === kind).length + 1;
  const tr = { id: uid(), kind, name: `${TRACK_LABEL[kind]} ${n}`, muted: false, hidden: false, locked: false, clips: [] };
  S.project.tracks.push(tr);
  return tr;
}

export function cleanupTracks() {
  S.project.tracks = S.project.tracks.filter((t, i) => i === 0 || t.clips.length);
}

// Place a non-main clip at time `t`, reusing a free track of the right kind or creating one.
export function placeClip(c, t, preferredTrack = null) {
  const kind = trackKindForClip(c.type);
  c.start = Math.max(0, t);
  const dur = clipDuration(c);
  const candidates = preferredTrack ? [preferredTrack] : S.project.tracks.filter((tr) => tr.kind === kind);
  let track = candidates.find((tr) => tr.kind === kind && !overlaps(tr, c.start, c.start + dur, c.id));
  if (!track) track = newTrack(kind);
  track.clips.push(c);
  track.clips.sort((a, b) => a.start - b.start);
  return track;
}

export function mainIndexAt(t) {
  const clips = mainTrack().clips;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (t < c.start + clipDuration(c) / 2) return i;
  }
  return clips.length;
}

// ---------- media ----------
export async function importPaths(paths) {
  const added = [];
  for (const p of paths) {
    const existing = Object.values(S.project.media).find((m) => m.path === p);
    if (existing) { added.push(existing); continue; }
    try {
      const m = await importFile(p);
      S.project.media[m.id] = m;
      added.push(m);
      ensureVisuals(m, () => emit('media-visuals', m.id));
    } catch (e) {
      toast(`${p.split(/[\\/]/).pop()}: ${e.message}`, true);
    }
  }
  if (added.length) { changed('media'); }
  return added;
}

function maybeAdoptRatio(m) {
  const p = S.project;
  if (p.ratio !== 'original' || !m.width) return;
  const even = (x) => Math.round(x / 2) * 2;
  const k = 1080 / Math.min(m.width, m.height);
  p.width = even(m.width * k); p.height = even(m.height * k);
  emit('resize');
}

export function setRatio(r) {
  checkpoint();
  const p = S.project;
  p.ratio = r;
  if (r === 'original') {
    const first = p.tracks[0].clips[0];
    const m = first && p.media[first.mediaId];
    if (m && m.width) maybeAdoptRatio(m); else Object.assign(p, sizeForRatio('16:9'));
  } else Object.assign(p, sizeForRatio(r));
  emit('resize');
  changed('props');
}

export function addMedia(m, opts = {}) {
  checkpoint();
  const c = makeMediaClip(m);
  if (m.type === 'audio') {
    placeClip(c, opts.time ?? S.t, opts.track);
  } else if (opts.track && opts.track.kind !== 'main') {
    placeClip(c, opts.time ?? S.t, opts.track);
  } else if (opts.overlay) {
    placeClip(c, opts.time ?? S.t);
  } else {
    const main = mainTrack();
    if (!main.clips.length) maybeAdoptRatio(m);
    const idx = opts.index ?? (opts.time != null ? mainIndexAt(opts.time) : (main.clips.length ? mainIndexAt(S.t) : 0));
    main.clips.splice(idx, 0, c);
  }
  S.sel = { kind: 'clip', id: c.id };
  changed('structure');
  return c;
}

// Insert a clip that behaves like a photo (colour card) into the magnetic main track at the playhead.
export function addToMain(c, index) {
  checkpoint();
  const main = mainTrack();
  main.clips.splice(index ?? (main.clips.length ? mainIndexAt(S.t) : 0), 0, c);
  S.sel = { kind: 'clip', id: c.id };
  changed('structure');
  return c;
}

// Remove empty space between clips of a free track (the main track is always gapless).
export function closeGaps() {
  const f = selClip();
  const tracks = f && f.track.kind !== 'main' ? [f.track] : S.project.tracks.filter((t) => t.kind !== 'main');
  checkpoint();
  let n = 0;
  for (const tr of tracks) {
    tr.clips.sort((a, b) => a.start - b.start);
    let t = tr.clips.length ? tr.clips[0].start : 0;
    for (const c of tr.clips) {
      if (c.start > t + 1e-3) { c.start = t; n++; }
      t = c.start + clipDuration(c);
    }
  }
  changed('structure');
  toast(n ? `${n} lacuna(s) removida(s)` : 'Nenhuma lacuna encontrada');
}

// Fit / fill the frame, or shrink into a corner (picture-in-picture). Works for video and photos.
export function frameSelected(mode) {
  const f = selClip();
  if (!f || (f.clip.type !== 'video' && f.clip.type !== 'image')) { toast('Selecione um vídeo ou foto'); return; }
  const c = f.clip, m = S.project.media[c.mediaId];
  if (!m?.width) return;
  checkpoint();
  const W = S.project.width, H = S.project.height;
  const cr = c.crop || { l: 0, t: 0, r: 0, b: 0 };
  const sw = (1 - cr.l - cr.r) * m.width, sh = (1 - cr.t - cr.b) * m.height;
  const fit = Math.min(W / sw, H / sh);
  c.keyframes = [];
  if (mode === 'fit') Object.assign(c, { x: 0, y: 0, scale: 1, rotation: 0 });
  else if (mode === 'fill') Object.assign(c, { x: 0, y: 0, scale: Math.max(W / sw, H / sh) / fit, rotation: 0 });
  else {
    // cycle through the four corners
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    const k = 0.32;
    const cur = corners.findIndex(([sx, sy]) => Math.sign(c.x) === sx && Math.sign(c.y) === sy && Math.abs(c.scale - k) < 1e-3);
    const [sx, sy] = corners[(cur + 1) % 4];
    const bw = (sw * fit * k) / W, bh = (sh * fit * k) / H;
    Object.assign(c, { scale: k, rotation: 0, x: sx * (0.5 - bw / 2 - 0.03), y: sy * (0.5 - bh / 2 - 0.04) });
  }
  changed('structure');
}

export function addClip(c, time = S.t) {
  checkpoint();
  placeClip(c, time);
  S.sel = { kind: 'clip', id: c.id };
  changed('structure');
  return c;
}

// ---------- edit operations ----------
function splitClipAt(found, t) {
  const { track, clip: c, index } = found;
  const rel = t - c.start, dur = clipDuration(c);
  if (rel <= 0.05 || rel >= dur - 0.05) return null;
  const b = deepClone(c);
  b.id = uid();
  if (hasSourceRange(c)) {
    const st = sourceTime(c, t);
    c.out = st; b.in = st;
  } else {
    c.dur = rel; b.dur = dur - rel;
  }
  b.start = t;
  if (c.keyframes?.length) {
    b.keyframes = c.keyframes.filter((k) => k.t >= rel).map((k) => ({ ...k, t: k.t - rel }));
    c.keyframes = c.keyframes.filter((k) => k.t <= rel);
  }
  if (c.anim) { c.anim.out = { type: 'none', dur: c.anim.out.dur }; b.anim.in = { type: 'none', dur: b.anim.in.dur }; }
  if (c.transition) c.transition = { type: 'none', dur: c.transition.dur };
  c.fadeOut = 0; b.fadeIn = 0;
  track.clips.splice(index + 1, 0, b);
  return b;
}

export function splitAtPlayhead() {
  let found = selClip();
  if (found) {
    const { clip: c } = found;
    if (!(S.t > c.start && S.t < c.start + clipDuration(c))) found = null;
  }
  if (!found) {
    const c = mainTrack().clips.find((x) => S.t > x.start && S.t < x.start + clipDuration(x));
    if (c) found = findClip(S.project, c.id);
  }
  if (!found) { toast('Posicione o cursor sobre um clipe para dividir'); return; }
  checkpoint();
  const b = splitClipAt(found, S.t);
  if (b) { S.sel = { kind: 'clip', id: b.id }; changed('structure'); }
}

export function deleteSelected() {
  const f = selClip();
  if (!f) {
    if (S.sel?.kind === 'junction') { setTransition(S.sel.id, 'none'); }
    return;
  }
  checkpoint();
  f.track.clips.splice(f.index, 1);
  cleanupTracks();
  S.sel = null;
  changed('structure');
}

export function duplicateSelected() {
  const f = selClip();
  if (!f) return;
  checkpoint();
  const c = deepClone(f.clip);
  c.id = uid();
  if (f.track.kind === 'main') f.track.clips.splice(f.index + 1, 0, c);
  else placeClip(c, f.clip.start + clipDuration(f.clip), f.track);
  S.sel = { kind: 'clip', id: c.id };
  changed('structure');
}

export function mirrorSelected() {
  const f = selClip();
  if (!f || !isVisual(f.clip)) return;
  checkpoint();
  f.clip.flipX = !f.clip.flipX;
  changed('props');
}

export function rotateSelected() {
  const f = selClip();
  if (!f || !isVisual(f.clip)) return;
  checkpoint();
  setProp(f.clip, 'rotation', ((displayValue(f.clip, 'rotation') + 90 + 180) % 360) - 180);
  changed('props');
}

export async function freezeFrame() {
  const f = selClip();
  if (!f || f.clip.type !== 'video') { toast('Selecione um clipe de vídeo'); return; }
  const c = f.clip;
  if (!(S.t >= c.start && S.t < c.start + clipDuration(c))) { toast('Coloque o cursor sobre o clipe'); return; }
  const m = S.project.media[c.mediaId];
  emit('busy', 'Congelando quadro…');
  try {
    const png = await window.native.extractFrame(S.project.id, m.path, sourceTime(c, S.t));
    const [img] = await importPaths([png]);
    if (!img) return;
    checkpoint();
    const t = S.t;
    const b = splitClipAt(findClip(S.project, c.id), t);
    const fr = makeMediaClip(img);
    fr.dur = 3;
    for (const k of ['x', 'y', 'scale', 'rotation', 'flipX', 'flipY', 'opacity', 'blend', 'adjust', 'filter', 'crop', 'mask', 'chroma']) fr[k] = deepClone(c[k]);
    const track = findClip(S.project, c.id).track;
    if (track.kind === 'main') {
      track.clips.splice(track.clips.indexOf(c) + 1, 0, fr);
    } else {
      fr.start = t;
      if (b) b.start = t + 3;
      track.clips.push(fr);
      track.clips.sort((a, x) => a.start - x.start);
    }
    S.sel = { kind: 'clip', id: fr.id };
    changed('structure');
    toast('Quadro congelado (3s)');
  } catch (e) {
    toast('Falha ao congelar: ' + e.message, true);
  } finally { emit('busy', null); }
}

export async function reverseSelected() {
  const f = selClip();
  if (!f || f.clip.type !== 'video') { toast('Selecione um clipe de vídeo'); return; }
  const c = f.clip;
  if (c.reverseOf) {
    checkpoint();
    Object.assign(c, { mediaId: c.reverseOf.mediaId, in: c.reverseOf.in, out: c.reverseOf.out });
    delete c.reverseOf;
    changed('structure');
    toast('Reversão desfeita');
    return;
  }
  const m = S.project.media[c.mediaId];
  emit('busy', 'Invertendo clipe… isso pode levar alguns segundos');
  try {
    const out = await window.native.reverseMedia(S.project.id, m.path, c.in, c.out, m.hasAudio);
    const [nm] = await importPaths([out]);
    if (!nm) return;
    checkpoint();
    c.reverseOf = { mediaId: c.mediaId, in: c.in, out: c.out };
    c.mediaId = nm.id; c.in = 0; c.out = nm.duration;
    changed('structure');
    toast('Clipe invertido');
  } catch (e) {
    toast('Falha ao inverter: ' + e.message, true);
  } finally { emit('busy', null); }
}

export function extractAudio() {
  const f = selClip();
  if (!f || f.clip.type !== 'video') { toast('Selecione um clipe de vídeo'); return; }
  const m = S.project.media[f.clip.mediaId];
  if (!m.hasAudio) { toast('Este vídeo não tem áudio'); return; }
  checkpoint();
  const c = f.clip;
  const a = { id: uid(), type: 'audio', mediaId: c.mediaId, start: c.start, in: c.in, out: c.out, speed: c.speed, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, muted: false };
  placeClip(a, c.start);
  c.muted = true;
  S.sel = { kind: 'clip', id: a.id };
  changed('structure');
  toast('Áudio extraído para uma nova faixa');
}

export function setTransition(clipId, type, dur) {
  const f = findClip(S.project, clipId);
  if (!f || f.track.kind !== 'main' || f.index >= f.track.clips.length - 1) return;
  checkpoint();
  f.clip.transition = { type, dur: dur ?? f.clip.transition?.dur ?? 0.5 };
  changed('structure');
}

export function applyTransitionToAll(type, dur) {
  checkpoint();
  const clips = mainTrack().clips;
  clips.forEach((c, i) => { if (i < clips.length - 1) c.transition = { type, dur }; });
  changed('structure');
}

export function moveMainClip(id, toIndex) {
  const main = mainTrack();
  const from = main.clips.findIndex((c) => c.id === id);
  if (from < 0) return;
  const [c] = main.clips.splice(from, 1);
  main.clips.splice(toIndex > from ? toIndex - 1 : toIndex, 0, c);
}

export { RATIOS };
