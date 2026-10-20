// Right-hand properties panel.
import {
  S, on, emit, checkpoint, changed, selClip, setProp, displayValue, getPath, toggleKeyframe, kfAt, seek,
  setTransition, applyTransitionToAll, setRatio, mainTrack,
} from './store.js';
import {
  clipDuration, findClip, FILTERS, TRANSITIONS, ANIMS_IN, ANIMS_OUT, ANIMS_LOOP, BLEND_MODES, FONTS, TEXT_STYLES, EFFECTS, RATIOS, SHAPES, clamp, deepClone, baseVisual,
} from './model.js';
import { brand } from './brand.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { applyStyleToAllCaptions, deleteAllCaptions } from './ai.js';

let root, pane;
let updaters = [];

const TAB_ICON = {
  'Vídeo': 'transform', 'Básico': 'transform', 'Ajustar': 'filters', 'Animação': 'effects', 'Velocidade': 'speed', 'Áudio': 'vol',
  'Duração': 'clock', 'Texto': 'text', 'Efeito': 'effects', 'Forma': 'shape', 'Cor': 'palette', 'Fade': 'fade', 'Projeto': 'gear', 'Transição': 'transitions',
};
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(k));
  return e;
};

export function initInspector() {
  root = document.getElementById('inspector');
  on('brand', () => render());
  on('change', (kind) => { if (kind === 'props' || kind === 'move' || kind === 'trim') refresh(); else render(); });
  on('seek', () => refresh());
  render();
}

function refresh() {
  const active = document.activeElement;
  for (const u of updaters) u(active);
}

// 'trim' re-renders the timeline but only refreshes (does not rebuild) this panel, so sliders keep working mid-drag.
function commitKind(structure) { return structure ? 'trim' : 'props'; }

// ---------- controls ----------
function range(obj, path, label, o = {}) {
  const { min = 0, max = 1, step = 0.01, mul = 1, unit = '', log = false, structure = false, digits = 0 } = o;
  const slider = h('input', { type: 'range', min: log ? Math.log10(min) : min * mul, max: log ? Math.log10(max) : max * mul, step: log ? 0.001 : step * mul });
  const num = h('input', { class: 'num', type: 'text' });
  const get = () => (o.get ? o.get() : displayValue(obj, path));
  const set = (v) => {
    v = clamp(v, min, max);
    checkpoint(`${obj.id || 'p'}:${path}`);
    if (o.set) o.set(v); else setProp(obj, path, v);
    changed(commitKind(structure));
  };
  const show = (active) => {
    const v = get();
    if (active !== slider) slider.value = log ? Math.log10(v) : v * mul;
    if (active !== num) num.value = (v * mul).toFixed(digits) + unit;
  };
  slider.addEventListener('input', () => set(log ? Math.pow(10, +slider.value) : +slider.value / mul));
  slider.addEventListener('change', () => changed('trim'));
  num.addEventListener('change', () => { const v = parseFloat(num.value.replace(',', '.')); if (!isNaN(v)) set(v / mul); show(null); });
  slider.addEventListener('dblclick', () => { if (o.def != null) { set(o.def); show(null); } });
  updaters.push(show); show(null);
  return h('div', { class: 'row' }, h('label', {}, label), slider, num);
}

function color(obj, path, label, o = {}) {
  const inp = h('input', { type: 'color' });
  const show = () => { inp.value = getPath(obj, path) || '#000000'; };
  inp.addEventListener('input', () => { checkpoint(`${obj.id}:${path}`); setProp(obj, path, inp.value); changed('props'); });
  updaters.push(show); show();
  return h('div', { class: 'row' }, h('label', {}, label), inp, o.extra || null);
}

function select(obj, path, label, options, o = {}) {
  const sel = h('select', {});
  for (const [v, t] of options) sel.append(h('option', { value: v }, t));
  const show = () => { sel.value = String(getPath(obj, path)); };
  sel.addEventListener('change', () => {
    checkpoint();
    let v = sel.value;
    if (o.number) v = +v;
    if (o.set) o.set(v); else setProp(obj, path, v);
    changed(o.structure ? 'structure' : 'props');
    if (o.rerender) render();
  });
  updaters.push(show); show();
  return h('div', { class: 'row' }, h('label', {}, label), sel);
}

function toggle(obj, path, label, o = {}) {
  const b = h('button', { class: 'toggle' });
  const show = () => b.classList.toggle('on', !!getPath(obj, path));
  b.addEventListener('click', () => { checkpoint(); setProp(obj, path, !getPath(obj, path)); changed(o.structure ? 'structure' : 'props'); show(); if (o.rerender) render(); });
  updaters.push(show); show();
  return h('div', { class: 'row' }, h('label', {}, label), b);
}

function seg(obj, path, label, options, o = {}) {
  const wrap = h('div', { class: 'seg' });
  const btns = options.map(([v, t]) => {
    const b = h('button', { title: t, html: t });
    b.addEventListener('click', () => { checkpoint(); if (o.set) o.set(v); else setProp(obj, path, v); changed(o.structure ? 'structure' : 'props'); show(); if (o.rerender) render(); });
    wrap.append(b);
    return [v, b];
  });
  const show = () => { const cur = o.get ? o.get() : getPath(obj, path); btns.forEach(([v, b]) => b.classList.toggle('on', v === cur)); };
  updaters.push(show); show();
  return label ? h('div', { class: 'row' }, h('label', {}, label), wrap) : h('div', { class: 'row' }, wrap);
}

const sect = (title, ...kids) => h('div', { class: 'sect' }, h('div', { class: 'st' }, title), ...kids);

// ---------- render ----------
export function render() {
  updaters = [];
  root.innerHTML = '';
  if (!S.project) return;
  if (S.sel?.kind === 'junction') return renderTransition();
  const f = selClip();
  if (!f) return renderProject();
  const c = f.clip;
  const m = S.project.media[c.mediaId];
  const names = { video: 'Vídeo', image: 'Imagem', audio: 'Áudio', text: 'Texto', sticker: 'Sticker', effect: 'Efeito', shape: 'Forma', color: 'Cor' };

  const tabs = [];
  if (c.type === 'video' || c.type === 'image') {
    tabs.push(['Vídeo', () => [basicSection(c), cropSection(c), maskSection(c), chromaSection(c)]]);
    tabs.push(['Ajustar', () => [filterSection(c), adjustSection(c)]]);
    tabs.push(['Fade', () => [fadeSection(c)]]);
    tabs.push(['Animação', () => animSections(c)]);
    if (c.type === 'video') tabs.push(['Velocidade', () => [speedSection(c)]]);
    if (c.type === 'video' && m?.hasAudio) tabs.push(['Áudio', () => [audioSection(c)]]);
    if (c.type === 'image') tabs.push(['Duração', () => [durationSection(c)]]);
  } else if (c.type === 'text') {
    tabs.push(['Texto', () => textSections(c)]);
    tabs.push(['Básico', () => [basicSection(c), durationSection(c)]]);
    tabs.push(['Fade', () => [fadeSection(c)]]);
    tabs.push(['Animação', () => animSections(c)]);
  } else if (c.type === 'sticker') {
    tabs.push(['Básico', () => [basicSection(c), durationSection(c)]]);
    tabs.push(['Fade', () => [fadeSection(c)]]);
    tabs.push(['Animação', () => animSections(c)]);
  } else if (c.type === 'shape') {
    tabs.push(['Forma', () => shapeSections(c)]);
    tabs.push(['Básico', () => [basicSection(c), durationSection(c)]]);
    tabs.push(['Fade', () => [fadeSection(c)]]);
    tabs.push(['Animação', () => animSections(c)]);
  } else if (c.type === 'color') {
    tabs.push(['Cor', () => [colorClipSection(c), durationSection(c)]]);
    tabs.push(['Fade', () => [fadeSection(c)]]);
    tabs.push(['Ajustar', () => [adjustSection(c)]]);
    tabs.push(['Animação', () => animSections(c)]);
  } else if (c.type === 'audio') {
    tabs.push(['Áudio', () => [audioSection(c), speedSection(c)]]);
  } else if (c.type === 'effect') {
    tabs.push(['Efeito', () => [effectSection(c), durationSection(c)]]);
  }
  let cur = S.inspTab[c.type];
  if (!tabs.find((x) => x[0] === cur)) cur = tabs[0][0];
  shell(tabs.map((x) => x[0]), cur, (name) => { S.inspTab[c.type] = name; render(); });
  pane.append(h('div', { class: 'insp-title' }, h('span', { class: 'chip' }, names[c.type]),
    h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, m ? m.name : c.type === 'text' ? c.text.split('\n')[0] : '')));
  const body = h('div', { class: 'insp-body' });
  body.append(...tabs.find((x) => x[0] === cur)[1]().filter(Boolean));
  pane.append(body);
}

// Right-hand rail of icons, one per property tab; clicking the open tab collapses the panel.
function shell(tabs, cur, onPick) {
  root.innerHTML = '';
  pane = h('div', { class: 'insp-main' });
  const rail = h('nav', { class: 'insp-rail' });
  for (const name of tabs) {
    const b = h('button', { class: 'insp-tab' + (name === cur && !S.inspCollapsed ? ' on' : ''), title: name, html: `${icon(TAB_ICON[name] || 'gear')}<span>${t(name)}</span>` });
    b.addEventListener('click', () => {
      S.inspCollapsed = name === cur ? !S.inspCollapsed : false;
      document.getElementById('workspace').classList.toggle('insp-collapsed', !!S.inspCollapsed);
      onPick(name);
      emit('resize');
    });
    rail.append(b);
  }
  root.append(pane, rail);
}

// Brand-kit colours as one-click swatches.
function brandSwatches(apply) {
  if (!brand.colors.length) return null;
  const row = h('div', { class: 'swatches' });
  for (const col of brand.colors) {
    const b = h('button', { class: 'sw', title: col, style: `background:${col}` });
    b.onclick = () => { checkpoint(); apply(col); changed('structure'); render(); };
    row.append(b);
  }
  return h('div', { class: 'row' }, h('label', {}, 'Kit da marca'), row);
}

function gradientToggle(c, key, def) {
  const b = h('button', { class: 'toggle' + (c[key] ? ' on' : '') });
  b.onclick = () => { checkpoint(); c[key] = c[key] ? '' : def; changed('structure'); render(); };
  return h('div', { class: 'row' }, h('label', {}, 'Gradiente'), b);
}

function shapeSections(c) {
  const grid = h('div', { class: 'preset-grid' });
  SHAPES.forEach(([v, name]) => {
    const b = h('button', { class: c.shape === v ? 'on' : '' }, name);
    b.onclick = () => { checkpoint(); c.shape = v; changed('structure'); render(); };
    grid.append(b);
  });
  const outline = c.shape === 'frame' || c.shape === 'ring';
  return [
    sect('Forma', grid),
    sect('Preenchimento', color(c, 'fill', outline ? 'Cor da borda' : 'Cor'), gradientToggle(c, 'fill2', '#ff4f7b'),
      c.fill2 ? color(c, 'fill2', 'Cor 2') : null,
      c.fill2 ? range(c, 'gradAngle', 'Ângulo', { min: -180, max: 180, step: 1, unit: '°', def: 90 }) : null,
      brandSwatches((col) => { c.fill = col; })),
    sect('Tamanho',
      range(c, 'w', 'Largura', { min: 0.005, max: 1.5, mul: 100, unit: '%', def: 0.3 }),
      range(c, 'h', 'Altura', { min: 0.005, max: 1.5, mul: 100, unit: '%', def: 0.3 }),
      ['round', 'bar', 'frame', 'ring'].includes(c.shape) ? range(c, 'radius', outline ? 'Espessura' : 'Arredondar', { min: 0, max: 1, mul: 100, def: 0.2 }) : null),
    outline ? null : sect('Contorno', color(c, 'stroke.color', 'Cor'), range(c, 'stroke.width', 'Espessura', { min: 0, max: 1, mul: 100, def: 0 })),
  ];
}

function colorClipSection(c) {
  return sect('Cor de fundo',
    color(c, 'color', 'Cor'), gradientToggle(c, 'color2', '#ff4f7b'),
    c.color2 ? color(c, 'color2', 'Cor 2') : null,
    c.color2 ? range(c, 'angle', 'Ângulo', { min: -180, max: 180, step: 1, unit: '°', def: 135 }) : null,
    brandSwatches((col) => { c.color = col; }),
    h('div', { class: 'hint' }, 'Use como fundo de títulos, cartelas e encerramentos.'));
}

// Visual fade in/out (plus the matching audio fade for videos).
function fadeSection(c) {
  const max = Math.max(0.2, Math.min(10, clipDuration(c) / 2));
  const withAudio = c.type === 'video';
  const mk = (side, label) => range(c, `fade.${side}`, label, {
    min: 0, max, step: 0.1, digits: 1, unit: 's', def: 0, structure: true,
    get: () => (c.anim?.[side]?.type === 'fade' ? c.anim[side].dur : 0),
    set: (v) => {
      c.anim[side] = v > 0.05 ? { type: 'fade', dur: v } : { type: 'none', dur: 0.5 };
      if (withAudio) c[side === 'in' ? 'fadeIn' : 'fadeOut'] = v > 0.05 ? v : 0;
    },
  });
  return sect('Fade', mk('in', 'Fade in'), mk('out', 'Fade out'),
    h('div', { class: 'hint' }, withAudio ? 'O fade também é aplicado ao som do clipe.' : 'Surge e some suavemente no início e no fim.'));
}

function kfBar(c) {
  const k = kfAt(c, S.t);
  const kfs = c.keyframes || [];
  const rel = S.t - c.start;
  const prev = [...kfs].reverse().find((x) => x.t < rel - 1e-3);
  const next = kfs.find((x) => x.t > rel + 1e-3);
  const btnPrev = h('button', { title: 'Keyframe anterior' }, '◀');
  const btnTog = h('button', { class: 'kf-btn' + (k ? ' on' : ''), title: 'Adicionar/remover keyframe no cursor' }, '◆ ', k ? 'Remover keyframe' : 'Adicionar keyframe');
  const btnNext = h('button', { title: 'Próximo keyframe' }, '▶');
  btnPrev.disabled = !prev; btnNext.disabled = !next;
  btnPrev.onclick = () => seek(c.start + prev.t);
  btnNext.onclick = () => seek(c.start + next.t);
  btnTog.onclick = () => {
    const inside = S.t >= c.start && S.t <= c.start + clipDuration(c);
    if (!inside) seek(c.start);
    toggleKeyframe(c);
  };
  return h('div', { class: 'btn-row' }, btnPrev, btnTog, btnNext);
}

function basicSection(c) {
  const s = sect('Transformar',
    range(c, 'scale', 'Escala', { min: 0.05, max: 6, mul: 100, unit: '%', def: 1 }),
    range(c, 'x', 'Posição X', { min: -1.5, max: 1.5, mul: 100, def: 0 }),
    range(c, 'y', 'Posição Y', { min: -1.5, max: 1.5, mul: 100, def: 0 }),
    range(c, 'rotation', 'Rotação', { min: -180, max: 180, step: 1, unit: '°', def: 0 }),
    range(c, 'opacity', 'Opacidade', { min: 0, max: 1, mul: 100, unit: '%', def: 1 }),
    select(c, 'blend', 'Mistura', BLEND_MODES),
  );
  const flips = h('div', { class: 'btn-row' });
  const fx = h('button', {}, '⇋ Espelhar H'), fy = h('button', {}, '⇵ Espelhar V'), rs = h('button', {}, 'Redefinir');
  fx.onclick = () => { checkpoint(); c.flipX = !c.flipX; changed('props'); };
  fy.onclick = () => { checkpoint(); c.flipY = !c.flipY; changed('props'); };
  rs.onclick = () => { checkpoint(); Object.assign(c, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipX: false, flipY: false, keyframes: [] }); changed('structure'); };
  flips.append(fx, fy, rs);
  s.append(flips);
  s.append(h('div', { class: 'st', style: 'margin-top:10px', html: `${icon('kf')}<span>Keyframes</span>` }), kfBar(c));
  s.append(h('div', { class: 'hint' }, 'Com keyframes, as alterações de escala, posição, rotação e opacidade são gravadas no ponto do cursor.'));
  return s;
}

function cropSection(c) {
  const s = sect('Recortar',
    range(c, 'crop.l', 'Esquerda', { min: 0, max: 0.45, mul: 100, unit: '%', def: 0 }),
    range(c, 'crop.r', 'Direita', { min: 0, max: 0.45, mul: 100, unit: '%', def: 0 }),
    range(c, 'crop.t', 'Topo', { min: 0, max: 0.45, mul: 100, unit: '%', def: 0 }),
    range(c, 'crop.b', 'Base', { min: 0, max: 0.45, mul: 100, unit: '%', def: 0 }),
  );
  return s;
}

function maskSection(c) {
  const types = [['none', 'Nenhuma'], ['linear', 'Linear'], ['band', 'Faixa'], ['circle', 'Círculo'], ['rect', 'Retângulo'], ['heart', 'Coração'], ['star', 'Estrela']];
  const grid = h('div', { class: 'preset-grid' });
  types.forEach(([v, t]) => {
    const b = h('button', { class: c.mask.type === v ? 'on' : '' }, t);
    b.onclick = () => { checkpoint(); c.mask.type = v; changed('structure'); render(); };
    grid.append(b);
  });
  const s = sect('Máscara', grid);
  if (c.mask.type !== 'none') {
    s.append(
      range(c, 'mask.x', 'Posição X', { min: -1, max: 1, mul: 100, def: 0 }),
      range(c, 'mask.y', 'Posição Y', { min: -1, max: 1, mul: 100, def: 0 }),
    );
    if (c.mask.type !== 'linear') s.append(
      range(c, 'mask.w', 'Largura', { min: 0.02, max: 2, mul: 100, unit: '%', def: 0.6 }),
      range(c, 'mask.h', 'Altura', { min: 0.02, max: 2, mul: 100, unit: '%', def: 0.6 }),
    );
    s.append(
      range(c, 'mask.rotation', 'Rotação', { min: -180, max: 180, step: 1, unit: '°', def: 0 }),
      range(c, 'mask.feather', 'Suavizar', { min: 0, max: 1, mul: 100, def: 0 }),
      toggle(c, 'mask.invert', 'Inverter'),
    );
  }
  return s;
}

function chromaSection(c) {
  const pick = h('button', { title: 'Conta-gotas: clique no reprodutor para escolher a cor' }, '🎯 Escolher');
  pick.onclick = () => emit('pick-color', (hex) => { checkpoint(); c.chroma.color = hex; c.chroma.on = true; changed('structure'); render(); });
  const s = sect('Chroma key', toggle(c, 'chroma.on', 'Ativar', { structure: true, rerender: true }));
  if (c.chroma.on) s.append(
    color(c, 'chroma.color', 'Cor-chave', { extra: pick }),
    range(c, 'chroma.strength', 'Intensidade', { min: 0, max: 1, mul: 100, def: 0.35 }),
    range(c, 'chroma.smooth', 'Suavidade', { min: 0, max: 1, mul: 100, def: 0.1 }),
  );
  return s;
}

function filterSection(c) {
  const opts = FILTERS.map((f) => [f.id, f.name]);
  const s = sect('Filtro', select(c, 'filter.name', 'Filtro', opts, { structure: true, rerender: true }));
  if (c.filter.name !== 'none') s.append(range(c, 'filter.intensity', 'Intensidade', { min: 0, max: 1, mul: 100, def: 1 }));
  return s;
}

function adjustSection(c) {
  const s = sect('Ajustes',
    range(c, 'adjust.brightness', 'Brilho', { min: -1, max: 1, mul: 50, def: 0 }),
    range(c, 'adjust.contrast', 'Contraste', { min: -1, max: 1, mul: 50, def: 0 }),
    range(c, 'adjust.saturation', 'Saturação', { min: -1, max: 1, mul: 50, def: 0 }),
    range(c, 'adjust.temperature', 'Temperatura', { min: -1, max: 1, mul: 50, def: 0 }),
    range(c, 'adjust.tint', 'Matiz verde/rosa', { min: -1, max: 1, mul: 50, def: 0 }),
    range(c, 'adjust.hue', 'Tom (hue)', { min: -180, max: 180, step: 1, unit: '°', def: 0 }),
    range(c, 'adjust.vignette', 'Vinheta', { min: 0, max: 1, mul: 100, def: 0 }),
    range(c, 'adjust.blur', 'Desfoque', { min: 0, max: 1, mul: 100, def: 0 }),
  );
  const rs = h('button', {}, 'Redefinir ajustes');
  rs.onclick = () => { checkpoint(); c.adjust = baseVisual().adjust; changed('structure'); render(); };
  s.append(h('div', { class: 'btn-row' }, rs));
  return s;
}

function animSections(c) {
  const isText = c.type === 'text';
  const ins = ANIMS_IN.filter(([v]) => isText || v !== 'typewriter');
  return [
    sect('Entrada', select(c, 'anim.in.type', 'Animação', ins, { structure: true }),
      range(c, 'anim.in.dur', 'Duração', { min: 0.1, max: 5, step: 0.1, digits: 1, unit: 's', def: 0.5 })),
    sect('Saída', select(c, 'anim.out.type', 'Animação', ANIMS_OUT, { structure: true }),
      range(c, 'anim.out.dur', 'Duração', { min: 0.1, max: 5, step: 0.1, digits: 1, unit: 's', def: 0.5 })),
    sect('Combo (loop)', select(c, 'anim.loop.type', 'Animação', ANIMS_LOOP, { structure: true }),
      range(c, 'anim.loop.speed', 'Velocidade', { min: 0.1, max: 4, step: 0.1, digits: 1, unit: 'x', def: 1 })),
  ];
}

function speedSection(c) {
  const s = sect('Velocidade',
    range(c, 'speed', 'Velocidade', { min: 0.1, max: 10, log: true, digits: 2, unit: 'x', structure: true, def: 1,
      set: (v) => { c.speed = v; } }),
  );
  const presets = h('div', { class: 'preset-grid' });
  [0.25, 0.5, 1, 1.5, 2, 4].forEach((v) => {
    const b = h('button', { class: Math.abs(c.speed - v) < 1e-3 ? 'on' : '' }, `${v}x`);
    b.onclick = () => { checkpoint(); c.speed = v; changed('structure'); render(); };
    presets.append(b);
  });
  s.append(presets);
  s.append(h('div', { class: 'hint' }, `Duração resultante: ${clipDuration(c).toFixed(2)}s`));
  return s;
}

function audioSection(c) {
  const max = Math.min(10, clipDuration(c) / 2);
  return sect('Áudio',
    range(c, 'volume', 'Volume', { min: 0, max: 2, mul: 100, unit: '%', def: 1 }),
    range(c, 'fadeIn', 'Fade in', { min: 0, max, step: 0.1, digits: 1, unit: 's', def: 0, structure: true }),
    range(c, 'fadeOut', 'Fade out', { min: 0, max, step: 0.1, digits: 1, unit: 's', def: 0, structure: true }),
    toggle(c, 'muted', 'Silenciar', { structure: true }),
  );
}

function durationSection(c) {
  return sect('Duração', range(c, 'dur', 'Duração', { min: 0.1, max: 600, step: 0.1, digits: 1, unit: 's', structure: true, def: 3 }));
}

function effectSection(c) {
  return sect('Efeito',
    select(c, 'effect', 'Tipo', EFFECTS.map((e) => [e.id, e.name]), { structure: true }),
    range(c, 'intensity', 'Intensidade', { min: 0, max: 1, mul: 100, def: 0.7 }),
    h('div', { class: 'hint' }, 'O efeito é aplicado a todas as camadas abaixo dele durante o tempo do clipe.'),
  );
}

function textSections(c) {
  const ta = h('textarea', { spellcheck: 'false', id: 'text-input' });
  ta.value = c.text;
  ta.addEventListener('input', () => { checkpoint(`${c.id}:text`); c.text = ta.value; changed('props'); });
  ta.addEventListener('change', () => changed('structure'));
  const styles = h('div', { class: 'preset-grid' });
  TEXT_STYLES.forEach((st) => {
    const b = h('button', {}, st.name);
    b.onclick = () => {
      checkpoint();
      const s = deepClone(st.s);
      if (s.color) c.color = s.color;
      for (const k of ['stroke', 'bg', 'shadow', 'glow']) if (s[k]) Object.assign(c[k], s[k]);
      changed('props'); render();
    };
    styles.append(b);
  });
  const fmt = seg(c, null, 'Estilo', [['b', `<b>${t('§N')}</b>`], ['i', `<i>${t('§I')}</i>`], ['u', `<u>${t('§S')}</u>`]], {
    get: () => null,
    set: (v) => { if (v === 'b') c.bold = !c.bold; if (v === 'i') c.italic = !c.italic; if (v === 'u') c.underline = !c.underline; },
  });
  // reflect multi-toggle state
  updaters.push(() => { const bs = fmt.querySelectorAll('button'); bs[0].classList.toggle('on', c.bold); bs[1].classList.toggle('on', c.italic); bs[2].classList.toggle('on', c.underline); });
  updaters[updaters.length - 1]();
  const capSect = c.caption ? (() => {
    const all = h('button', {}, 'Aplicar este estilo a todas');
    all.onclick = () => applyStyleToAllCaptions(c);
    const del = h('button', { class: 'danger' }, 'Excluir todas');
    del.onclick = () => deleteAllCaptions();
    return sect('Legenda automática', h('div', { class: 'hint' }, 'Edite o texto, a fonte e o estilo desta legenda e depois aplique o estilo a todas.'), h('div', { class: 'btn-row' }, all, del));
  })() : null;
  return [
    capSect,
    sect('Conteúdo', ta),
    sect('Estilos rápidos', styles),
    sect('Fonte',
      select(c, 'font', 'Fonte', [...new Set([...FONTS, c.font])].map((f) => [f, f])),
      brandSwatches((col) => { c.color = col; }),
      range(c, 'size', 'Tamanho', { min: 0.01, max: 0.4, mul: 1000, def: 0.07 }),
      color(c, 'color', 'Cor'),
      fmt,
      seg(c, 'align', 'Alinhar', [['left', '⯇'], ['center', '≡'], ['right', '⯈']]),
      range(c, 'letterSpacing', 'Espaçamento', { min: -2, max: 10, step: 0.1, digits: 1, def: 0 }),
      range(c, 'lineHeight', 'Entrelinha', { min: 0.6, max: 3, step: 0.05, digits: 2, def: 1.2 }),
    ),
    sect('Contorno', color(c, 'stroke.color', 'Cor'), range(c, 'stroke.width', 'Espessura', { min: 0, max: 1.5, mul: 100, def: 0 })),
    sect('Fundo', color(c, 'bg.color', 'Cor'),
      range(c, 'bg.opacity', 'Opacidade', { min: 0, max: 1, mul: 100, unit: '%', def: 0 }),
      range(c, 'bg.radius', 'Arredondar', { min: 0, max: 1, mul: 100, def: 0.25 }),
      range(c, 'bg.padding', 'Margem', { min: 0, max: 1.5, mul: 100, def: 0.3 })),
    sect('Sombra', color(c, 'shadow.color', 'Cor'),
      range(c, 'shadow.opacity', 'Opacidade', { min: 0, max: 1, mul: 100, unit: '%', def: 0 }),
      range(c, 'shadow.blur', 'Desfoque', { min: 0, max: 1, mul: 100, def: 0.15 }),
      range(c, 'shadow.distance', 'Distância', { min: 0, max: 0.5, mul: 100, def: 0.06 }),
      range(c, 'shadow.angle', 'Ângulo', { min: -180, max: 180, step: 1, unit: '°', def: 45 })),
    sect('Brilho (neon)', color(c, 'glow.color', 'Cor'), range(c, 'glow.opacity', 'Intensidade', { min: 0, max: 1, mul: 100, def: 0 })),
  ];
}

function renderTransition() {
  const f = findClip(S.project, S.sel.id);
  if (!f) return renderProject();
  const c = f.clip;
  shell(['Transição'], 'Transição', () => render());
  pane.append(h('div', { class: 'insp-title' }, h('span', { class: 'chip' }, 'Transição'), 'Entre dois clipes'));
  const body = h('div', { class: 'insp-body' });
  const grid = h('div', { class: 'preset-grid' });
  TRANSITIONS.forEach((t) => {
    const b = h('button', { class: c.transition?.type === t.id ? 'on' : '' }, t.name);
    b.onclick = () => { setTransition(c.id, t.id); render(); };
    grid.append(b);
  });
  body.append(sect('Tipo', grid));
  if (c.transition && c.transition.type !== 'none') {
    body.append(sect('Configuração',
      range(c, 'transition.dur', 'Duração', { min: 0.1, max: 3, step: 0.1, digits: 1, unit: 's', structure: true, def: 0.5 })));
  }
  const all = h('button', {}, 'Aplicar a todos os cortes');
  all.onclick = () => applyTransitionToAll(c.transition?.type || 'fade', c.transition?.dur || 0.5);
  body.append(h('div', { class: 'btn-row' }, all));
  body.append(h('div', { class: 'hint' }, 'A transição sobrepõe o final de um clipe ao início do próximo.'));
  pane.append(body);
}

function renderProject() {
  const p = S.project;
  shell(['Projeto'], 'Projeto', () => render());
  pane.append(h('div', { class: 'insp-title' }, h('span', { class: 'chip' }, 'Projeto'), 'Configurações'));
  const body = h('div', { class: 'insp-body' });
  const ratioOpts = [['original', 'Original'], ...Object.keys(RATIOS).map((r) => [r, r])];
  const grid = h('div', { class: 'preset-grid' });
  ratioOpts.forEach(([v, t]) => {
    const b = h('button', { class: p.ratio === v ? 'on' : '' }, t);
    b.onclick = () => { setRatio(v); render(); };
    grid.append(b);
  });
  body.append(sect('Proporção', grid, h('div', { class: 'hint' }, `Resolução base: ${p.width}×${p.height}`)));
  const bg = sect('Fundo da tela',
    seg(p.background, 'mode', 'Modo', [['color', 'Cor'], ['blur', 'Desfoque']], { rerender: true }),
    color(p.background, 'color', 'Cor'),
  );
  if (p.background.mode === 'blur') bg.append(range(p.background, 'blur', 'Desfoque', { min: 0.05, max: 1, mul: 100, def: 0.6 }));
  body.append(bg);
  body.append(sect('Taxa de quadros', select(p, 'fps', 'FPS', [[24, '24'], [25, '25'], [30, '30'], [50, '50'], [60, '60']], { number: true })));
  const n = p.tracks.reduce((a, t) => a + t.clips.length, 0);
  body.append(h('div', { class: 'hint' }, `${n} clipe(s) · ${Object.keys(p.media).length} mídia(s) · ${p.duration.toFixed(1)}s`));
  body.append(h('div', { class: 'hint' }, 'Selecione um clipe na linha do tempo para editar suas propriedades.'));
  pane.append(body);
  if (!mainTrack().clips.length) body.append(h('div', { class: 'hint' }, 'Dica: arraste arquivos direto para a janela.'));
}
