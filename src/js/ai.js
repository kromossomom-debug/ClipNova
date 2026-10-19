// AI features (Gemini, user's own key) and local smart tools (FFmpeg).
import { S, emit, checkpoint, changed, selClip, toast, importPaths, addMedia, newTrack, cleanupTracks } from './store.js';
import { makeTextClip, clipDuration, deepClone, uid, TEXT_STYLES, layout, DEFAULT_FONT } from './model.js';
import { mixAudio } from './export.js';
import { progressModal } from './ui.js';

// Electron prefixes IPC errors with "Error invoking remote method '…': Error:" — show only the real message.
export const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

export const LANGS = [
  ['auto', 'Detectar automaticamente'], ['português do Brasil', 'Português (Brasil)'], ['inglês', 'Inglês'], ['espanhol', 'Espanhol'],
  ['francês', 'Francês'], ['italiano', 'Italiano'], ['alemão', 'Alemão'], ['japonês', 'Japonês'], ['coreano', 'Coreano'], ['chinês simplificado', 'Chinês'],
];
export const VOICES = [
  ['Kore', 'Kore — firme'], ['Puck', 'Puck — animada'], ['Charon', 'Charon — informativa'], ['Fenrir', 'Fenrir — empolgada'],
  ['Aoede', 'Aoede — leve'], ['Leda', 'Leda — jovem'], ['Orus', 'Orus — séria'], ['Zephyr', 'Zephyr — clara'],
  ['Sulafat', 'Sulafat — calorosa'], ['Achird', 'Achird — amigável'],
];
export const TONES = [
  ['', 'Natural'], ['Fale de forma animada e empolgada', 'Animado'], ['Fale de forma calma e acolhedora', 'Calmo'],
  ['Fale como um narrador de documentário', 'Documentário'], ['Fale de forma séria e profissional', 'Profissional'], ['Sussurre', 'Sussurrando'],
];
export const POSITIONS = [['bottom', 'Embaixo'], ['center', 'Centro'], ['top', 'Em cima']];
const POS_Y = { bottom: 0.33, center: 0, top: -0.33 };

const captionTracks = () => S.project.tracks.filter((t) => t.caption);

function captionClip(text, start, end, styleName, pos) {
  const c = makeTextClip(text);
  const st = TEXT_STYLES.find((s) => s.name === styleName) || TEXT_STYLES.find((s) => s.name === 'Legenda');
  const s = deepClone(st.s);
  if (s.color) c.color = s.color;
  for (const k of ['stroke', 'bg', 'shadow', 'glow']) if (s[k]) Object.assign(c[k], s[k]);
  Object.assign(c, { caption: true, start, dur: Math.max(0.2, end - start), size: 0.065, y: POS_Y[pos] ?? 0.33, font: DEFAULT_FONT });
  c.bg.padding = 0.25;
  return c;
}

export function insertCaptions(segments, { style, position, replace }) {
  checkpoint();
  if (replace) for (const t of captionTracks()) t.clips = [];
  cleanupTracks();
  const track = newTrack('text');
  track.name = 'Legendas';
  track.caption = true;
  segments.sort((a, b) => a.start - b.start);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const next = segments[i + 1];
    const end = next ? Math.min(s.end, next.start) : s.end;
    if (end - s.start < 0.15) continue;
    track.clips.push(captionClip(s.text, s.start, end, style, position));
  }
  if (!track.clips.length) cleanupTracks();
  changed('structure');
  return track.clips.length;
}

export async function ensureKey() {
  const st = await window.native.aiSettingsGet();
  if (!st.hasKey) { emit('ai-settings'); toast('Configure sua chave da API do Gemini primeiro'); return false; }
  return true;
}

export async function generateCaptions(opts) {
  if (!S.project.duration) { toast('A linha do tempo está vazia'); return; }
  if (!(await ensureKey())) return;
  const pm = progressModal('Legendas automáticas', 'Preparando o áudio da linha do tempo…');
  const off = window.native.onAiProgress(({ step, total }) => pm.set(step / total, `Transcrevendo com IA… parte ${Math.min(step + 1, total)} de ${total}`));
  try {
    layout(S.project);
    const wav = await mixAudio(S.project, 16000, 1);
    if (!wav) { toast('Não há áudio na linha do tempo para transcrever'); return; }
    pm.set(0, 'Enviando para o Gemini…');
    const segs = await window.native.aiTranscribe(wav, { language: opts.language, maxWords: opts.maxWords, duration: S.project.duration });
    const n = insertCaptions(segs, opts);
    toast(n ? `${n} legendas criadas` : 'Nenhuma fala foi detectada no áudio');
  } catch (e) {
    toast('Legendas: ' + errMsg(e), true);
  } finally { off(); pm.close(); }
}

export async function translateCaptions(target) {
  const clips = captionTracks().flatMap((t) => t.clips);
  if (!clips.length) { toast('Gere ou importe legendas primeiro'); return; }
  if (!(await ensureKey())) return;
  const pm = progressModal('Traduzir legendas', 'Traduzindo…');
  const off = window.native.onAiProgress(({ step, total }) => pm.set(step / total));
  try {
    const out = await window.native.aiTranslate(clips.map((c) => c.text), target);
    checkpoint();
    clips.forEach((c, i) => { c.text = out[i]; });
    changed('structure');
    toast(`${clips.length} legendas traduzidas`);
  } catch (e) {
    toast('Tradução: ' + errMsg(e), true);
  } finally { off(); pm.close(); }
}

export async function aiNarration(text, voice, tone) {
  if (!text.trim()) { toast('Escreva o texto da narração'); return; }
  if (!(await ensureKey())) return;
  const pm = progressModal('Narração por IA', 'Gerando voz…');
  pm.set(null);
  try {
    const file = await window.native.aiTts(S.project.id, text.trim(), voice, tone);
    const [m] = await importPaths([file]);
    if (m) {
      m.name = `Narração IA: ${text.trim().slice(0, 30)}`;
      addMedia(m, { time: S.t });
      toast('Narração adicionada na posição do cursor');
    }
  } catch (e) {
    toast('Narração: ' + errMsg(e), true);
  } finally { pm.close(); }
}

// Replace one clip with several pieces covering the given source ranges [[in, out], ...].
function replaceWithRanges(found, ranges) {
  const { track, clip: c, index } = found;
  const pieces = ranges.map(([a, b], i) => {
    const p = deepClone(c);
    p.id = i === 0 ? c.id : uid();
    p.in = a; p.out = b;
    p.keyframes = ranges.length > 1 ? [] : p.keyframes;
    if (p.anim) {
      if (i > 0) p.anim.in = { type: 'none', dur: p.anim.in.dur };
      if (i < ranges.length - 1) p.anim.out = { type: 'none', dur: p.anim.out.dur };
    }
    if (p.transition && i < ranges.length - 1) p.transition = { type: 'none', dur: p.transition.dur };
    if (i > 0) p.fadeIn = 0;
    if (i < ranges.length - 1) p.fadeOut = 0;
    return p;
  });
  track.clips.splice(index, 1, ...pieces);
  if (track.kind !== 'main') {
    let t = c.start;
    for (const p of pieces) { p.start = t; t += clipDuration(p); }
  }
  return pieces;
}

function pickClip(types) {
  const f = selClip();
  if (!f || !types.includes(f.clip.type)) { toast('Selecione um clipe de ' + (types.includes('audio') ? 'vídeo ou áudio' : 'vídeo') + ' na linha do tempo'); return null; }
  return f;
}

export async function removeSilences({ db = -35, minDur = 0.6, pad = 0.12 } = {}) {
  const f = pickClip(['video', 'audio']);
  if (!f) return;
  const c = f.clip;
  const m = S.project.media[c.mediaId];
  if (!m.hasAudio) { toast('Este clipe não tem áudio'); return; }
  const pm = progressModal('Remover silêncios', 'Analisando o áudio…');
  pm.set(null);
  try {
    const sil = await window.native.detectSilence(m.path, c.in, c.out, db, minDur);
    const ranges = [];
    let cur = c.in;
    for (const [s, e] of sil) {
      const cs = Math.max(c.in, s + pad), ce = Math.min(c.out, e - pad);
      if (ce - cs < 0.15) continue;
      if (cs - cur > 0.1) ranges.push([cur, cs]);
      cur = ce;
    }
    if (c.out - cur > 0.1) ranges.push([cur, c.out]);
    const removed = (c.out - c.in) - ranges.reduce((a, [x, y]) => a + (y - x), 0);
    if (!ranges.length || removed < 0.2) { toast('Nenhum silêncio longo encontrado'); return; }
    checkpoint();
    replaceWithRanges(f, ranges);
    changed('structure');
    toast(`${sil.length} silêncio(s) removido(s) — ${(removed / c.speed).toFixed(1)}s a menos`);
  } catch (e) {
    toast('Falha: ' + errMsg(e), true);
  } finally { pm.close(); }
}

export async function splitScenes(sensitivity = 0.35) {
  const f = pickClip(['video']);
  if (!f) return;
  const c = f.clip;
  const m = S.project.media[c.mediaId];
  const pm = progressModal('Dividir por cenas', 'Procurando mudanças de cena…');
  pm.set(null);
  try {
    const cuts = (await window.native.detectScenes(m.path, c.in, c.out, sensitivity)).filter((t) => t > c.in + 0.3 && t < c.out - 0.3);
    if (!cuts.length) { toast('Nenhuma mudança de cena detectada'); return; }
    const pts = [c.in, ...cuts, c.out];
    const ranges = [];
    for (let i = 0; i < pts.length - 1; i++) if (pts[i + 1] - pts[i] > 0.1) ranges.push([pts[i], pts[i + 1]]);
    checkpoint();
    replaceWithRanges(f, ranges);
    changed('structure');
    toast(`Clipe dividido em ${ranges.length} cenas`);
  } catch (e) {
    toast('Falha: ' + errMsg(e), true);
  } finally { pm.close(); }
}

export async function enhanceVoice() {
  const f = pickClip(['video', 'audio']);
  if (!f) return;
  const c = f.clip;
  if (c.enhanceOf) {
    checkpoint();
    c.mediaId = c.enhanceOf;
    delete c.enhanceOf;
    changed('structure');
    toast('Áudio original restaurado');
    return;
  }
  const m = S.project.media[c.mediaId];
  if (!m.hasAudio) { toast('Este clipe não tem áudio'); return; }
  const pm = progressModal('Melhorar voz', 'Reduzindo ruído e normalizando o volume…');
  pm.set(null);
  try {
    const out = await window.native.enhanceAudio(S.project.id, m.path, m.type === 'video');
    const [nm] = await importPaths([out]);
    if (!nm) return;
    nm.name = `${m.name} (voz melhorada)`;
    checkpoint();
    c.enhanceOf = c.mediaId;
    c.mediaId = nm.id;
    changed('structure');
    toast('Voz melhorada: ruído reduzido e volume normalizado');
  } catch (e) {
    toast('Falha: ' + errMsg(e), true);
  } finally { pm.close(); }
}

// ---------- SRT ----------
const srtTime = (t) => {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

export async function exportSrt() {
  let clips = captionTracks().flatMap((t) => t.clips);
  if (!clips.length) clips = S.project.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips.filter((c) => c.type === 'text'));
  if (!clips.length) { toast('Não há legendas ou textos para exportar'); return; }
  clips = [...clips].sort((a, b) => a.start - b.start);
  const body = clips.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.start + clipDuration(c))}\n${c.text}\n`).join('\n');
  const p = await window.native.saveTextFile(S.project.name.replace(/[\\/:*?"<>|]/g, '_'), body, 'srt');
  if (p) toast('Legendas exportadas: ' + p.split(/[\\/]/).pop());
}

export async function importSrt(opts) {
  const txt = await window.native.openTextFile('srt');
  if (txt == null) return;
  const toSec = (s) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : null; };
  const segs = [];
  for (const block of txt.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = toSec(a), end = toSec(b);
    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (start != null && end != null && text) segs.push({ start, end, text });
  }
  if (!segs.length) { toast('Arquivo SRT vazio ou inválido', true); return; }
  const n = insertCaptions(segs, opts);
  toast(`${n} legendas importadas`);
}

export function applyStyleToAllCaptions(src) {
  checkpoint();
  const keys = ['font', 'size', 'color', 'bold', 'italic', 'underline', 'align', 'letterSpacing', 'lineHeight', 'stroke', 'bg', 'shadow', 'glow', 'x', 'y', 'scale', 'rotation', 'opacity', 'anim', 'blend'];
  let n = 0;
  for (const t of captionTracks()) for (const c of t.clips) {
    if (c.id === src.id) continue;
    for (const k of keys) c[k] = deepClone(src[k]);
    n++;
  }
  changed('structure');
  toast(`Estilo aplicado a ${n + 1} legendas`);
}

export function deleteAllCaptions() {
  checkpoint();
  for (const t of captionTracks()) t.clips = [];
  cleanupTracks();
  S.sel = null;
  changed('structure');
}
