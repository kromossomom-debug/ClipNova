// Media import, thumbnails/waveforms, audio decoding, and the live preview playback engine.
import { uid, clipDuration, sourceTime, clamp } from './model.js';

export const mediaUrl = (p) => 'app://clipnova/media/' + encodeURIComponent(p);

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'ogv', 'avi'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'];

export const extOf = (p) => p.split('.').pop().toLowerCase();
export const baseName = (p) => p.split(/[\\/]/).pop();

function loadVideoMeta(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => { resolve({ w: v.videoWidth, h: v.videoHeight, duration: v.duration }); v.removeAttribute('src'); v.load(); };
    v.onerror = () => reject(new Error('Formato de vídeo não suportado'));
    v.src = url;
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Imagem inválida'));
    i.src = url;
  });
}

// In-memory caches (not persisted in the project file).
export const cache = { strips: {}, thumbs: {}, peaks: {}, audio: {}, images: {} };

export async function importFile(path) {
  const ext = extOf(path);
  const url = mediaUrl(path);
  const m = { id: uid(), path, name: baseName(path), type: null, duration: 0, width: 0, height: 0, hasAudio: false };
  if (IMAGE_EXT.includes(ext)) {
    const img = await loadImage(url);
    Object.assign(m, { type: 'image', width: img.naturalWidth, height: img.naturalHeight, duration: 4 });
  } else if (AUDIO_EXT.includes(ext)) {
    const pr = await window.native.probeMedia(path);
    if (!pr.duration) throw new Error('Não foi possível ler o áudio');
    Object.assign(m, { type: 'audio', duration: pr.duration, hasAudio: true });
  } else if (VIDEO_EXT.includes(ext)) {
    const pr = await window.native.probeMedia(path);
    const meta = await loadVideoMeta(url);
    Object.assign(m, { type: 'video', width: meta.w, height: meta.h, duration: pr.duration || meta.duration, hasAudio: pr.hasAudio });
    if (!meta.w) throw new Error('Arquivo sem faixa de vídeo');
  } else {
    throw new Error('Tipo de arquivo não suportado: .' + ext);
  }
  return m;
}

// Thumbnails / strips / peaks (best effort, async)
export async function ensureVisuals(m, onReady) {
  if (m.type === 'image') {
    cache.thumbs[m.id] = mediaUrl(m.path);
    const img = await loadImage(mediaUrl(m.path)).catch(() => null);
    if (img) cache.strips[m.id] = { img, n: 1, w: img.naturalWidth, h: img.naturalHeight, still: true };
    onReady?.();
    return;
  }
  if (m.type === 'video' && !cache.strips[m.id]) {
    const strip = await window.native.videoStrip(m.path, m.duration, m.width / m.height).catch(() => null);
    if (strip) {
      const img = await loadImage(strip.url);
      cache.strips[m.id] = { img, n: strip.n, w: strip.w, h: strip.h };
      cache.thumbs[m.id] = await cropFirstTile(img, strip.w, strip.h);
      onReady?.();
    }
  }
  if (m.hasAudio && !cache.peaks[m.id]) {
    const bytes = await window.native.decodeAudio(m.path, 1000, 1).catch(() => null);
    if (bytes) {
      const f = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
      const per = 10; // 100 peaks per second
      const peaks = new Float32Array(Math.ceil(f.length / per));
      for (let i = 0; i < peaks.length; i++) {
        let mx = 0;
        for (let j = i * per; j < Math.min(f.length, (i + 1) * per); j++) mx = Math.max(mx, Math.abs(f[j]));
        peaks[i] = mx;
      }
      cache.peaks[m.id] = peaks;
      onReady?.();
    }
  }
}

// Library thumbnail: a tile from ~1/3 into the video (first frames are often black).
async function cropFirstTile(img, w, h) {
  const n = Math.round(img.naturalWidth / w);
  const idx = Math.min(n - 1, Math.floor(n / 3));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, idx * w, 0, w, h, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.85);
}

export async function getAudioBuffer(m, ctx) {
  const key = m.id;
  if (cache.audio[key]) return cache.audio[key];
  const bytes = await window.native.decodeAudio(m.path, 48000, 2);
  if (!bytes || bytes.byteLength < 8) return null;
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  const n = Math.floor(f.length / 2);
  const buf = ctx.createBuffer(2, Math.max(1, n), 48000);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0; i < n; i++) { L[i] = f[i * 2]; R[i] = f[i * 2 + 1]; }
  cache.audio[key] = buf;
  return buf;
}

export function getImage(m) {
  let img = cache.images[m.id];
  if (!img) { img = new Image(); img.src = mediaUrl(m.path); cache.images[m.id] = img; }
  return img;
}

export function fadeGain(c, t) {
  const rel = t - c.start, dur = clipDuration(c);
  let g = 1;
  if (c.fadeIn > 0 && rel < c.fadeIn) g *= clamp(rel / c.fadeIn, 0, 1);
  if (c.fadeOut > 0 && rel > dur - c.fadeOut) g *= clamp((dur - rel) / c.fadeOut, 0, 1);
  return g;
}

// ---------------- Live preview playback engine ----------------
export class PlaybackEngine {
  constructor(onFrame) {
    this.onFrame = onFrame; // called when a seek finishes so the preview can redraw
    this.els = new Map(); // clipId -> { el, gain, mediaId }
    this.actx = null;
  }

  audioCtx() {
    if (!this.actx) this.actx = new AudioContext({ latencyHint: 'interactive' });
    if (this.actx.state === 'suspended') this.actx.resume();
    return this.actx;
  }

  entry(c, m) {
    let e = this.els.get(c.id);
    if (e && e.mediaId !== m.id) { this.drop(c.id); e = null; }
    if (!e) {
      const el = document.createElement(m.type === 'audio' ? 'audio' : 'video');
      el.preload = 'auto';
      el.playsInline = true;
      el.src = mediaUrl(m.path);
      el.addEventListener('seeked', () => this.onFrame());
      el.addEventListener('loadeddata', () => this.onFrame());
      let gain = null;
      if (m.hasAudio) {
        const ctx = this.audioCtx();
        const node = ctx.createMediaElementSource(el);
        gain = ctx.createGain();
        gain.gain.value = 0;
        node.connect(gain).connect(ctx.destination);
      } else el.muted = true;
      e = { el, gain, mediaId: m.id };
      this.els.set(c.id, e);
    }
    return e;
  }

  drop(id) {
    const e = this.els.get(id);
    if (!e) return;
    e.el.pause(); e.el.removeAttribute('src'); e.el.load();
    this.els.delete(id);
  }

  // Bring all media elements in line with timeline time t.
  sync(project, t, playing) {
    const seen = new Set();
    for (const track of project.tracks) {
      for (const c of track.clips) {
        if (c.type !== 'video' && c.type !== 'audio') continue;
        const m = project.media[c.mediaId];
        if (!m) continue;
        const dur = clipDuration(c);
        const active = t >= c.start && t < c.start + dur;
        const soon = !active && c.start > t && c.start - t < 1.0;
        if (!active && !soon) continue;
        seen.add(c.id);
        const e = this.entry(c, m);
        const el = e.el;
        const want = active ? sourceTime(c, t) : c.in;
        const rate = clamp(c.speed, 0.0625, 16);
        if (el.playbackRate !== rate) el.playbackRate = rate;
        if (e.gain) {
          const audible = active && !track.muted && !c.muted;
          const g = audible ? c.volume * fadeGain(c, t) : 0;
          e.gain.gain.setTargetAtTime(g, this.audioCtx().currentTime, 0.015);
        }
        if (playing && active) {
          if (el.paused) { el.currentTime = want; el.play().catch(() => {}); }
          else if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - want) > 0.02 && !el.seeking) el.currentTime = want;
        }
      }
    }
    for (const id of [...this.els.keys()]) {
      if (!seen.has(id)) {
        const e = this.els.get(id);
        if (!e.el.paused) e.el.pause();
        if (e.gain) e.gain.gain.value = 0;
      }
    }
  }

  pauseAll() { for (const e of this.els.values()) e.el.pause(); }

  gc(project) {
    const ids = new Set();
    for (const tr of project.tracks) for (const c of tr.clips) ids.add(c.id);
    for (const id of [...this.els.keys()]) if (!ids.has(id)) this.drop(id);
  }

  source(c, project) {
    const m = project.media[c.mediaId];
    if (!m) return null;
    if (c.type === 'image') {
      const img = getImage(m);
      return img.complete && img.naturalWidth ? { el: img, w: img.naturalWidth, h: img.naturalHeight } : null;
    }
    const e = this.els.get(c.id);
    if (!e || e.el.readyState < 2 || !e.el.videoWidth) return null;
    return { el: e.el, w: e.el.videoWidth, h: e.el.videoHeight };
  }
}
