// Multi-track timeline: rendering and pointer interactions.
import { S, on, emit, checkpoint, changed, select, seek, mainTrack, overlaps, newTrack, cleanupTracks, moveMainClip, addMedia, addClip, toast } from './store.js';
import { clipDuration, clamp, findClip, trackKindForClip, hasSourceRange, EFFECTS, TRACK_LABEL, uid } from './model.js';
import { cache } from './media.js';
import { icon } from './icons.js';

const HEAD = 132;
const $ = (id) => document.getElementById(id);
let scrollEl, contentEl, rowsEl, rulerEl, playheadEl, insertEl, snapEl;
let raf = 0;

export const fmtTime = (t, fps = 30) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * fps);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
};
const fmtDur = (t) => (t < 60 ? `${t.toFixed(1)}s` : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`);

export function initTimeline() {
  scrollEl = $('tl-scroll'); contentEl = $('tl-content'); rowsEl = $('tl-rows'); rulerEl = $('tl-ruler');
  playheadEl = $('tl-playhead'); insertEl = $('tl-insert'); snapEl = $('tl-snap');

  on('change', (kind) => { if (kind !== 'props') schedule(); });
  on('media-visuals', () => schedule());
  on('seek', () => updatePlayhead());

  scrollEl.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const rect = scrollEl.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollEl.scrollLeft - HEAD;
      const tAt = x / S.pps;
      setZoom(S.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      scrollEl.scrollLeft = tAt * S.pps + HEAD - (e.clientX - rect.left);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // native horizontal scroll
    }
  }, { passive: false });

  rulerEl.addEventListener('pointerdown', (e) => startScrub(e));
  playheadEl.querySelector('.knob').addEventListener('pointerdown', (e) => startScrub(e));
  rowsEl.addEventListener('pointerdown', onRowsPointerDown);
  rowsEl.addEventListener('contextmenu', onContextMenu);
  scrollEl.addEventListener('scroll', () => { drawRuler(); schedulePaintThumbs(); });
  new ResizeObserver(() => schedule()).observe(scrollEl);

  // drag & drop from the library
  rowsEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-clipnova')) return;
    e.preventDefault();
    const row = rowAt(e.clientX, e.clientY);
    rowsEl.querySelectorAll('.tl-row.drop').forEach((r) => r.classList.remove('drop'));
    if (row) row.classList.add('drop');
  });
  rowsEl.addEventListener('dragleave', () => rowsEl.querySelectorAll('.tl-row.drop').forEach((r) => r.classList.remove('drop')));
  rowsEl.addEventListener('drop', onDrop);
}

export function setZoom(pps) {
  S.pps = clamp(pps, 4, 800);
  emit('zoom', S.pps);
  render();
}

export function zoomToFit() {
  const w = scrollEl.clientWidth - HEAD - 60;
  setZoom(w / Math.max(5, S.project.duration));
  scrollEl.scrollLeft = 0;
}

function schedule(light = false) {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}

const timeToX = (t) => t * S.pps;
function clientToTime(clientX) {
  const rect = scrollEl.getBoundingClientRect();
  return (clientX - rect.left + scrollEl.scrollLeft - HEAD) / S.pps;
}

function displayTracks() {
  const tr = S.project.tracks;
  const nonAudio = tr.filter((t) => t.kind !== 'audio').reverse();
  return [...nonAudio, ...tr.filter((t) => t.kind === 'audio')];
}

export function render() {
  if (!S.project) return;
  const p = S.project;
  const width = Math.max(scrollEl.clientWidth, HEAD + timeToX(p.duration + 30));
  contentEl.style.width = width + 'px';
  rulerEl.width = width - HEAD; rulerEl.style.width = (width - HEAD) + 'px';
  const sel = S.sel;
  let html = '';
  for (const track of displayTracks()) {
    const isMain = track.kind === 'main';
    html += `<div class="tl-row ${track.kind}" data-track="${track.id}">`;
    html += `<div class="tl-head">
      <span class="nm" title="${esc(track.name)}">${isMain ? 'Principal' : esc(track.name)}</span>
      ${track.kind !== 'audio' && track.kind !== 'effect' ? `<button class="icon-btn ${track.hidden ? 'on' : ''}" data-act="hide" title="Ocultar faixa">${icon(track.hidden ? 'eyeoff' : 'eye')}</button>` : ''}
      ${track.kind === 'main' || track.kind === 'video' || track.kind === 'audio' ? `<button class="icon-btn ${track.muted ? 'on' : ''}" data-act="mute" title="Silenciar faixa">${icon(track.muted ? 'mute' : 'vol')}</button>` : ''}
    </div><div class="tl-lane">`;
    if (isMain && !track.clips.length) html += `<div class="lane-empty">${icon('media')} Arraste vídeos e fotos para cá</div>`;
    track.clips.forEach((c, i) => {
      html += clipHtml(c, track, sel && sel.kind === 'clip' && sel.id === c.id);
      if (isMain && i < track.clips.length - 1) {
        const next = track.clips[i + 1];
        const x = timeToX(next.start + (c._trDur || 0) / 2);
        const has = c.transition && c.transition.type !== 'none';
        const jsel = sel && sel.kind === 'junction' && sel.id === c.id;
        html += `<button class="junction ${has ? 'has' : ''} ${jsel ? 'sel' : ''}" data-junction="${c.id}" style="left:${x}px" title="Transição">${has ? '⇄' : '+'}</button>`;
      }
    });
    html += `</div></div>`;
  }
  rowsEl.innerHTML = html;
  rowsEl.querySelectorAll('canvas.wave').forEach(drawWave);
  paintThumbs();
  drawRuler();
  updatePlayhead();
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function clipHtml(c, track, isSel) {
  const p = S.project;
  const m = p.media[c.mediaId];
  const left = timeToX(c.start), w = Math.max(4, timeToX(clipDuration(c)));
  let inner = '', label = '';
  if ((c.type === 'video' || c.type === 'image') && m) {
    inner += `<canvas class="thumbs" data-thumbs="${c.id}"></canvas>`;
    label = esc(m.name);
  } else if (c.type === 'audio' && m) {
    inner += `<canvas class="wave" data-media="${m.id}" data-in="${c.in}" data-out="${c.out}" width="${Math.min(4000, Math.ceil(w))}" height="40"></canvas>`;
    label = esc(m.name);
  } else if (c.type === 'text') label = `T&nbsp; <span data-noi18n>${esc(c.text.replace(/\n/g, ' '))}</span>`;
  else if (c.type === 'sticker') label = `<span style="font-family:'Segoe UI Emoji','Noto Color Emoji'">${esc(c.text)}</span> Sticker`;
  else if (c.type === 'effect') { const e = EFFECTS.find((x) => x.id === c.effect); label = `<span>${e?.icon || '✦'}</span> <span>${esc(e?.name || c.effect)}</span>`; }
  const badges = [];
  if (hasSourceRange(c) && c.speed !== 1) badges.push(`${+c.speed.toFixed(2)}x`);
  if (c.reverseOf) badges.push('⟲');
  if (c.filter && c.filter.name !== 'none') badges.push('Filtro');
  if (c.chroma?.on) badges.push('Chroma');
  if (c.mask && c.mask.type !== 'none') badges.push('Máscara');
  badges.push(fmtDur(clipDuration(c)));
  let extra = '';
  if (isSel && c.keyframes?.length) for (const k of c.keyframes) extra += `<div class="kf" style="left:${timeToX(k.t)}px"></div>`;
  if ((c.type === 'audio' || c.type === 'video') && (c.fadeIn > 0 || c.fadeOut > 0)) {
    if (c.fadeIn > 0) extra += `<div class="fadebar" style="left:0;width:${timeToX(c.fadeIn)}px;background:linear-gradient(90deg,rgba(0,0,0,.55),transparent)"></div>`;
    if (c.fadeOut > 0) extra += `<div class="fadebar" style="right:0;width:${timeToX(c.fadeOut)}px;background:linear-gradient(270deg,rgba(0,0,0,.55),transparent)"></div>`;
  }
  const mutedIco = c.muted ? `<span class="muted-ico">🔇</span>` : '';
  return `<div class="clip ${c.type} ${c.caption ? 'caption' : ''} ${isSel ? 'sel' : ''}" data-clip="${c.id}" style="left:${left}px;width:${w}px">
    ${inner}<div class="lbl">${label}${badges.map((b) => `<span class="b">${b}</span>`).join('')}</div>${extra}${mutedIco}
    <div class="trim l" data-trim="l"></div><div class="trim r" data-trim="r"></div></div>`;
}

// Filmstrip: tiles keep the media aspect ratio (never stretched); each tile shows the frame at its own
// position in the clip. Only the visible part of each clip is painted, so very long clips stay cheap.
function paintThumbs() {
  const dpr = window.devicePixelRatio || 1;
  const view0 = scrollEl.scrollLeft - HEAD - 300, view1 = scrollEl.scrollLeft - HEAD + scrollEl.clientWidth + 300;
  rowsEl.querySelectorAll('canvas.thumbs').forEach((cv) => {
    const f = findClip(S.project, cv.dataset.thumbs);
    if (!f) return;
    const c = f.clip;
    const m = S.project.media[c.mediaId];
    const strip = m && cache.strips[m.id];
    const clipX = timeToX(c.start), W = timeToX(clipDuration(c));
    const v0 = Math.max(0, Math.floor(view0 - clipX)), v1 = Math.min(W, Math.ceil(view1 - clipX));
    if (!strip || v1 <= v0) { cv.style.display = 'none'; return; }
    const H = cv.parentElement.clientHeight || 40;
    cv.style.display = 'block';
    cv.style.left = v0 + 'px';
    cv.style.width = v1 - v0 + 'px';
    const pw = Math.round((v1 - v0) * dpr), ph = Math.round(H * dpr);
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, -v0 * dpr, 0);
    ctx.fillStyle = '#10141a';
    ctx.fillRect(v0, 0, v1 - v0, H);
    const tw = Math.max(8, H * (strip.w / strip.h));
    for (let x = Math.floor(v0 / tw) * tw; x < v1; x += tw) {
      if (strip.still) {
        // cover-crop the photo into the tile
        const s = Math.max(tw / strip.w, H / strip.h);
        const sw = tw / s, sh = H / s;
        ctx.drawImage(strip.img, (strip.w - sw) / 2, (strip.h - sh) / 2, sw, sh, x, 0, tw, H);
      } else {
        const rel = Math.min(1, (x + tw / 2) / Math.max(1, W));
        const src = c.in + rel * (c.out - c.in);
        const idx = Math.max(0, Math.min(strip.n - 1, Math.floor((src / Math.max(0.01, m.duration)) * strip.n)));
        ctx.drawImage(strip.img, idx * strip.w, 0, strip.w, strip.h, x, 0, tw, H);
      }
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(x + tw - 1, 0, 1, H);
    }
  });
}

let thumbRaf = 0;
function schedulePaintThumbs() {
  if (thumbRaf) return;
  thumbRaf = requestAnimationFrame(() => { thumbRaf = 0; paintThumbs(); });
}

function drawWave(cv) {
  const peaks = cache.peaks[cv.dataset.media];
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!peaks) return;
  const a = +cv.dataset.in * 100, b = +cv.dataset.out * 100;
  ctx.fillStyle = 'rgba(190,255,215,.8)';
  const H = cv.height;
  for (let x = 0; x < cv.width; x++) {
    const i0 = Math.floor(a + (x / cv.width) * (b - a)), i1 = Math.max(i0 + 1, Math.floor(a + ((x + 1) / cv.width) * (b - a)));
    let mx = 0;
    for (let i = i0; i < i1 && i < peaks.length; i++) mx = Math.max(mx, peaks[i]);
    const h = Math.max(1, Math.min(1, mx * 1.4) * H);
    ctx.fillRect(x, H - h, 1, h);
  }
}

function drawRuler() {
  if (!S.project) return;
  const ctx = rulerEl.getContext('2d');
  const W = rulerEl.width, H = 26;
  if (rulerEl.height !== H) rulerEl.height = H;
  ctx.clearRect(0, 0, W, H);
  const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * S.pps >= 80) || 600;
  const minor = major / 5;
  const x0 = Math.max(0, scrollEl.scrollLeft - HEAD), x1 = x0 + scrollEl.clientWidth;
  ctx.fillStyle = '#5c6575';
  ctx.font = '10px "Segoe UI", Ubuntu, "DejaVu Sans", sans-serif';
  for (let i = Math.floor(x0 / S.pps / minor); i * minor * S.pps <= x1; i++) {
    const t = i * minor;
    const x = Math.round(t * S.pps) + 0.5;
    const isMajor = i % 5 === 0;
    ctx.fillRect(x, isMajor ? 12 : 18, 1, isMajor ? 14 : 8);
    if (isMajor) {
      ctx.fillStyle = '#8b93a3';
      const ts = Math.round(t * 1000) / 1000;
      const lbl = major < 1 ? fmtTime(ts + 1e-6, S.project.fps) : `${String(Math.floor(ts / 60)).padStart(2, '0')}:${String(Math.round(ts % 60)).padStart(2, '0')}`;
      ctx.fillText(lbl, x + 3, 10);
      ctx.fillStyle = '#5c6575';
    }
  }
}

export function updatePlayhead(follow = false) {
  if (!S.project) return;
  const x = HEAD + timeToX(S.t);
  playheadEl.style.left = x + 'px';
  if (follow) {
    const vis0 = scrollEl.scrollLeft + HEAD, vis1 = scrollEl.scrollLeft + scrollEl.clientWidth;
    if (x > vis1 - 40 || x < vis0) scrollEl.scrollLeft = x - HEAD - 40;
  }
}

function startScrub(e) {
  e.preventDefault();
  emit('pause');
  const move = (ev) => seek(clientToTime(ev.clientX));
  move(e);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function rowAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('.tl-row') : null;
}
const trackById = (id) => S.project.tracks.find((t) => t.id === id);

function snapPoints(exceptId) {
  const pts = [0, S.t];
  for (const tr of S.project.tracks) for (const c of tr.clips) {
    if (c.id === exceptId) continue;
    pts.push(c.start, c.start + clipDuration(c));
  }
  return pts;
}

function snapTime(t, pts) {
  if (!S.snap) return { t, hit: null };
  const tol = 8 / S.pps;
  let best = null, bd = tol;
  for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
  return best == null ? { t, hit: null } : { t: best, hit: best };
}

function showSnap(t) {
  if (t == null) { snapEl.classList.add('hidden'); return; }
  snapEl.classList.remove('hidden');
  snapEl.style.left = HEAD + timeToX(t) + 'px';
}

function onRowsPointerDown(e) {
  if (e.button !== 0) return;
  const head = e.target.closest('.tl-head');
  if (head) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const track = trackById(head.parentElement.dataset.track);
    checkpoint();
    if (btn.dataset.act === 'hide') track.hidden = !track.hidden;
    if (btn.dataset.act === 'mute') track.muted = !track.muted;
    changed('structure');
    return;
  }
  const j = e.target.closest('[data-junction]');
  if (j) { select({ kind: 'junction', id: j.dataset.junction }); emit('lib-tab', 'transitions'); return; }
  const clipEl = e.target.closest('.clip');
  if (!clipEl) {
    select(null);
    startScrub(e);
    return;
  }
  e.preventDefault();
  const id = clipEl.dataset.clip;
  const found = findClip(S.project, id);
  if (!found) return;
  if (!S.sel || S.sel.id !== id) select({ kind: 'clip', id });
  const trim = e.target.dataset.trim;
  if (trim) startTrim(e, found, trim);
  else startMove(e, found, clipEl);
}

function startTrim(e, found, side) {
  const { clip: c, track } = found;
  const m = S.project.media[c.mediaId];
  const orig = { start: c.start, in: c.in, out: c.out, dur: c.dur };
  const x0 = e.clientX;
  const pts = snapPoints(c.id);
  let started = false;
  const move = (ev) => {
    const dt0 = (ev.clientX - x0) / S.pps;
    if (!started) { if (Math.abs(ev.clientX - x0) < 2) return; checkpoint(); started = true; }
    let hit = null;
    if (side === 'l') {
      let dt = dt0;
      if (track.kind !== 'main') { const s = snapTime(orig.start + dt, pts); dt = s.t - orig.start; hit = s.hit; }
      if (hasSourceRange(c)) {
        const nin = clamp(orig.in + dt * c.speed, 0, orig.out - 0.1);
        dt = (nin - orig.in) / c.speed;
        c.in = nin;
      } else {
        dt = Math.min(dt, orig.dur - 0.1);
        c.dur = orig.dur - dt;
      }
      if (track.kind !== 'main') {
        c.start = Math.max(0, orig.start + dt);
      }
    } else {
      const endOrig = orig.start + (hasSourceRange(c) ? (orig.out - orig.in) / c.speed : orig.dur);
      const s = snapTime(endOrig + dt0, pts); hit = s.hit;
      const dt = s.t - endOrig;
      if (hasSourceRange(c)) c.out = clamp(orig.out + dt * c.speed, orig.in + 0.1, m ? m.duration : orig.out);
      else c.dur = Math.max(0.1, orig.dur + dt);
    }
    if (c.keyframes?.length) c.keyframes = c.keyframes.filter((k) => k.t <= clipDuration(c));
    c.fadeIn = Math.min(c.fadeIn || 0, clipDuration(c)); c.fadeOut = Math.min(c.fadeOut || 0, clipDuration(c));
    showSnap(hit);
    changed('trim');
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    showSnap(null);
    if (started) changed('structure');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startMove(e, found, clipEl) {
  const { clip: c } = found;
  let track = found.track;
  const x0 = e.clientX;
  const origStart = c.start;
  const pts = snapPoints(c.id);
  const dur = clipDuration(c);
  let started = false, mainIndex = null;
  const move = (ev) => {
    if (!started) { if (Math.abs(ev.clientX - x0) < 3) return; checkpoint(); started = true; }
    const dt = (ev.clientX - x0) / S.pps;
    if (track.kind === 'main') {
      // reorder: show insertion marker
      const el = rowsEl.querySelector(`[data-clip="${c.id}"]`);
      if (el) { el.classList.add('dragging'); el.style.transform = `translateX(${ev.clientX - x0}px)`; }
      const t = clientToTime(ev.clientX);
      const clips = mainTrack().clips;
      let idx = clips.length;
      for (let i = 0; i < clips.length; i++) if (t < clips[i].start + clipDuration(clips[i]) / 2) { idx = i; break; }
      mainIndex = idx;
      const xs = idx < clips.length ? clips[idx].start : S.project.tracks[0].clips.reduce((a, x) => Math.max(a, x.start + clipDuration(x)), 0);
      const row = rowsEl.querySelector(`[data-track="${track.id}"]`);
      insertEl.classList.remove('hidden');
      insertEl.style.left = HEAD + timeToX(xs) - 1 + 'px';
      insertEl.style.top = row.offsetTop + 'px';
      insertEl.style.height = row.offsetHeight + 'px';
      return;
    }
    let ns = Math.max(0, origStart + dt);
    const s1 = snapTime(ns, pts), s2 = snapTime(ns + dur, pts);
    let hit = null;
    if (s1.hit != null && (s2.hit == null || Math.abs(s1.t - ns) <= Math.abs(s2.t - ns - dur))) { ns = s1.t; hit = s1.hit; }
    else if (s2.hit != null) { ns = s2.t - dur; hit = s2.hit; }
    c.start = Math.max(0, ns);
    // vertical move to a compatible track
    const row = rowAt(ev.clientX, ev.clientY);
    if (row) {
      const tgt = trackById(row.dataset.track);
      if (tgt && tgt !== track && tgt.kind === trackKindForClip(c.type) && tgt.kind !== 'main') {
        track.clips.splice(track.clips.indexOf(c), 1);
        tgt.clips.push(c);
        track = tgt;
      }
    }
    showSnap(hit);
    changed('move');
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    insertEl.classList.add('hidden'); showSnap(null);
    if (!started) return;
    if (track.kind === 'main') {
      if (mainIndex != null) moveMainClip(c.id, mainIndex);
    } else {
      if (overlaps(track, c.start, c.start + dur, c.id)) {
        track.clips.splice(track.clips.indexOf(c), 1);
        const nt = newTrack(track.kind);
        nt.clips.push(c);
      }
      track.clips.sort((a, b) => a.start - b.start);
      cleanupTracks();
    }
    changed('structure');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onDrop(e) {
  rowsEl.querySelectorAll('.tl-row.drop').forEach((r) => r.classList.remove('drop'));
  const raw = e.dataTransfer.getData('application/x-clipnova');
  if (!raw) return;
  e.preventDefault();
  const data = JSON.parse(raw);
  const t = Math.max(0, clientToTime(e.clientX));
  const row = rowAt(e.clientX, e.clientY);
  const track = row ? trackById(row.dataset.track) : null;
  if (data.kind === 'media') {
    const m = S.project.media[data.mediaId];
    if (!m) return;
    if (m.type === 'audio') {
      addMedia(m, { time: t, track: track && track.kind === 'audio' ? track : null });
    } else if (track && track.kind === 'main') {
      addMedia(m, { time: t });
    } else if (track && track.kind === 'video') {
      addMedia(m, { time: t, track });
    } else if (!S.project.tracks[0].clips.length) {
      addMedia(m, {});
    } else {
      addMedia(m, { time: t, overlay: true });
    }
  } else if (data.kind === 'clip') {
    data.clip.id = uid();
    addClip(data.clip, t);
  }
}

function onContextMenu(e) {
  const clipEl = e.target.closest('.clip');
  if (!clipEl) return;
  e.preventDefault();
  select({ kind: 'clip', id: clipEl.dataset.clip });
  emit('context-menu', { x: e.clientX, y: e.clientY });
}

export function trackLabel(kind) { return TRACK_LABEL[kind]; }
export { toast };
