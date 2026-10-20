// Project data model and pure helpers. Everything stored in the project is plain JSON.

import { t } from './i18n.js';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const deepClone = (o) => JSON.parse(JSON.stringify(o));

export const RATIOS = {
  '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:3': [4, 3], '3:4': [3, 4],
  '4:5': [4, 5], '21:9': [21, 9], '2:1': [2, 1],
};

export function sizeForRatio(ratio, shortSide = 1080) {
  const [a, b] = RATIOS[ratio] || RATIOS['16:9'];
  const even = (v) => Math.round(v / 2) * 2;
  return a >= b ? { width: even(shortSide * a / b), height: shortSide } : { width: shortSide, height: even(shortSide * b / a) };
}

export function newProject(name = 'Projeto sem título', ratio = '16:9') {
  const { width, height } = sizeForRatio(ratio);
  const now = Date.now();
  return {
    version: 1, id: uid(), name, createdAt: now, updatedAt: now, ratio, width, height, fps: 30,
    background: { mode: 'color', color: '#000000', blur: 0.6 },
    media: {},
    tracks: [{ id: uid(), kind: 'main', name: 'Principal', muted: false, hidden: false, locked: false, clips: [] }],
    duration: 0,
  };
}

export const TRACK_LABEL = { main: 'Principal', video: 'Sobreposição', graphic: 'Gráficos', text: 'Texto', effect: 'Efeito', audio: 'Áudio' };

export function trackKindForClip(type) {
  if (type === 'text' || type === 'sticker') return 'text';
  if (type === 'shape') return 'graphic';
  if (type === 'effect') return 'effect';
  if (type === 'audio') return 'audio';
  return 'video';
}

export const isVisual = (c) => c.type !== 'audio' && c.type !== 'effect';
export const hasSourceRange = (c) => c.type === 'video' || c.type === 'audio';

export function clipDuration(c) {
  return hasSourceRange(c) ? Math.max(0.01, (c.out - c.in) / c.speed) : c.dur;
}

export function baseVisual() {
  return {
    x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false, opacity: 1, blend: 'source-over',
    adjust: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, hue: 0, blur: 0, vignette: 0, sharpen: 0 },
    filter: { name: 'none', intensity: 1 },
    crop: { l: 0, t: 0, r: 0, b: 0 },
    mask: { type: 'none', x: 0, y: 0, w: 0.6, h: 0.6, rotation: 0, feather: 0, invert: false },
    chroma: { on: false, color: '#00ff00', strength: 0.35, smooth: 0.1 },
    anim: { in: { type: 'none', dur: 0.5 }, out: { type: 'none', dur: 0.5 }, loop: { type: 'none', speed: 1 } },
    keyframes: [],
  };
}

export function makeMediaClip(media, kindOverride) {
  const type = kindOverride || media.type;
  const c = { id: uid(), type, mediaId: media.id, start: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false };
  if (type === 'image') { c.dur = 4; }
  else { c.in = 0; c.out = media.duration; }
  if (type !== 'audio') Object.assign(c, baseVisual());
  if (type === 'video' || type === 'image') c.transition = { type: 'none', dur: 0.5 };
  return c;
}

export function makeTextClip(text = t('Digite o texto')) {
  return {
    id: uid(), type: 'text', start: 0, dur: 3, ...baseVisual(),
    text, font: DEFAULT_FONT, size: 0.07, color: '#ffffff', bold: true, italic: false, underline: false,
    align: 'center', letterSpacing: 0, lineHeight: 1.2,
    stroke: { color: '#000000', width: 0 },
    bg: { color: '#000000', opacity: 0, radius: 0.25, padding: 0.3 },
    shadow: { color: '#000000', opacity: 0, blur: 0.15, distance: 0.06, angle: 45 },
    glow: { color: '#ffffff', opacity: 0 },
  };
}

export function makeStickerClip(emoji) {
  return { id: uid(), type: 'sticker', start: 0, dur: 3, ...baseVisual(), text: emoji, size: 0.2 };
}

// Vector shape. w is relative to the frame width, h to the frame height.
export function makeShapeClip(shape, o = {}) {
  return {
    id: uid(), type: 'shape', start: 0, dur: 4, ...baseVisual(), shape, w: 0.3, h: 0.3,
    fill: '#7c5cff', fill2: '', gradAngle: 90, radius: 0.2, stroke: { color: '#ffffff', width: 0 }, ...o,
  };
}

// Full-frame solid colour or gradient (backgrounds, title cards). Lives on the main track like a photo.
export function makeColorClip(color = '#7c5cff', color2 = '', angle = 135) {
  return { id: uid(), type: 'color', start: 0, dur: 4, ...baseVisual(), color, color2, angle, transition: { type: 'none', dur: 0.5 } };
}

export function makeEffectClip(effect) {
  return { id: uid(), type: 'effect', start: 0, dur: 3, effect, intensity: 0.7 };
}

// Lay out the magnetic main track and compute the project duration.
export function layout(project) {
  const main = project.tracks[0];
  let t = 0;
  main.clips.forEach((c, i) => {
    c.start = t;
    const d = clipDuration(c);
    const next = main.clips[i + 1];
    let tr = 0;
    if (next && c.transition && c.transition.type !== 'none') {
      tr = Math.min(c.transition.dur, d / 2, clipDuration(next) / 2);
    }
    c._trDur = tr;
    t += d - tr;
  });
  let dur = t;
  for (const tr of project.tracks) for (const c of tr.clips) dur = Math.max(dur, c.start + clipDuration(c));
  project.duration = dur;
  return dur;
}

export function findClip(project, id) {
  for (const track of project.tracks) {
    const idx = track.clips.findIndex((c) => c.id === id);
    if (idx >= 0) return { track, clip: track.clips[idx], index: idx };
  }
  return null;
}

export function activeClips(track, t) {
  return track.clips.filter((c) => t >= c.start - 1e-6 && t < c.start + clipDuration(c) - 1e-6);
}

// Source time inside the media for timeline time t.
export function sourceTime(c, t) {
  return clamp(c.in + (t - c.start) * c.speed, c.in, Math.max(c.in, c.out - 0.001));
}

// --- Keyframes: interpolate transform/opacity values over time ---
export const KF_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'];

export function kfValues(c, t) {
  const v = { x: c.x, y: c.y, scale: c.scale, rotation: c.rotation, opacity: c.opacity };
  const kfs = c.keyframes;
  if (!kfs || !kfs.length) return v;
  const rel = t - c.start;
  if (rel <= kfs[0].t) return { ...v, ...pick(kfs[0]) };
  const last = kfs[kfs.length - 1];
  if (rel >= last.t) return { ...v, ...pick(last) };
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (rel >= a.t && rel <= b.t) {
      const p = easeInOut((rel - a.t) / Math.max(1e-6, b.t - a.t));
      const o = {};
      for (const k of KF_PROPS) o[k] = a[k] + (b[k] - a[k]) * p;
      return o;
    }
  }
  return v;
}
const pick = (k) => ({ x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity });
export const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
export const easeOut = (p) => 1 - Math.pow(1 - p, 3);

// --- Catalogs (original presets) ---
export const FILTERS = [
  { id: 'none', name: 'Original' },
  { id: 'vivid', name: 'Vívido', f: { saturate: 1.45, contrast: 1.12, brightness: 1.03 } },
  { id: 'warm', name: 'Quente', f: { saturate: 1.15, sepia: 0.18 }, tint: ['#ff9a3c', 0.12] },
  { id: 'cool', name: 'Frio', f: { saturate: 1.05, hue: -8 }, tint: ['#3c8dff', 0.14] },
  { id: 'bw', name: 'P&B', f: { grayscale: 1, contrast: 1.1 } },
  { id: 'noir', name: 'Noir', f: { grayscale: 1, contrast: 1.5, brightness: 0.9 } },
  { id: 'vintage', name: 'Vintage', f: { sepia: 0.45, contrast: 0.92, saturate: 0.85, brightness: 1.05 }, tint: ['#ffcc88', 0.08] },
  { id: 'film', name: 'Película', f: { contrast: 0.88, saturate: 0.8, brightness: 1.08 }, tint: ['#3a6b5a', 0.1] },
  { id: 'sunset', name: 'Pôr do sol', f: { saturate: 1.3, contrast: 1.05 }, tint: ['#ff5e62', 0.16] },
  { id: 'neon', name: 'Neon', f: { saturate: 1.9, contrast: 1.25, hue: 15 }, tint: ['#b14dff', 0.1] },
  { id: 'pastel', name: 'Pastel', f: { saturate: 0.7, brightness: 1.12, contrast: 0.85 }, tint: ['#ffd1e8', 0.12] },
  { id: 'matte', name: 'Fosco', f: { contrast: 0.78, brightness: 1.06, saturate: 0.9 } },
  { id: 'teal', name: 'Azul-petróleo', f: { saturate: 1.15, contrast: 1.1 }, tint: ['#00a3a3', 0.12] },
  { id: 'faded', name: 'Desbotado', f: { saturate: 0.55, contrast: 0.8, brightness: 1.1 } },
  { id: 'drama', name: 'Dramático', f: { contrast: 1.45, saturate: 0.75, brightness: 0.92 } },
  { id: 'golden', name: 'Dourado', f: { saturate: 1.2, sepia: 0.3, brightness: 1.05 }, tint: ['#ffb300', 0.1] },
];

export const TRANSITIONS = [
  { id: 'none', name: 'Nenhuma' },
  { id: 'fade', name: 'Dissolver' },
  { id: 'black', name: 'Fade preto' },
  { id: 'white', name: 'Flash branco' },
  { id: 'slide-left', name: 'Deslizar ←' },
  { id: 'slide-right', name: 'Deslizar →' },
  { id: 'slide-up', name: 'Deslizar ↑' },
  { id: 'push-left', name: 'Empurrar' },
  { id: 'wipe-right', name: 'Cortina' },
  { id: 'wipe-down', name: 'Persiana' },
  { id: 'circle', name: 'Círculo' },
  { id: 'zoom-in', name: 'Zoom' },
  { id: 'blur', name: 'Desfocar' },
  { id: 'spin', name: 'Giro' },
];

export const ANIMS_IN = [
  ['none', 'Nenhuma'], ['fade', 'Surgir'], ['slide-left', 'Entrar ←'], ['slide-right', 'Entrar →'], ['slide-up', 'Subir'],
  ['slide-down', 'Descer'], ['zoom-in', 'Ampliar'], ['zoom-out', 'Reduzir'], ['pop', 'Pular'], ['spin', 'Girar'], ['blur', 'Foco'],
  ['typewriter', 'Máquina de escrever (texto)'],
];
export const ANIMS_OUT = [
  ['none', 'Nenhuma'], ['fade', 'Sumir'], ['slide-left', 'Sair ←'], ['slide-right', 'Sair →'], ['slide-up', 'Subir'],
  ['slide-down', 'Descer'], ['zoom-in', 'Ampliar'], ['zoom-out', 'Reduzir'], ['spin', 'Girar'], ['blur', 'Desfocar'],
];
export const ANIMS_LOOP = [['none', 'Nenhuma'], ['pulse', 'Pulsar'], ['wobble', 'Balançar'], ['float', 'Flutuar'], ['shake', 'Tremer'], ['blink', 'Piscar']];

export const EFFECTS = [
  { id: 'shake', name: 'Tremor', icon: '〰' },
  { id: 'zoom-pulse', name: 'Pulso de zoom', icon: '⊕' },
  { id: 'flash', name: 'Flash', icon: '✦' },
  { id: 'vignette', name: 'Vinheta', icon: '◉' },
  { id: 'vhs', name: 'Fita VHS', icon: '▤' },
  { id: 'rgb-split', name: 'Separação RGB', icon: '◈' },
  { id: 'grain', name: 'Granulado', icon: '░' },
  { id: 'glow', name: 'Brilho suave', icon: '☀' },
  { id: 'letterbox', name: 'Cinema', icon: '▭' },
  { id: 'mirror', name: 'Espelho', icon: '◧' },
  { id: 'old-film', name: 'Filme antigo', icon: '🎞' },
  { id: 'blur-pulse', name: 'Desfoque pulsante', icon: '◌' },
  { id: 'strobe', name: 'Estroboscópio', icon: '⚡' },
  { id: 'invert', name: 'Negativo', icon: '◑' },
];

export const SHAPES = [
  ['rect', 'Retângulo'], ['round', 'Arredondado'], ['circle', 'Círculo'], ['triangle', 'Triângulo'], ['diamond', 'Losango'],
  ['hexagon', 'Hexágono'], ['star', 'Estrela'], ['heart', 'Coração'], ['arrow', 'Seta'], ['bubble', 'Balão de fala'],
  ['line', 'Linha'], ['frame', 'Moldura'], ['ring', 'Anel'], ['bar', 'Barra inferior'],
];

export const BACKGROUNDS = [
  ['#000000', ''], ['#ffffff', ''], ['#7c5cff', ''], ['#ff4f7b', ''], ['#ffb020', ''], ['#16c79a', ''], ['#1e90ff', ''], ['#202633', ''],
  ['#7c5cff', '#ff4f7b'], ['#ff8a00', '#e52e71'], ['#00c6ff', '#0072ff'], ['#11998e', '#38ef7d'], ['#fc466b', '#3f5efb'],
  ['#232526', '#414345'], ['#f7971e', '#ffd200'], ['#8e2de2', '#4a00e0'], ['#ee9ca7', '#ffdde1'], ['#0f2027', '#2c5364'],
];

export const BLEND_MODES = [
  ['source-over', 'Normal'], ['multiply', 'Multiplicar'], ['screen', 'Tela'], ['overlay', 'Sobrepor'], ['darken', 'Escurecer'],
  ['lighten', 'Clarear'], ['color-dodge', 'Subexposição'], ['color-burn', 'Superexposição'], ['hard-light', 'Luz forte'],
  ['soft-light', 'Luz suave'], ['difference', 'Diferença'], ['exclusion', 'Exclusão'],
];

const FONT_CANDIDATES = ['Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Impact', 'Georgia', 'Times New Roman', 'Courier New',
  'Consolas', 'Trebuchet MS', 'Verdana', 'Comic Sans MS', 'Segoe Script', 'Segoe Print', 'Ink Free', 'Gabriola', 'Candara', 'Cambria',
  // Linux
  'Ubuntu', 'Noto Sans', 'Noto Serif', 'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif',
  'Liberation Mono', 'Cantarell', 'Open Sans', 'Roboto', 'Fira Sans', 'Source Sans Pro', 'Lato'];

// Keep only fonts installed on this machine (rendered width differs from a generic fallback).
function installed(font) {
  const c = document.createElement('canvas').getContext('2d');
  const probe = 'mmmmmmmmmmlli1WQ@#';
  return ['monospace', 'serif'].some((base) => {
    c.font = `40px ${base}`;
    const w0 = c.measureText(probe).width;
    c.font = `40px "${font}", ${base}`;
    return c.measureText(probe).width !== w0;
  });
}
export const FONTS = FONT_CANDIDATES.filter(installed);
if (!FONTS.length) FONTS.push('sans-serif');
export const DEFAULT_FONT = FONTS.find((f) => ['Segoe UI', 'Ubuntu', 'Noto Sans', 'DejaVu Sans', 'Liberation Sans', 'Arial'].includes(f)) || FONTS[0];

export const TEXT_STYLES = [
  { name: 'Simples', s: { color: '#ffffff', stroke: { color: '#000000', width: 0 }, bg: { opacity: 0 }, shadow: { opacity: 0 }, glow: { opacity: 0 } } },
  { name: 'Contorno', s: { color: '#ffffff', stroke: { color: '#000000', width: 0.35 }, bg: { opacity: 0 }, shadow: { opacity: 0 }, glow: { opacity: 0 } } },
  { name: 'Legenda', s: { color: '#ffe14d', stroke: { color: '#000000', width: 0.4 }, bg: { opacity: 0 }, shadow: { opacity: 0.6 }, glow: { opacity: 0 } } },
  { name: 'Caixa preta', s: { color: '#ffffff', stroke: { width: 0 }, bg: { color: '#000000', opacity: 0.75 }, shadow: { opacity: 0 }, glow: { opacity: 0 } } },
  { name: 'Caixa branca', s: { color: '#111111', stroke: { width: 0 }, bg: { color: '#ffffff', opacity: 1 }, shadow: { opacity: 0 }, glow: { opacity: 0 } } },
  { name: 'Neon', s: { color: '#ffffff', stroke: { color: '#ff2bd6', width: 0.15 }, bg: { opacity: 0 }, shadow: { opacity: 0 }, glow: { color: '#ff2bd6', opacity: 1 } } },
  { name: 'Sombra', s: { color: '#ffffff', stroke: { width: 0 }, bg: { opacity: 0 }, shadow: { color: '#000000', opacity: 0.9 }, glow: { opacity: 0 } } },
  { name: 'Vermelho', s: { color: '#ffffff', stroke: { width: 0 }, bg: { color: '#e5262d', opacity: 1 }, shadow: { opacity: 0 }, glow: { opacity: 0 } } },
  { name: 'Ciano', s: { color: '#00e5ff', stroke: { color: '#002a33', width: 0.3 }, bg: { opacity: 0 }, shadow: { opacity: 0 }, glow: { color: '#00e5ff', opacity: 0.6 } } },
  { name: 'Ouro', s: { color: '#ffcf40', stroke: { color: '#5a3b00', width: 0.25 }, bg: { opacity: 0 }, shadow: { color: '#000', opacity: 0.5 }, glow: { opacity: 0 } } },
];

export const STICKERS = ('😀 😂 🤣 😍 🥰 😎 🤩 🥳 😭 😡 🤯 😱 🤔 🙄 😴 🤡 👻 💀 👽 🤖 ' +
  '👍 👎 👏 🙌 🙏 💪 👀 👉 👈 ✌️ 🤘 🫶 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 ' +
  '🔥 ✨ ⭐ 🌟 💥 💯 💫 ⚡ 🌈 ☀️ 🌙 ☁️ ❄️ 💧 🎉 🎊 🎁 🎈 🏆 🥇 ' +
  '🎵 🎶 🎤 🎧 📸 🎬 📢 💡 ⏰ 📍 ✅ ❌ ⚠️ ❓ ❗ 💬 💭 🔔 🆕 🆒 ' +
  '🍕 🍔 🍟 🍩 🍰 ☕ 🍺 🍿 🐶 🐱 🦊 🐼 🦄 🐸 🌸 🌹 🌴 🚀 ✈️ 🚗').split(' ');
