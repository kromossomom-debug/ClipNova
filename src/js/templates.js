// Ready-made templates (original designs) and user templates saved from a project.
import { S, emit, checkpoint, changed, mainTrack, mainIndexAt, placeClip, setRatio, toast } from './store.js';
import { makeTextClip, makeShapeClip, makeColorClip, deepClone, uid, layout, clipDuration } from './model.js';
import { ensureVisuals } from './media.js';
import { brand } from './brand.js';
import { t } from './i18n.js';

// text clip with nested overrides
function T(text, o = {}) {
  const c = makeTextClip(t(text));
  if (brand.fontTitle && o.title !== false) c.font = brand.fontTitle;
  else if (brand.fontBody) c.font = brand.fontBody;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'title') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && c[k] && typeof c[k] === 'object') Object.assign(c[k], v);
    else c[k] = v;
  }
  return c;
}
const anim = (inT = 'none', outT = 'none', loop = 'none', inDur = 0.5, outDur = 0.5) => ({ in: { type: inT, dur: inDur }, out: { type: outT, dur: outDur }, loop: { type: loop, speed: 1 } });
const shape = (s, o) => { const c = makeShapeClip(s, o); if (o.anim) c.anim = o.anim; return c; };
// square-looking shape: w is relative to width, so correct for the frame aspect
const sq = (h, W, H) => (h * H) / W;

// Each template returns { main: [clips], over: [[startOffset, clip], …] }.
export const BUILTIN = [
  {
    id: 'yt-intro', name: 'Abertura de vídeo', desc: 'Título animado com faixa de destaque', ratio: '16:9', kind: 'project',
    colors: ['#8e2de2', '#4a00e0'],
    build: () => ({
      main: [Object.assign(makeColorClip('#8e2de2', '#4a00e0', 135), { dur: 5 })],
      over: [
        [0, Object.assign(T('SEU TÍTULO AQUI', { size: 0.12, y: -0.05 }), { dur: 5, anim: anim('pop', 'fade', 'none', 0.6, 0.6) })],
        [0.4, Object.assign(T('Subtítulo do vídeo', { size: 0.05, y: 0.1, bold: false, title: false }), { dur: 4.6, anim: anim('slide-up', 'fade', 'none', 0.6) })],
        [0.2, shape('bar', { w: 0.22, h: 0.012, y: 0.035, fill: '#ffd200', dur: 4.8, anim: anim('zoom-in', 'fade') })],
      ],
    }),
  },
  {
    id: 'story', name: 'Story vertical', desc: 'Cartela 9:16 para redes sociais', ratio: '9:16', kind: 'project',
    colors: ['#fc466b', '#3f5efb'],
    build: (W, H) => ({
      main: [Object.assign(makeColorClip('#fc466b', '#3f5efb', 160), { dur: 6 })],
      over: [
        [0, shape('round', { w: 0.82, h: 0.34, y: -0.02, fill: '#ffffff', opacity: 0.16, radius: 0.35, dur: 6, anim: anim('zoom-out', 'fade') })],
        [0.2, Object.assign(T('NOVIDADE', { size: 0.03, y: -0.13, color: '#111111', bg: { color: '#ffffff', opacity: 1, radius: 0.6, padding: 0.5 } }), { dur: 5.8, anim: anim('slide-down', 'fade') })],
        [0.4, Object.assign(T('Conte sua\nhistória aqui', { size: 0.06, y: 0, lineHeight: 1.1 }), { dur: 5.6, anim: anim('pop', 'fade') })],
        [1, Object.assign(T('Arraste para cima ↑', { size: 0.028, y: 0.4, bold: false, title: false }), { dur: 5, anim: anim('fade', 'fade', 'float') })],
      ],
    }),
  },
  {
    id: 'lower-third', name: 'Terço inferior', desc: 'Nome e cargo sobre o seu vídeo', ratio: null, kind: 'overlay',
    colors: ['#7c5cff', '#202633'],
    build: () => ({
      main: [],
      over: [
        [0, shape('bar', { w: 0.4, h: 0.12, x: -0.26, y: 0.33, fill: '#7c5cff', fill2: '#4a00e0', radius: 0.3, dur: 5, anim: anim('slide-right', 'slide-left') })],
        [0.25, Object.assign(T('Nome Sobrenome', { size: 0.045, x: -0.26, y: 0.315 }), { dur: 4.75, anim: anim('fade', 'fade') })],
        [0.4, Object.assign(T('Cargo ou descrição', { size: 0.028, x: -0.26, y: 0.36, bold: false, color: '#e3dcff', title: false }), { dur: 4.6, anim: anim('fade', 'fade') })],
      ],
    }),
  },
  {
    id: 'quote', name: 'Citação', desc: 'Frase em destaque com autor', ratio: null, kind: 'project',
    colors: ['#202633', '#7c5cff'],
    build: () => ({
      main: [Object.assign(makeColorClip('#202633'), { dur: 6 })],
      over: [
        [0, Object.assign(T('“', { size: 0.32, y: -0.2, color: '#7c5cff', font: 'Georgia' }), { dur: 6, anim: anim('zoom-out', 'fade') })],
        [0.3, Object.assign(T('Uma frase marcante\nvai aqui.', { size: 0.065, y: 0, italic: true, font: 'Georgia' }), { dur: 5.7, anim: anim('typewriter', 'fade', 'none', 1.6) })],
        [1.8, Object.assign(T('— Nome do autor', { size: 0.035, y: 0.17, bold: false, color: '#9aa3b5', title: false }), { dur: 4.2, anim: anim('fade', 'fade') })],
      ],
    }),
  },
  {
    id: 'countdown', name: 'Contagem regressiva', desc: '3, 2, 1… em cores vivas', ratio: null, kind: 'project',
    colors: ['#ff4f7b', '#16c79a'],
    build: () => ({
      main: ['#ff4f7b', '#ffb020', '#16c79a'].map((col) => Object.assign(makeColorClip(col), { dur: 1 })),
      over: ['3', '2', '1'].map((n, i) => [i, Object.assign(T(n, { size: 0.4, shadow: { opacity: 0.35 } }), { dur: 1, anim: anim('pop', 'zoom-in', 'none', 0.35, 0.25) })]),
    }),
  },
  {
    id: 'outro', name: 'Encerramento', desc: 'Agradecimento e chamada para ação', ratio: '16:9', kind: 'project',
    colors: ['#232526', '#ff3b5c'],
    build: (W, H) => ({
      main: [Object.assign(makeColorClip('#232526', '#414345', 90), { dur: 6 })],
      over: [
        [0, Object.assign(T('Obrigado por assistir!', { size: 0.08, y: -0.16 }), { dur: 6, anim: anim('slide-down', 'fade') })],
        [0.5, shape('round', { w: 0.24, h: 0.11, y: 0.06, fill: '#ff3b5c', radius: 0.9, dur: 5.5, anim: anim('pop', 'fade', 'pulse') })],
        [0.5, Object.assign(T('INSCREVA-SE', { size: 0.045, y: 0.06 }), { dur: 5.5, anim: anim('pop', 'fade', 'pulse') })],
        [1, Object.assign(T('Curta, comente e compartilhe', { size: 0.035, y: 0.22, bold: false, color: '#c9ced8', title: false }), { dur: 5, anim: anim('fade', 'fade') })],
      ],
    }),
  },
  {
    id: 'sale', name: 'Promoção', desc: 'Oferta chamativa com preço', ratio: null, kind: 'project',
    colors: ['#f7971e', '#ffd200'],
    build: (W, H) => ({
      main: [Object.assign(makeColorClip('#f7971e', '#ffd200', 120), { dur: 5 })],
      over: [
        [0, shape('star', { w: sq(0.75, W, H), h: 0.75, fill: '#ffffff', opacity: 0.18, dur: 5, anim: anim('spin', 'fade', 'wobble') })],
        [0, Object.assign(T('OFERTA', { size: 0.07, y: -0.17, color: '#1a1a1a' }), { dur: 5, anim: anim('slide-down', 'fade') })],
        [0.3, Object.assign(T('50% OFF', { size: 0.17, y: 0.01, stroke: { color: '#7a2e00', width: 0.25 } }), { dur: 4.7, anim: anim('pop', 'zoom-in', 'pulse') })],
        [0.8, Object.assign(T('Só esta semana', { size: 0.04, y: 0.2, bg: { color: '#1a1a1a', opacity: 1, radius: 0.5, padding: 0.45 } }), { dur: 4.2, anim: anim('slide-up', 'fade') })],
      ],
    }),
  },
  {
    id: 'title', name: 'Título simples', desc: 'Texto grande sobre o seu vídeo', ratio: null, kind: 'overlay',
    colors: ['#000000', '#ffffff'],
    build: () => ({
      main: [],
      over: [[0, Object.assign(T('Seu texto aqui', { size: 0.1, shadow: { opacity: 0.7 } }), { dur: 4, anim: anim('pop', 'fade') })]],
    }),
  },
];

export function isEmptyProject() { return S.project.tracks.every((tr) => !tr.clips.length); }

// Insert a built-in template: on an empty project it becomes the project; otherwise it is added at the playhead.
export function applyBuiltin(tpl) {
  checkpoint();
  const empty = isEmptyProject();
  if (empty && tpl.ratio && S.project.ratio !== tpl.ratio) setRatio(tpl.ratio);
  const { main, over } = tpl.build(S.project.width, S.project.height);
  let base = S.t;
  if (main.length) {
    const idx = mainTrack().clips.length ? mainIndexAt(S.t) : 0;
    mainTrack().clips.splice(idx, 0, ...main);
    layout(S.project);
    base = main[0].start;
  }
  for (const [dt, c] of over) placeClip(c, base + dt);
  S.sel = null;
  S.t = base;
  changed('structure');
  emit('seek', S.t);
  toast(empty ? 'Modelo aplicado — clique nos textos para editar' : 'Modelo inserido no cursor');
}

// ---------- user templates ----------
export async function saveAsTemplate(name, thumb) {
  const p = S.project;
  const used = new Set();
  for (const tr of p.tracks) for (const c of tr.clips) if (c.mediaId) used.add(c.mediaId);
  const tpl = {
    id: uid(), name, createdAt: Date.now(), thumb, ratio: p.ratio, width: p.width, height: p.height, duration: p.duration,
    background: deepClone(p.background),
    media: Object.fromEntries([...used].map((id) => [id, deepClone(p.media[id])]).filter(([, m]) => m)),
    tracks: deepClone(p.tracks),
  };
  await window.native.templateSave(tpl);
  toast('Modelo salvo em “Meus modelos”');
}

export function applyUserTemplate(tpl) {
  checkpoint();
  const p = S.project;
  const empty = isEmptyProject();
  if (empty) {
    p.ratio = tpl.ratio; p.width = tpl.width; p.height = tpl.height;
    p.background = deepClone(tpl.background);
    emit('resize');
  }
  for (const [id, m] of Object.entries(tpl.media || {})) {
    if (!p.media[id]) { p.media[id] = deepClone(m); ensureVisuals(p.media[id], () => emit('media-visuals', id)); }
  }
  const fresh = (c) => Object.assign(deepClone(c), { id: uid() });
  const [srcMain, ...rest] = tpl.tracks;
  const mainClips = srcMain.clips.map(fresh);
  let base = S.t;
  if (mainClips.length) {
    const idx = mainTrack().clips.length ? mainIndexAt(S.t) : 0;
    mainTrack().clips.splice(idx, 0, ...mainClips);
    layout(p);
    base = mainClips[0].start;
  }
  for (const tr of rest) {
    if (!tr.clips.length) continue;
    for (const c of tr.clips) placeClip(fresh(c), base + c.start);
  }
  S.sel = null;
  changed('structure');
  toast('Modelo aplicado');
}

export function templateDuration(tpl) {
  const { main, over } = tpl.build(1920, 1080);
  const m = main.reduce((a, c) => a + clipDuration(c), 0);
  return Math.max(m, ...over.map(([dt, c]) => dt + clipDuration(c)));
}
