// App shell: home screen, editor wiring, playback loop, shortcuts, autosave, export.
import {
  S, on, emit, changed, select, seek, checkpoint, undo, redo, canUndo, canRedo, resetHistory, importPaths, selClip,
  splitAtPlayhead, deleteSelected, duplicateSelected, mirrorSelected, rotateSelected, freezeFrame, reverseSelected,
  extractAudio, setRatio, toast, placeClip, mainTrack, addMedia, closeGaps, frameSelected,
} from './store.js';
import { newProject, layout, deepClone, uid, RATIOS, clipDuration, sizeForRatio } from './model.js';
import { PlaybackEngine, ensureVisuals, cache } from './media.js';
import { initTimeline, render as renderTimeline, updatePlayhead, setZoom, zoomToFit, fmtTime } from './timeline.js';
import { initInspector, render as renderInspector } from './inspector.js';
import { initPanels, render as renderPanels } from './panels.js';
import { initStage, draw, fit, markDirty, snapshotThumb, previewCanvas } from './stage.js';
import { exportProject } from './export.js';
import { icon } from './icons.js';
import { modal, confirmModal, promptModal } from './ui.js';
import * as AI from './ai.js';
import { t, lang, locale, LANGUAGES, setLang, startDomTranslation } from './i18n.js';
import { startTour, shouldAutoStart, tourActive } from './tour.js';
import { openSupport } from './support.js';
import { initQuickbar } from './quickbar.js';
import { loadBrand } from './brand.js';
import { openAutoCompose } from './autocompose.js';
import { openRecorder, isRecording, stop as stopRecording } from './record.js';
import { BUILTIN, applyBuiltin } from './templates.js';
import { templateCard } from './panels.js';
import { mixAudio } from './export.js';

const $ = (id) => document.getElementById(id);
const engine = new PlaybackEngine(() => markDirty());
let playClock = null;
let saveTimer = null;
let clipboard = null;

// ---------- toasts / modals ----------
on('toast', ({ msg, err }) => {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 2600);
});

let busyModal = null;
on('busy', (msg) => {
  if (busyModal) { busyModal.close(); busyModal = null; }
  if (msg) { busyModal = modal(`<h2>Processando</h2><div>${msg}</div><div class="progress"><div style="width:100%;animation:blink 1.2s infinite"></div></div>`); busyModal.back.dataset.locked = '1'; }
});

// ---------- home ----------
async function showHome() {
  await flushSave();
  pause();
  engine.pauseAll();
  S.project = null;
  $('editor').classList.add('hidden');
  $('home').classList.remove('hidden');
  const list = await window.native.listProjects();
  $('draft-count').textContent = list.length ? `${list.length}` : '';
  const fmtD = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  $('drafts').innerHTML = list.length ? list.map((p) => `
    <div class="draft" data-id="${p.id}">
      <div class="th" style="background-image:url('${p.thumb || ''}')"><span class="dur">${fmtD(p.duration)}</span></div>
      <div class="meta"><div class="nm" data-noi18n></div><div class="dt">${new Date(p.updatedAt).toLocaleString(locale)}</div></div>
      <div class="acts"><button data-act="rename">Renomear</button><button data-act="del">Excluir</button></div>
    </div>`).join('') : '<div class="empty-note">Nenhum projeto ainda. Clique em “Novo projeto”.</div>';
  list.forEach((p) => { $('drafts').querySelector(`[data-id="${p.id}"] .nm`).textContent = p.name; });
  $('home-tpls').innerHTML = BUILTIN.filter((x) => x.kind === 'project').map((x) => templateCard(x)).join('');
}

$('home-tpls').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-tpl]');
  if (!card) return;
  const tpl = BUILTIN.find((x) => x.id === card.dataset.tpl);
  const p = newProject(t(tpl.name), tpl.ratio || '16:9');
  await openProject(p, true);
  applyBuiltin(tpl);
  resetHistory();
});
$('btn-auto').onclick = () => openAutoCompose(openProject);
$('btn-rec-home').onclick = async () => {
  const p = newProject(t('Gravação {0}', new Date().toLocaleString(locale)));
  p.ratio = 'original';
  await openProject(p, true);
  S.libTab = 'record';
  renderPanels();
  openRecorder('screen');
};

$('drafts').addEventListener('click', async (e) => {
  const card = e.target.closest('.draft');
  if (!card) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  const id = card.dataset.id;
  if (act === 'del') {
    if (await confirmModal('Excluir projeto', 'O projeto será movido para a Lixeira. Os arquivos de mídia originais não são apagados.', 'Excluir', true)) {
      await window.native.deleteProject(id); showHome();
    }
  } else if (act === 'rename') {
    const nm = await promptModal('Renomear projeto', card.querySelector('.nm').textContent);
    if (nm) { await window.native.renameProject(id, nm); showHome(); }
  } else {
    openProject(await window.native.loadProject(id));
  }
});

$('btn-new').onclick = () => {
  const p = newProject(t('Projeto {0}', `${new Date().toLocaleDateString(locale)} ${new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`));
  p.ratio = 'original';
  openProject(p, true);
};

async function openProject(p, isNew = false) {
  S.project = p;
  S.sel = null; S.t = 0; S.playing = false;
  layout(p);
  resetHistory();
  $('home').classList.add('hidden');
  $('editor').classList.remove('hidden');
  $('proj-name').value = p.name;
  fillRatioSelect();
  fit();
  renderAll();
  zoomToFit();
  if (isNew) scheduleSave();
  if (shouldAutoStart() && !window.native.isTest) setTimeout(() => { if (!tourActive()) startTour(); }, 600);
  for (const m of Object.values(p.media)) {
    if (!(await window.native.fileExists(m.path))) { toast(`Mídia não encontrada: ${m.name}`, true); continue; }
    ensureVisuals(m, () => emit('media-visuals', m.id));
  }
}

function renderAll() { renderTimeline(); renderInspector(); renderPanels(); markDirty(); updateUndoButtons(); }

// ---------- autosave ----------
function scheduleSave() {
  $('save-state').textContent = 'Salvando…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1200);
}
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!S.project) return;
  const p = deepClone(S.project);
  await window.native.saveProject(p, snapshotThumb());
  $('save-state').textContent = 'Salvo';
}
async function flushSave() { if (saveTimer) await saveNow(); }

on('change', (kind) => {
  if (kind !== 'select') scheduleSave();
  updateUndoButtons();
  if (kind === 'structure' || kind === 'media') fillRatioSelect();
});
on('history', updateUndoButtons);
function updateUndoButtons() { $('btn-undo').disabled = !canUndo(); $('btn-redo').disabled = !canRedo(); }

// ---------- playback ----------
function play() {
  if (!S.project || S.playing) return;
  if (S.t >= S.project.duration - 0.01) S.t = 0;
  engine.audioCtx();
  S.playing = true;
  playClock = { t0: S.t, now0: performance.now() };
  $('btn-play').innerHTML = icon('pause');
}
function pause() {
  if (!S.playing) return;
  S.playing = false;
  engine.pauseAll();
  $('btn-play').innerHTML = icon('play');
  markDirty();
  emit('seek', S.t);
}
on('pause', pause);
const togglePlay = () => (S.playing ? pause() : play());

function loop() {
  if (S.project) {
    if (S.playing) {
      S.t = playClock.t0 + (performance.now() - playClock.now0) / 1000;
      if (S.t >= S.project.duration) { S.t = S.project.duration; pause(); }
      updatePlayhead(true);
    }
    engine.sync(S.project, S.t, S.playing);
    draw();
    $('tc').textContent = `${fmtTime(S.t, S.project.fps)} / ${fmtTime(S.project.duration, S.project.fps)}`;
  }
  requestAnimationFrame(loop);
}

on('seek', () => { if (S.playing) playClock = { t0: S.t, now0: performance.now() }; });
on('change', (k) => { if (k === 'structure') engine.gc(S.project); });

// ---------- editor chrome ----------
function initChrome() {
  $('btn-home').innerHTML = icon('home');
  $('btn-tour').innerHTML = '<span style="font-weight:700;font-size:15px;width:18px;display:inline-block;text-align:center">?</span>';
  $('btn-tour').onclick = () => startTour();
  $('btn-keys').innerHTML = icon('keyboard');
  $('btn-keys').onclick = openShortcuts;
  $('btn-auto').querySelector('.plus').innerHTML = icon('ai');
  $('btn-rec-home').querySelector('.plus').innerHTML = icon('record');
  $('btn-support').onclick = openSupport;
  $('btn-support-home').onclick = openSupport;
  $('btn-undo').innerHTML = icon('undo');
  $('btn-redo').innerHTML = icon('redo');
  $('btn-export').querySelector('.ico').innerHTML = icon('export');
  $('btn-play').innerHTML = icon('play');
  $('btn-prev').innerHTML = icon('prev');
  $('btn-next').innerHTML = icon('next');
  $('btn-full').innerHTML = icon('full');
  $('btn-home').onclick = showHome;
  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;
  $('btn-play').onclick = togglePlay;
  $('btn-prev').onclick = () => seek(0);
  $('btn-next').onclick = () => seek(S.project.duration);
  $('btn-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen());
  document.addEventListener('fullscreenchange', () => setTimeout(fit, 50));
  $('btn-export').onclick = openExport;
  $('proj-name').addEventListener('change', () => { S.project.name = $('proj-name').value.trim() || 'Sem título'; scheduleSave(); });
  $('ratio-select').addEventListener('change', () => setRatio($('ratio-select').value));

  const tb = $('tl-toolbar');
  const tools = [
    ['split', 'Dividir (Ctrl+B)', splitAtPlayhead], ['trash', 'Excluir (Delete)', deleteSelected], ['copy', 'Duplicar (Ctrl+D)', duplicateSelected],
    '|', ['freeze', 'Congelar quadro', freezeFrame], ['reverse', 'Inverter clipe', reverseSelected], ['mirror', 'Espelhar', mirrorSelected],
    ['rotate', 'Girar 90°', rotateSelected], ['crop', 'Recortar', () => { const f = selClip(); if (f && f.clip.crop) { S.inspTab[f.clip.type] = 'Vídeo'; renderInspector(); } }],
    ['extract', 'Extrair áudio', extractAudio], ['gap', 'Excluir lacunas', closeGaps],
  ];
  tb.innerHTML = '';
  for (const t of tools) {
    if (t === '|') { tb.append(Object.assign(document.createElement('div'), { className: 'sep' })); continue; }
    const b = document.createElement('button');
    b.className = 'icon-btn'; b.title = t[1]; b.innerHTML = icon(t[0]);
    b.onclick = t[2];
    tb.append(b);
  }
  tb.append(Object.assign(document.createElement('div'), { className: 'grow' }));
  const snapBtn = document.createElement('button');
  snapBtn.className = 'icon-btn on'; snapBtn.title = 'Ímã (encaixe automático)'; snapBtn.innerHTML = icon('snap');
  snapBtn.onclick = () => { S.snap = !S.snap; snapBtn.classList.toggle('on', S.snap); };
  const zo = document.createElement('button'); zo.className = 'icon-btn'; zo.title = 'Afastar'; zo.innerHTML = icon('zoomout');
  const zi = document.createElement('button'); zi.className = 'icon-btn'; zi.title = 'Aproximar'; zi.innerHTML = icon('zoomin');
  const zf = document.createElement('button'); zf.className = 'icon-btn'; zf.title = 'Ajustar à janela'; zf.innerHTML = icon('fit');
  const zr = document.createElement('input'); zr.type = 'range'; zr.min = Math.log(4); zr.max = Math.log(800); zr.step = 0.01;
  zo.onclick = () => setZoom(S.pps / 1.4); zi.onclick = () => setZoom(S.pps * 1.4); zf.onclick = zoomToFit;
  zr.oninput = () => setZoom(Math.exp(+zr.value));
  on('zoom', (pps) => { zr.value = Math.log(pps); });
  tb.append(snapBtn, Object.assign(document.createElement('div'), { className: 'sep' }), zo, zr, zi, zf);

  // splitter between viewer and timeline
  const tlWrap = document.querySelector('.tl-wrap');
  $('splitter').addEventListener('pointerdown', (e) => {
    const y0 = e.clientY, h0 = tlWrap.offsetHeight;
    const mv = (ev) => { tlWrap.style.height = Math.max(140, Math.min(window.innerHeight - 300, h0 - (ev.clientY - y0))) + 'px'; };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
}

function fillRatioSelect() {
  const sel = $('ratio-select');
  const opts = [['original', 'Original'], ...Object.keys(RATIOS).map((r) => [r, r])];
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  sel.value = S.project.ratio;
}

// ---------- context menu ----------
on('context-menu', ({ x, y }) => {
  document.querySelector('.ctx-menu')?.remove();
  const f = selClip();
  if (!f) return;
  const c = f.clip;
  const items = [
    ['Dividir', 'Ctrl+B', splitAtPlayhead], ['Duplicar', 'Ctrl+D', duplicateSelected], ['Copiar', 'Ctrl+C', copyClip], ['Colar', 'Ctrl+V', pasteClip],
    '-',
  ];
  if (c.type === 'video') items.push(['Congelar quadro', '', freezeFrame], [c.reverseOf ? 'Desfazer inversão' : 'Inverter clipe', '', reverseSelected], ['Extrair áudio', '', extractAudio], ['Dividir por cenas', '', () => AI.splitScenes()]);
  if (c.type === 'video' || c.type === 'audio') items.push(['Remover silêncios', '', () => AI.removeSilences()], [c.enhanceOf ? 'Restaurar áudio original' : 'Melhorar voz', '', () => AI.enhanceVoice()]);
  if (c.type === 'video' || c.type === 'image') {
    items.push(['Ajustar ao quadro', '', () => frameSelected('fit')], ['Preencher o quadro', '', () => frameSelected('fill')], ['Imagem em imagem', '', () => frameSelected('pip')]);
    if (f.track.kind === 'main') items.push(['Mover para sobreposição', '', () => moveToOverlay(f)]);
    else items.push(['Mover para faixa principal', '', () => moveToMain(f)]);
  }
  if (c.type === 'video' || c.type === 'audio') items.push([c.muted ? 'Ativar som' : 'Silenciar', '', () => { checkpoint(); c.muted = !c.muted; changed('structure'); }]);
  if (f.track.kind !== 'main') items.push(['Excluir lacunas', '', closeGaps]);
  items.push('-', ['Excluir', 'Delete', deleteSelected]);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it === '-') { menu.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.innerHTML = `<span>${it[0]}</span><span class="k">${it[1]}</span>`;
    b.onclick = () => { menu.remove(); it[2](); };
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); window.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => window.addEventListener('pointerdown', close, true), 0);
});

function moveToOverlay(f) {
  checkpoint();
  const c = f.clip;
  const start = c.start;
  f.track.clips.splice(f.index, 1);
  if (c.transition) c.transition = { type: 'none', dur: 0.5 };
  placeClip(c, start);
  changed('structure');
}
function moveToMain(f) {
  checkpoint();
  const c = f.clip;
  f.track.clips.splice(f.index, 1);
  c.transition ||= { type: 'none', dur: 0.5 };
  const main = mainTrack();
  let idx = main.clips.findIndex((x) => x.start + clipDuration(x) / 2 > c.start);
  if (idx < 0) idx = main.clips.length;
  main.clips.splice(idx, 0, c);
  S.project.tracks = S.project.tracks.filter((t, i) => i === 0 || t.clips.length);
  changed('structure');
}

function copyClip() { const f = selClip(); if (f) { clipboard = { clip: deepClone(f.clip), main: f.track.kind === 'main' }; toast('Clipe copiado'); } }
function pasteClip() {
  if (!clipboard) return;
  checkpoint();
  const c = deepClone(clipboard.clip);
  c.id = uid();
  if (clipboard.main && c.type !== 'audio' && c.transition) {
    const main = mainTrack();
    const idx = main.clips.findIndex((x) => S.t < x.start + clipDuration(x) / 2);
    main.clips.splice(idx < 0 ? main.clips.length : idx, 0, c);
  } else placeClip(c, S.t);
  S.sel = { kind: 'clip', id: c.id };
  changed('structure');
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (!S.project || $('editor').classList.contains('hidden')) return;
  if ($('modal-root').children.length || tourActive()) return;
  if (isRecording() && e.key === 'Escape') { stopRecording(); return; }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  const k = e.key.toLowerCase();
  const fps = S.project.fps;
  if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (e.ctrlKey && k === 'b') { e.preventDefault(); splitAtPlayhead(); }
  else if (e.ctrlKey && k === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (e.ctrlKey && k === 'c') { copyClip(); }
  else if (e.ctrlKey && k === 'v') { pasteClip(); }
  else if (e.ctrlKey && k === 's') { e.preventDefault(); saveNow(); }
  else if (e.ctrlKey && k === 'e') { e.preventDefault(); openExport(); }
  else if (e.ctrlKey && k === 'i') { e.preventDefault(); window.native.pickMedia('media').then(importPaths); }
  else if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); }
  else if (k === 'arrowleft') { e.preventDefault(); pause(); seek(S.t - (e.shiftKey ? 1 : 1 / fps)); }
  else if (k === 'arrowright') { e.preventDefault(); pause(); seek(S.t + (e.shiftKey ? 1 : 1 / fps)); }
  else if (k === 'home') seek(0);
  else if (k === 'end') seek(S.project.duration);
  else if (k === '+' || k === '=') setZoom(S.pps * 1.3);
  else if (k === '-') setZoom(S.pps / 1.3);
  else if (k === 'escape') select(null);
  else if (e.key === '?') openShortcuts();
});

const SHORTCUTS = [
  ['Espaço', 'Reproduzir / pausar'], ['← / →', 'Quadro anterior / próximo'], ['Shift + ← / →', 'Voltar / avançar 1 segundo'],
  ['Home / End', 'Início / fim do projeto'], ['Ctrl + B', 'Dividir no cursor'], ['Delete', 'Excluir seleção'], ['Ctrl + D', 'Duplicar'],
  ['Ctrl + C / Ctrl + V', 'Copiar / colar clipe'], ['Ctrl + Z / Ctrl + Y', 'Desfazer / refazer'], ['Ctrl + I', 'Importar mídia'],
  ['Ctrl + S', 'Salvar agora'], ['Ctrl + E', 'Exportar'], ['+ / −', 'Aproximar / afastar a linha do tempo'], ['Ctrl + roda do mouse', 'Zoom na linha do tempo'],
  ['Esc', 'Limpar seleção / parar gravação'], ['?', 'Mostrar atalhos'],
];
function openShortcuts() {
  const m = modal(`<h2>Atalhos de teclado</h2><div class="keys">${SHORTCUTS.map(([k, d]) => `<kbd data-noi18n>${k.replace('Espaço', t('Espaço'))}</kbd><span>${d}</span>`).join('')}</div>
    <div class="foot"><button class="primary" data-x>Fechar</button></div>`, { width: 520 });
  m.el.querySelector('[data-x]').onclick = () => m.close();
}

// ---------- file drop from Explorer ----------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!S.project || !e.dataTransfer.types.includes('Files')) return;
  dragDepth++; $('drop-hint').classList.remove('hidden');
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-hint').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dragDepth = 0; $('drop-hint').classList.add('hidden');
  if (!S.project) return;
  const paths = [...e.dataTransfer.files].map((f) => window.native.pathForFile(f)).filter(Boolean);
  const added = await importPaths(paths);
  // dropping onto the empty project drops straight into the timeline, like a fresh start
  if (added.length && !mainTrack().clips.length) for (const m of added) if (m.type !== 'audio') addMedia(m, { index: mainTrack().clips.length });
});

// ---------- export ----------
function openExport() {
  if (!S.project) return;
  pause();
  if (S.project.duration <= 0) { toast('Adicione mídia à linha do tempo antes de exportar'); return; }
  const p = S.project;
  const short = Math.min(p.width, p.height);
  const resOpts = [[480, '480p'], [720, '720p'], [1080, '1080p'], [1440, '2K'], [2160, '4K']];
  const m = modal(`
    <h2>Exportar vídeo</h2>
    <div class="export-prev" style="background-image:url('${snapshotThumb() || ''}')"></div>
    <div class="row"><label>Nome</label><input type="text" data-name></div>
    <div class="row"><label>Resolução</label><select data-res>${resOpts.map(([v, t]) => `<option value="${v}" ${v === Math.min(1080, short) || (short < 1080 && v === 720 && short >= 720) ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="row"><label>Taxa de quadros</label><select data-fps>${[24, 25, 30, 50, 60].map((v) => `<option ${v === p.fps ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="row"><label>Qualidade</label><select data-crf><option value="26">Menor arquivo</option><option value="20" selected>Recomendada</option><option value="16">Alta</option></select></div>
    <div class="row"><label>Formato</label><div class="seg" data-fmt><button data-v="mp4" class="on">MP4</button><button data-v="gif">GIF</button><button data-v="mp3">Só áudio (MP3)</button></div></div>
    <div class="hint" data-info></div>
    <div class="foot"><button data-x>Cancelar</button><button class="primary" data-go>${icon('export')} Exportar</button></div>`);
  m.el.querySelector('[data-name]').value = p.name;
  let fmt = 'mp4';
  const rows = ['[data-res]', '[data-fps]', '[data-crf]'].map((s) => m.el.querySelector(s).closest('.row'));
  m.el.querySelectorAll('[data-fmt] button').forEach((b) => {
    b.onclick = () => {
      fmt = b.dataset.v;
      m.el.querySelectorAll('[data-fmt] button').forEach((x) => x.classList.toggle('on', x === b));
      rows.forEach((r, i) => r.classList.toggle('hidden', fmt === 'mp3' || (fmt === 'gif' && i > 0)));
      if (fmt === 'gif' && +m.el.querySelector('[data-res]').value > 720) m.el.querySelector('[data-res]').value = '480';
      info();
    };
  });
  const info = () => {
    const s = +m.el.querySelector('[data-res]').value;
    const k = s / short;
    const even = (x) => Math.round(x / 2) * 2;
    const el = m.el.querySelector('[data-info]');
    if (fmt === 'mp3') el.textContent = t('Somente o som do projeto · duração {0}', fmtTime(p.duration, p.fps));
    else if (fmt === 'gif') el.textContent = t('{0} · 15 fps, sem som · ideal para até 15 s', `${even(p.width * k)}×${even(p.height * k)}`) + (p.duration > 30 ? ' — ' + t('vídeo longo: o GIF ficará pesado') : '');
    else el.textContent = `${even(p.width * k)}×${even(p.height * k)} · ${t('duração')} ${fmtTime(p.duration, p.fps)}`;
  };
  m.el.querySelector('[data-res]').onchange = info; info();
  m.el.querySelector('[data-x]').onclick = () => m.close();
  m.el.querySelector('[data-go]').onclick = async () => {
    const name = m.el.querySelector('[data-name]').value.trim() || p.name;
    const s = +m.el.querySelector('[data-res]').value;
    const fps = +m.el.querySelector('[data-fps]').value;
    const crf = +m.el.querySelector('[data-crf]').value;
    const outPath = await window.native.pickExportPath(name.replace(/[\\/:*?"<>|]/g, '_'), fmt);
    if (!outPath) return;
    m.close();
    if (fmt === 'mp3') { exportAudioOnly(outPath); return; }
    const k = Math.min(s, fmt === 'gif' ? 720 : s) / short;
    const even = (x) => Math.round(x / 2) * 2;
    runExport({ outPath, width: even(p.width * k), height: even(p.height * k), fps: fmt === 'gif' ? 15 : fps, crf, format: fmt });
  };
}

async function exportAudioOnly(outPath) {
  emit('busy', 'Mixando áudio…');
  try {
    const wav = await mixAudio(S.project);
    if (!wav) { toast('O projeto não tem som para exportar', true); return; }
    const res = await window.native.exportAudio(wav, outPath);
    if (!res.ok) { toast('Falha na exportação: ' + (res.error || '').slice(-300), true); return; }
    exportDone(res.path, null);
  } finally { emit('busy', null); }
}

function exportDone(path, secs) {
  const done = modal(`<h2>Exportação concluída ✓</h2><div class="muted" style="word-break:break-all" data-noi18n>${path}</div>${secs != null ? `<div class="hint">${t('Tempo: {0}s', secs)}</div>` : ''}
    <div class="foot"><button data-x>Fechar</button><button class="primary" data-open>Abrir pasta</button></div>`);
  done.el.querySelector('[data-x]').onclick = () => done.close();
  done.el.querySelector('[data-open]').onclick = () => { window.native.showInFolder(path); done.close(); };
}

async function runExport(opts) {
  let cancel = false;
  const m = modal(`<h2>Exportando…</h2><div data-phase class="muted">Preparando áudio…</div>
    <div class="progress"><div data-bar></div></div><div class="row"><span data-pct>0%</span><div class="grow"></div><span data-eta class="muted"></span></div>
    <div class="foot"><button data-x>Cancelar</button></div>`);
  m.back.dataset.locked = '1';
  m.el.querySelector('[data-x]').onclick = () => { cancel = true; m.el.querySelector('[data-x]').disabled = true; };
  const t0 = performance.now();
  try {
    const res = await exportProject(S.project, opts, ({ phase, frac, eta }) => {
      m.el.querySelector('[data-phase]').textContent = phase === 'audio' ? 'Mixando áudio…' : `Renderizando ${opts.width}×${opts.height} @ ${opts.fps} fps`;
      if (frac != null) {
        m.el.querySelector('[data-bar]').style.width = (frac * 100).toFixed(1) + '%';
        m.el.querySelector('[data-pct]').textContent = (frac * 100).toFixed(0) + '%';
      }
      if (eta != null) m.el.querySelector('[data-eta]').textContent = `restam ~${Math.ceil(eta)}s`;
    }, () => cancel);
    m.close();
    if (res.canceled) { toast('Exportação cancelada'); return; }
    if (!res.ok) { toast('Falha na exportação: ' + (res.error || '').slice(-300), true); return; }
    exportDone(res.path, ((performance.now() - t0) / 1000).toFixed(0));
  } catch (e) {
    m.close();
    await window.native.exportFinish(true).catch(() => {});
    toast('Falha na exportação: ' + e.message, true);
  }
}

// ---------- test hook (only when launched with CLIPNOVA_TEST_SCRIPT) ----------
if (window.native.isTest) {
  const store = await import('./store.js');
  window.__cn = { S, store, AI, openProject, newProject, runExport, exportProject, saveNow, showHome, play, pause, fit };
}

// ---------- boot ----------
startDomTranslation();
window.native.setLang?.(lang);
const langSel = $('lang-select');
langSel.innerHTML = LANGUAGES.map(([c, n]) => `<option value="${c}" ${c === lang ? 'selected' : ''}>${n}</option>`).join('');
langSel.onchange = () => setLang(langSel.value);
initChrome();
initTimeline();
initInspector();
initPanels();
initStage(engine);
initQuickbar();
loadBrand();
showHome();
requestAnimationFrame(loop);
window.addEventListener('beforeunload', () => { if (saveTimer) saveNow(); });
