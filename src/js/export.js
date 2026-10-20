// Offline export: frame-accurate render through FFmpeg decoders, WebAudio mixdown, H.264/AAC MP4.
import { layout, clipDuration, deepClone, clamp } from './model.js';
import { Renderer } from './render.js';
import { getAudioBuffer, getImage, fadeGain } from './media.js';

export async function mixAudio(project, rate = 48000, channels = 2) {
  const D = project.duration;
  const items = [];
  for (const track of project.tracks) {
    if (track.muted || track.kind === 'effect' || track.kind === 'text') continue;
    for (const c of track.clips) {
      if ((c.type !== 'video' && c.type !== 'audio') || c.muted || c.volume <= 0) continue;
      const m = project.media[c.mediaId];
      if (m && m.hasAudio) items.push({ c, m });
    }
  }
  if (!items.length || D <= 0) return null;
  const ctx = new OfflineAudioContext(channels, Math.ceil(D * rate), rate);
  for (const { c, m } of items) {
    const buf = await getAudioBuffer(m, ctx);
    if (!buf) continue;
    const dur = clipDuration(c);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.speed;
    const g = ctx.createGain();
    // gain envelope sampled every 10 ms (volume × fade in/out)
    const steps = Math.max(2, Math.ceil(dur * 100));
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) curve[i] = c.volume * fadeGain(c, c.start + (i / (steps - 1)) * dur);
    g.gain.setValueCurveAtTime(curve, c.start, dur);
    src.connect(g).connect(ctx.destination);
    src.start(c.start, c.in);
    src.stop(c.start + dur);
  }
  const out = await ctx.startRendering();
  return encodeWav(out);
}

export function encodeWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, rate = buf.sampleRate;
  const ab = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(ab);
  const str = (o, s) => [...s].forEach((x, i) => v.setUint8(o + i, x.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { v.setInt16(o, clamp(data[c][i], -1, 1) * 0x7fff, true); o += 2; }
  return new Uint8Array(ab);
}

function decodeSize(m, W, H) {
  const cap = Math.max(W, H) * 1.5;
  const k = Math.min(1, cap / Math.max(m.width, m.height));
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  return { w: even(m.width * k), h: even(m.height * k) };
}

export async function exportProject(project0, opts, onProgress, isCanceled) {
  const project = deepClone(project0);
  layout(project);
  const { width: W, height: H, fps } = opts;
  const D = project.duration;
  const total = Math.max(1, Math.ceil(D * fps));

  onProgress({ phase: 'audio', frac: 0 });
  const wav = opts.format === 'gif' ? null : await mixAudio(project);
  if (isCanceled()) return { canceled: true };

  // preload still images
  const visual = project.tracks.flatMap((t) => (t.hidden ? [] : t.clips));
  await Promise.all(visual.filter((c) => c.type === 'image').map((c) => new Promise((r) => {
    const img = getImage(project.media[c.mediaId]);
    if (img.complete) r(); else { img.onload = r; img.onerror = r; }
  })));

  await window.native.exportStart({ outPath: opts.outPath, width: W, height: H, fps, crf: opts.crf, audioWav: wav, format: opts.format });

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const renderer = new Renderer();
  const decs = new Map(); // clipId -> { id, canvas, ctx, w, h, index, done }
  const started = performance.now();

  const openDecoder = async (c) => {
    const m = project.media[c.mediaId];
    const { w, h } = decodeSize(m, W, H);
    const id = `${c.id}-${Math.random().toString(36).slice(2, 7)}`;
    await window.native.decoderOpen(id, { path: m.path, start: c.in, length: c.out - c.in, speed: c.speed, fps, width: w, height: h });
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const d = { id, canvas: cv, ctx: cv.getContext('2d'), w, h, index: -1, done: false, has: false };
    decs.set(c.id, d);
    return d;
  };

  const sources = new Map();
  const getSource = (c) => {
    if (c.type === 'image') {
      const img = getImage(project.media[c.mediaId]);
      return img.naturalWidth ? { el: img, w: img.naturalWidth, h: img.naturalHeight } : null;
    }
    return sources.get(c.id) || null;
  };

  let canceled = false;
  try {
    for (let f = 0; f < total; f++) {
      if (isCanceled()) { canceled = true; break; }
      const t = f / fps;
      sources.clear();
      for (const track of project.tracks) {
        if (track.hidden || track.kind === 'audio') continue;
        for (const c of track.clips) {
          if (c.type !== 'video') continue;
          const end = c.start + clipDuration(c);
          if (t < c.start || t >= end) {
            if (decs.has(c.id) && t >= end) { await window.native.decoderClose(decs.get(c.id).id); decs.delete(c.id); }
            continue;
          }
          const d = decs.get(c.id) || (await openDecoder(c));
          const want = Math.max(0, Math.round((t - c.start) * fps));
          while (d.index < want && !d.done) {
            const bytes = await window.native.decoderRead(d.id);
            if (!bytes) { d.done = true; break; }
            d.index++;
            if (d.index >= want) {
              d.ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength), d.w, d.h), 0, 0);
              d.has = true;
            }
          }
          if (d.has) sources.set(c.id, { el: d.canvas, w: d.w, h: d.h });
        }
      }
      renderer.render(ctx, project, t, getSource);
      const img = ctx.getImageData(0, 0, W, H);
      await window.native.exportFrame(img.data);
      if (f % 5 === 0 || f === total - 1) {
        const el = (performance.now() - started) / 1000;
        const frac = (f + 1) / total;
        onProgress({ phase: 'video', frac, eta: (el / frac) * (1 - frac) });
      }
    }
  } finally {
    for (const d of decs.values()) await window.native.decoderClose(d.id);
  }
  const res = await window.native.exportFinish(canceled);
  return canceled ? { canceled: true } : res;
}
