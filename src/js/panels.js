// Left library: media, audio, text, stickers, effects, transitions, filters.
import { S, on, emit, importPaths, addMedia, addClip, addToMain, toast, selClip, checkpoint, changed, setTransition, mainTrack } from './store.js';
import {
  makeTextClip, makeStickerClip, makeEffectClip, makeShapeClip, makeColorClip, makeMediaClip, FILTERS, TRANSITIONS, EFFECTS, TEXT_STYLES, STICKERS,
  SHAPES, BACKGROUNDS, FONTS, deepClone, clipDuration,
} from './model.js';
import { cache, mediaUrl } from './media.js';
import { icon } from './icons.js';
import { modal, promptModal, confirmModal } from './ui.js';
import { shapePath } from './render.js';
import { encodeWav } from './export.js';
import { MUSIC, SFX, soundFile, previewSound, stopPreview } from './sfx.js';
import { BUILTIN, applyBuiltin, applyUserTemplate, saveAsTemplate, templateDuration } from './templates.js';
import { brand, saveBrand } from './brand.js';
import { openRecorder } from './record.js';
import { t } from './i18n.js';
import * as AI from './ai.js';

// remembered form choices for the AI tab (per session)
const aiForm = { language: 'auto', maxWords: 7, style: 'Legenda', position: 'bottom', replace: true, target: 'inglês', voice: 'Kore', tone: '', text: '', db: -35, minDur: 0.6, scene: 0.35 };
let aiStatus = null;

const TABS = [
  ['media', 'Sua mídia', 'media'], ['record', 'Gravar e criar', 'record'], ['templates', 'Modelos', 'template'], ['music', 'Música e SFX', 'music'],
  ['text', 'Texto', 'text'], ['graphics', 'Gráficos', 'shape'], ['transitions', 'Transições', 'transitions'], ['effects', 'Efeitos', 'effects'],
  ['filters', 'Filtros', 'filters'], ['brand', 'Kit da marca', 'brand'], ['ai', 'IA', 'ai'],
];

let tabsEl, panel;
let recorder = null;

export function initPanels() {
  tabsEl = document.getElementById('lib-tabs');
  panel = document.getElementById('lib-panel');
  tabsEl.innerHTML = TABS.map(([id, name, ic]) => `<button class="lib-tab" data-tab="${id}">${icon(ic)}${name}</button>`).join('');
  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    const ws = document.getElementById('workspace');
    if (S.libTab === b.dataset.tab) ws.classList.toggle('lib-collapsed');
    else ws.classList.remove('lib-collapsed');
    S.libTab = b.dataset.tab;
    render();
    emit('resize');
  });
  on('lib-tab', (tab) => { S.libTab = tab; document.getElementById('workspace').classList.remove('lib-collapsed'); render(); emit('resize'); });
  on('brand', () => { if (S.libTab === 'brand') render(); });
  on('change', (k) => { if (k === 'media' || k === 'structure' || k === 'select') render(); });
  on('media-visuals', () => { if (S.libTab === 'media' || S.libTab === 'music') render(); });
  panel.addEventListener('dragstart', (e) => {
    const it = e.target.closest('[data-drag]');
    if (!it) return;
    e.dataTransfer.setData('application/x-clipnova', it.dataset.drag);
    e.dataTransfer.effectAllowed = 'copy';
  });
  render();
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dragData = (o) => esc(JSON.stringify(o));

export function render() {
  if (!S.project) return;
  const collapsed = document.getElementById('workspace').classList.contains('lib-collapsed');
  tabsEl.querySelectorAll('.lib-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.libTab && !collapsed));
  const fn = {
    media: mediaTab, record: recordTab, templates: templatesTab, music: musicTab, ai: aiTab, text: textTab, graphics: graphicsTab,
    effects: effectsTab, transitions: transitionsTab, filters: filtersTab, brand: brandTab,
  }[S.libTab] || mediaTab;
  fn();
}

function usedIds() {
  const s = new Set();
  for (const t of S.project.tracks) for (const c of t.clips) if (c.mediaId) s.add(c.mediaId);
  return s;
}

function mediaTab() {
  const all = Object.values(S.project.media).filter((m) => !/[\\/](generated|library)[\\/]/.test(m.path));
  const items = all.filter((m) => m.type !== 'audio');
  const sounds = all.filter((m) => m.type === 'audio');
  const used = usedIds();
  panel.innerHTML = `
    <div class="lib-actions"><button id="imp" class="primary">${icon('import')} Importar</button></div>
    <div class="media-grid">${items.map((m) => `
      <div class="media-item" draggable="true" data-drag="${dragData({ kind: 'media', mediaId: m.id })}" data-id="${m.id}"
        style="background-image:url('${cache.thumbs[m.id] || ''}')" title="${esc(m.name)}">
        <div class="nm">${esc(m.name)}</div>
        ${m.type === 'video' ? `<span class="badge">${fmt(m.duration)}</span>` : `<span class="badge">Foto</span>`}
        ${used.has(m.id) ? '<span class="used">Em uso</span>' : ''}
        <button class="add" title="Adicionar à linha do tempo">+</button>
      </div>`).join('')}</div>
    ${sounds.length ? `<h3 style="margin-top:14px">Áudio</h3><div class="media-grid">${sounds.map((m) => audioItem(m, used)).join('')}</div>` : ''}
    ${items.length || sounds.length ? '<div class="hint" style="margin-top:10px">Arraste para a linha do tempo, ou clique em + para adicionar no cursor. Arraste sobre a faixa de cima para criar uma sobreposição.</div>' : '<div class="dropzone">Arraste vídeos, fotos e áudios aqui<br>ou clique em Importar</div>'}`;
  panel.querySelector('#imp').onclick = async () => importPaths(await window.native.pickMedia('media'));
  panel.querySelectorAll('.media-item .add').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); addMedia(S.project.media[b.parentElement.dataset.id]); };
  });
  panel.querySelectorAll('.media-item').forEach((it) => {
    it.ondblclick = () => addMedia(S.project.media[it.dataset.id]);
  });
}

const opt = (list, cur) => list.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(t)}</option>`).join('');

function aiTab() {
  if (aiStatus === null) {
    aiStatus = 'loading';
    window.native.aiSettingsGet().then((s) => { aiStatus = s; if (S.libTab === 'ai') render(); });
  }
  const st = aiStatus && aiStatus !== 'loading' ? aiStatus : null;
  const f = aiForm;
  const hasCaps = S.project.tracks.some((t) => t.caption && t.clips.length);
  panel.innerHTML = `
    <div class="ai-key ${st?.hasKey ? 'ok' : ''}">
      ${icon('ai')}<div class="grow"><b>Gemini</b><div class="muted">${st ? (st.hasKey ? `Chave conectada ${st.keyHint}` : 'Nenhuma chave configurada') : 'Carregando…'}</div></div>
      <button id="ai-cfg">${icon('gear')}</button>
    </div>

    <div class="ai-card">
      <div class="ai-h">${icon('cc')} Legendas automáticas <span class="pro">IA</span></div>
      <div class="hint">Transcreve a fala do vídeo e cria legendas sincronizadas na linha do tempo.</div>
      <div class="row"><label>Idioma</label><select data-f="language">${opt(AI.LANGS, f.language)}</select></div>
      <div class="row"><label>Palavras/legenda</label><select data-f="maxWords">${opt([[3, '3 (dinâmico)'], [5, '5'], [7, '7'], [10, '10'], [14, '14 (longo)']], f.maxWords)}</select></div>
      <div class="row"><label>Estilo</label><select data-f="style">${opt(TEXT_STYLES.map((s) => [s.name, s.name]), f.style)}</select></div>
      <div class="row"><label>Posição</label><select data-f="position">${opt(AI.POSITIONS, f.position)}</select></div>
      <label class="check"><input type="checkbox" data-f="replace" ${f.replace ? 'checked' : ''}> Substituir legendas existentes</label>
      <button class="primary wide" id="ai-cap">${icon('ai')} Gerar legendas</button>
    </div>

    <div class="ai-card">
      <div class="ai-h">${icon('cc')} Traduzir legendas <span class="pro">IA</span></div>
      <div class="row"><label>Para</label><select data-f="target">${opt(AI.LANGS.slice(1), f.target)}</select></div>
      <button class="wide" id="ai-tr" ${hasCaps ? '' : 'disabled'}>Traduzir</button>
      <div class="btn-row"><button id="srt-in">Importar .srt</button><button id="srt-out">Exportar .srt</button></div>
    </div>

    <div class="ai-card">
      <div class="ai-h">${icon('mic')} Narração por IA <span class="pro">IA</span></div>
      <textarea data-f="text" placeholder="Digite o texto que a voz vai falar…">${esc(f.text)}</textarea>
      <div class="row"><label>Voz</label><select data-f="voice">${opt(AI.VOICES, f.voice)}</select></div>
      <div class="row"><label>Tom</label><select data-f="tone">${opt(AI.TONES, f.tone)}</select></div>
      <button class="primary wide" id="ai-tts">${icon('ai')} Gerar narração</button>
    </div>

    <div class="ai-card">
      <div class="ai-h">${icon('wand')} Ferramentas inteligentes</div>
      <div class="hint">Funcionam no clipe selecionado, direto no computador, sem internet.</div>
      <div class="row"><label>Limiar</label><select data-f="db">${opt([[-45, 'Sensível (-45 dB)'], [-35, 'Normal (-35 dB)'], [-28, 'Agressivo (-28 dB)']], f.db)}</select></div>
      <div class="row"><label>Pausa mínima</label><select data-f="minDur">${opt([[0.3, '0,3 s'], [0.6, '0,6 s'], [1, '1 s'], [2, '2 s']], f.minDur)}</select></div>
      <button class="wide" id="ai-sil">${icon('scissors')} Remover silêncios</button>
      <div class="row"><label>Sensibilidade</label><select data-f="scene">${opt([[0.25, 'Alta'], [0.35, 'Normal'], [0.5, 'Baixa']], f.scene)}</select></div>
      <button class="wide" id="ai-scene">${icon('split')} Dividir por cenas</button>
      <button class="wide" id="ai-voice">${icon('vol')} Melhorar voz (reduzir ruído)</button>
    </div>`;
  panel.querySelectorAll('[data-f]').forEach((el) => {
    const k = el.dataset.f;
    el.addEventListener(el.tagName === 'TEXTAREA' ? 'input' : 'change', () => {
      const v = el.type === 'checkbox' ? el.checked : el.value;
      aiForm[k] = typeof aiForm[k] === 'number' ? +v : v;
    });
  });
  panel.querySelector('#ai-cfg').onclick = openAiSettings;
  panel.querySelector('#ai-cap').onclick = () => AI.generateCaptions(aiForm);
  panel.querySelector('#ai-tr').onclick = () => AI.translateCaptions(aiForm.target);
  panel.querySelector('#srt-in').onclick = () => AI.importSrt(aiForm);
  panel.querySelector('#srt-out').onclick = () => AI.exportSrt();
  panel.querySelector('#ai-tts').onclick = () => AI.aiNarration(aiForm.text, aiForm.voice, aiForm.tone);
  panel.querySelector('#ai-sil').onclick = () => AI.removeSilences({ db: aiForm.db, minDur: aiForm.minDur });
  panel.querySelector('#ai-scene').onclick = () => AI.splitScenes(aiForm.scene);
  panel.querySelector('#ai-voice').onclick = () => AI.enhanceVoice();
}

export async function openAiSettings() {
  const st = await window.native.aiSettingsGet();
  const m = modal(`
    <h2>Inteligência artificial — Google Gemini</h2>
    <div class="hint">Use sua própria chave da API do Gemini (o Google AI Studio oferece uma gratuita). A chave fica criptografada neste computador e só é enviada para o Google.</div>
    <div class="row"><label>Chave da API</label><input type="password" data-key placeholder="${st.hasKey ? esc(st.keyHint) + ' (salva) — cole para trocar' : 'Cole sua chave aqui'}"></div>
    <div class="btn-row"><button data-get>Obter chave grátis ↗</button><button data-test>Testar e carregar modelos</button></div>
    <div class="row"><label>Legendas</label><select data-cap></select></div>
    <div class="row"><label>Tradução</label><select data-txt></select></div>
    <div class="row"><label>Voz (TTS)</label><select data-tts></select></div>
    <div class="hint" data-status></div>
    <div class="foot">${st.hasKey ? '<button data-del class="danger" style="margin-right:auto">Remover chave</button>' : ''}<button data-x>Cancelar</button><button class="primary" data-save>Salvar</button></div>`, { width: 540 });
  const q = (s) => m.el.querySelector(s);
  const fill = (sel, list, cur) => {
    const ids = list.map((x) => x.id);
    if (cur && !ids.includes(cur)) list = [{ id: cur, name: cur }, ...list];
    sel.innerHTML = list.map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)}${x.name !== x.id ? ` (${esc(x.id)})` : ''}</option>`).join('');
  };
  fill(q('[data-cap]'), [], st.captionModel);
  fill(q('[data-txt]'), [], st.textModel);
  fill(q('[data-tts]'), [], st.ttsModel);
  const load = async () => {
    const key = q('[data-key]').value.trim() || undefined;
    if (!key && !st.hasKey) { q('[data-status]').textContent = 'Cole a chave primeiro.'; return; }
    q('[data-status]').textContent = 'Conectando ao Gemini…';
    try {
      const models = await window.native.aiListModels(key);
      const tts = models.filter((x) => /tts/i.test(x.id));
      const gen = models.filter((x) => /gemini/i.test(x.id) && !/tts|embed|image|imagen|veo|live|native-audio|robotics|computer-use/i.test(x.id));
      fill(q('[data-cap]'), gen, q('[data-cap]').value);
      fill(q('[data-txt]'), gen, q('[data-txt]').value);
      fill(q('[data-tts]'), tts.length ? tts : models, q('[data-tts]').value);
      q('[data-status]').innerHTML = `<span style="color:var(--accent)">✓ Chave válida — ${models.length} modelos disponíveis.</span>`;
    } catch (e) {
      q('[data-status]').innerHTML = `<span style="color:var(--danger)">✗ ${esc(AI.errMsg(e))}</span>`;
    }
  };
  q('[data-get]').onclick = () => window.open('https://aistudio.google.com/apikey');
  q('[data-test]').onclick = load;
  q('[data-x]').onclick = () => m.close();
  if (q('[data-del]')) q('[data-del]').onclick = async () => { await window.native.aiSettingsSet({ apiKey: '' }); aiStatus = null; m.close(); render(); toast('Chave removida'); };
  q('[data-save]').onclick = async () => {
    const key = q('[data-key]').value.trim();
    await window.native.aiSettingsSet({ ...(key ? { apiKey: key } : {}), captionModel: q('[data-cap]').value, textModel: q('[data-txt]').value, ttsModel: q('[data-tts]').value });
    aiStatus = null;
    m.close();
    render();
    toast('Configurações de IA salvas');
  };
  if (st.hasKey) load();
}

on('ai-settings', () => { S.libTab = 'ai'; render(); openAiSettings(); });

function audioItem(m, used) {
  return `<div class="media-item audio" draggable="true" data-drag="${dragData({ kind: 'media', mediaId: m.id })}" data-id="${m.id}" title="${esc(m.name)}">
    ${icon('audio')}<div class="nm" data-noi18n>${esc(m.name)}</div><span class="badge">${fmt(m.duration)}</span>${used?.has(m.id) ? '<span class="used" style="position:static">Em uso</span>' : ''}
    <button class="add" title="Adicionar no cursor">+</button>
  </div>`;
}

let playing = null; // "kind:id" of the sound being previewed
async function addSound(kind, id, name) {
  emit('busy', 'Preparando o som…');
  try {
    const file = await soundFile(kind, id, encodeWav);
    const [m] = await importPaths([file]);
    if (!m) return;
    m.name = t(name);
    addMedia(m, { time: S.t });
    toast('Som adicionado no cursor');
  } catch (e) { toast('Falha ao gerar o som: ' + e.message, true); } finally { emit('busy', null); }
}

function musicTab() {
  const items = Object.values(S.project.media).filter((m) => m.type === 'audio');
  const row = (kind, x) => `<div class="snd" data-kind="${kind}" data-id="${x.id}" data-name="${esc(x.name)}">
      <button class="icon-btn snd-play" title="Ouvir">${icon(playing === `${kind}:${x.id}` ? 'pause' : 'play')}</button>
      <div class="grow"><div>${x.name}</div><div class="muted" style="font-size:11px">${kind === 'music' ? x.mood : `${x.dur.toFixed(1)}s`}</div></div>
      <button class="snd-add" title="Adicionar no cursor">+</button></div>`;
  panel.innerHTML = `
    <div class="lib-actions"><button id="imp-a" class="primary">${icon('import')} Importar áudio</button></div>
    <h3>Músicas</h3>
    <div class="snd-list">${MUSIC.map((x) => row('music', x)).join('')}</div>
    <h3 style="margin-top:14px">Efeitos sonoros</h3>
    <div class="snd-list">${SFX.map((x) => row('sfx', x)).join('')}</div>
    <div class="hint">Músicas e efeitos originais gerados pelo ClipNova — livres para usar nos seus vídeos.</div>
    <h3 style="margin-top:14px">Seus áudios</h3>
    <div class="media-grid">${items.map((m) => audioItem(m)).join('') || '<div class="muted">Nenhum áudio importado.</div>'}</div>
    <div class="hint" style="margin-top:12px">Para usar o som de um vídeo separadamente, selecione o clipe e use “Extrair áudio” na barra da linha do tempo.</div>`;
  panel.querySelector('#imp-a').onclick = async () => importPaths(await window.native.pickMedia('audio'));
  panel.querySelectorAll('.snd').forEach((el) => {
    const { kind, id, name } = el.dataset;
    el.querySelector('.snd-play').onclick = async () => {
      const key = `${kind}:${id}`;
      if (playing === key) { stopPreview(); playing = null; render(); return; }
      playing = key; render();
      try { await previewSound(kind, id, () => { if (playing === key) { playing = null; if (S.libTab === 'music') render(); } }); } catch (e) { playing = null; render(); toast(e.message, true); }
    };
    el.querySelector('.snd-add').onclick = () => addSound(kind, id, name);
  });
  panel.querySelectorAll('.media-item .add').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); addMedia(S.project.media[b.parentElement.dataset.id]); };
  });
}

// ---------- Gravar e criar ----------
function recordTab() {
  panel.innerHTML = `
    <h3>Gravar</h3>
    <div class="create-grid">
      <button class="create-card" data-rec="screen">${icon('screen')}<b>Tela</b><span>Grave a tela inteira ou uma janela</span></button>
      <button class="create-card" data-rec="camera">${icon('camera')}<b>Câmera</b><span>Grave com a webcam</span></button>
      <button class="create-card" data-rec="both">${icon('pip')}<b>Tela e câmera</b><span>Tela com você num círculo no canto</span></button>
      <button class="create-card" data-rec="voice">${icon('mic')}<b>Narração</b><span>${recorder ? 'Gravando… clique para parar' : 'Grave sua voz pelo microfone'}</span></button>
    </div>
    <div class="rec-box ${recorder ? '' : 'hidden'}"><span class="rec-dot live"></span><div class="grow"><b>Narração</b><div class="muted" id="rec-time">Gravando…</div></div><button id="rec">■ Parar</button></div>
    <h3 style="margin-top:14px">Criar</h3>
    <div class="create-grid">
      <button class="create-card" data-create="tts">${icon('ai')}<b>Texto para fala</b><span>Narração com voz de IA</span></button>
      <button class="create-card" data-create="captions">${icon('cc')}<b>Legendas automáticas</b><span>Transcreve a fala do vídeo</span></button>
    </div>`;
  panel.querySelectorAll('[data-rec]').forEach((b) => {
    b.onclick = () => (b.dataset.rec === 'voice' ? toggleRecording() : openRecorder(b.dataset.rec));
  });
  if (panel.querySelector('#rec')) panel.querySelector('#rec').onclick = toggleRecording;
  panel.querySelectorAll('[data-create]').forEach((b) => { b.onclick = () => { S.libTab = 'ai'; render(); }; });
}

async function toggleRecording() {
  if (recorder) { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const chunks = [];
    const startT = S.t;
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(rec._timer);
      recorder = null;
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const file = await window.native.saveRecording(S.project.id, new Uint8Array(await blob.arrayBuffer()), 'webm');
      const [m] = await importPaths([file]);
      if (m) { m.name = `${t('Narração')} ${new Date().toLocaleTimeString()}`; addMedia(m, { time: startT }); toast('Narração adicionada'); }
      render();
    };
    rec.start();
    recorder = rec;
    const t0 = Date.now();
    render();
    rec._timer = setInterval(() => { const el = document.getElementById('rec-time'); if (el) el.textContent = `Gravando… ${fmt((Date.now() - t0) / 1000)}`; }, 250);
  } catch (e) {
    toast('Não foi possível acessar o microfone: ' + e.message, true);
  }
}

function textTab() {
  const def = makeTextClip();
  panel.innerHTML = `
    <div class="lib-actions"><button id="add-text" class="primary">${icon('plus')} Adicionar texto</button></div>
    <h3>Estilos</h3>
    <div class="tile-grid">${TEXT_STYLES.map((st, i) => {
      const s = st.s;
      const css = [`color:${s.color}`];
      if (s.stroke?.width) css.push(`-webkit-text-stroke:${Math.max(1, s.stroke.width * 3)}px ${s.stroke.color}`, 'paint-order:stroke fill');
      if (s.bg?.opacity) css.push(`background:${s.bg.color}`, 'padding:2px 6px', 'border-radius:4px');
      if (s.glow?.opacity) css.push(`text-shadow:0 0 8px ${s.glow.color}`);
      else if (s.shadow?.opacity) css.push('text-shadow:2px 2px 3px rgba(0,0,0,.9)');
      return `<div class="tile text-style" draggable="true" data-style="${i}" data-drag="${dragData({ kind: 'clip', clip: styled(def, st) })}"><span style="${css.join(';')}">Aa</span><span class="muted" style="font-size:10px;font-weight:400">${st.name}</span></div>`;
    }).join('')}</div>
    <div class="hint" style="margin-top:12px">Clique para adicionar no cursor ou arraste para a linha do tempo.</div>`;
  panel.querySelector('#add-text').onclick = () => { addClip(makeTextClip()); focusText(); };
  panel.querySelectorAll('[data-style]').forEach((el) => {
    el.onclick = () => { addClip(styled(makeTextClip(), TEXT_STYLES[+el.dataset.style])); focusText(); };
  });
}

function styled(c, st) {
  const s = deepClone(st.s);
  c = deepClone(c);
  if (s.color) c.color = s.color;
  for (const k of ['stroke', 'bg', 'shadow', 'glow']) if (s[k]) Object.assign(c[k], s[k]);
  return c;
}

function focusText() {
  S.inspTab.text = 'Texto';
  setTimeout(() => { const ta = document.getElementById('text-input'); if (ta) { ta.focus(); ta.select(); } }, 50);
}

const shapeThumbs = {};
function shapeThumb(id) {
  if (shapeThumbs[id]) return shapeThumbs[id];
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const x = c.getContext('2d');
  x.translate(48, 48);
  const w = id === 'bar' || id === 'line' ? 84 : 64, h = id === 'line' ? 6 : id === 'bar' ? 26 : 64;
  const filled = shapePath(x, id, w, h, 0.25);
  if (filled) { x.fillStyle = '#a99bff'; x.fill(); } else { x.lineWidth = 7; x.strokeStyle = '#a99bff'; x.stroke(); }
  return (shapeThumbs[id] = c.toDataURL());
}

function newShape(id) {
  const W = S.project.width, H = S.project.height;
  const h = id === 'line' ? 0.012 : id === 'bar' ? 0.12 : id === 'frame' ? 0.92 : 0.3;
  const w = id === 'line' || id === 'bar' ? 0.5 : id === 'frame' ? 0.94 : (h * H) / W;
  const c = makeShapeClip(id, { w, h });
  if (id === 'bar') Object.assign(c, { y: 0.33, radius: 0.3 });
  if (id === 'frame' || id === 'ring') { c.fill = '#ffffff'; c.radius = 0.15; }
  if (brand.colors[0]) c.fill = brand.colors[0];
  return c;
}

function graphicsTab() {
  const bg = (a, b) => (b ? `linear-gradient(135deg,${a},${b})` : a);
  panel.innerHTML = `
    <h3>Formas</h3>
    <div class="tile-grid">${SHAPES.map(([id, name]) =>
      `<div class="tile" draggable="true" data-shape="${id}" data-drag="${dragData({ kind: 'clip', clip: newShape(id) })}"><img src="${shapeThumb(id)}" width="40" height="40" alt="">${name}</div>`).join('')}</div>
    <h3 style="margin-top:14px">Fundos</h3>
    <div class="bg-grid">${BACKGROUNDS.map(([a, b], i) => `<button class="bg-tile" data-bg="${i}" title="${b ? 'Gradiente' : 'Cor sólida'}" style="background:${bg(a, b)}"></button>`).join('')}</div>
    <div class="hint">Os fundos entram na faixa principal no ponto do cursor. Ótimos para títulos e encerramentos.</div>
    <h3 style="margin-top:14px">Stickers</h3>
    <div class="sticker-grid">${STICKERS.map((s) =>
      `<button draggable="true" data-st="${s}" data-drag="${dragData({ kind: 'clip', clip: makeStickerClip(s) })}">${s}</button>`).join('')}</div>`;
  panel.querySelectorAll('[data-shape]').forEach((el) => { el.onclick = () => addClip(newShape(el.dataset.shape)); });
  panel.querySelectorAll('[data-bg]').forEach((el) => {
    el.onclick = () => { const [a, b] = BACKGROUNDS[+el.dataset.bg]; addToMain(makeColorClip(a, b)); };
  });
  panel.querySelectorAll('[data-st]').forEach((b) => { b.onclick = () => addClip(makeStickerClip(b.dataset.st)); });
}

// ---------- Modelos ----------
let userTpls = null;
async function loadUserTemplates() { userTpls = await window.native.templatesList().catch(() => []); if (S.libTab === 'templates') render(); }

export function templateCard(tpl, extra = '') {
  const [a, b] = tpl.colors;
  const r = tpl.ratio === '9:16' ? '9 / 16' : '16 / 10';
  return `<div class="tpl" data-tpl="${tpl.id}">
    <div class="tpl-th" style="background:linear-gradient(135deg,${a},${b})"><span class="tpl-ratio">${tpl.ratio || (tpl.kind === 'overlay' ? 'Sobreposição' : 'Qualquer')}</span><span class="tpl-name">${tpl.name}</span></div>
    <div class="tpl-meta"><span class="muted">${tpl.desc}</span><span class="muted">${templateDuration(tpl).toFixed(0)}s</span></div>${extra}
  </div>`;
}

function templatesTab() {
  if (userTpls === null) { userTpls = []; loadUserTemplates(); }
  panel.innerHTML = `
    <h3>Modelos prontos</h3>
    <div class="tpl-grid">${BUILTIN.map((x) => templateCard(x)).join('')}</div>
    <div class="hint">Num projeto vazio o modelo vira o projeto; com clipes, ele é inserido no cursor. Depois é só editar os textos e as cores.</div>
    <h3 style="margin-top:14px">Meus modelos</h3>
    <div class="lib-actions"><button id="tpl-save">${icon('plus')} Salvar projeto como modelo</button></div>
    <div class="tpl-grid">${(userTpls || []).map((x) => `<div class="tpl" data-utpl="${x.id}">
      <div class="tpl-th" style="background:#0b0d10 url('${x.thumb || ''}') center/cover"><span class="tpl-ratio">${x.ratio}</span></div>
      <div class="tpl-meta"><span data-noi18n>${esc(x.name)}</span><button class="link" data-del="${x.id}" title="Excluir modelo">✕</button></div></div>`).join('') || '<div class="muted">Nenhum modelo salvo.</div>'}</div>`;
  panel.querySelectorAll('[data-tpl]').forEach((el) => { el.onclick = () => applyBuiltin(BUILTIN.find((x) => x.id === el.dataset.tpl)); });
  panel.querySelectorAll('[data-utpl]').forEach((el) => {
    el.onclick = async (e) => {
      const del = e.target.closest('[data-del]');
      const tpl = userTpls.find((x) => x.id === el.dataset.utpl);
      if (del) {
        if (await confirmModal('Excluir modelo', 'O modelo será removido de “Meus modelos”.', 'Excluir', true)) { await window.native.templateDelete(tpl.id); loadUserTemplates(); }
        return;
      }
      applyUserTemplate(tpl);
    };
  });
  panel.querySelector('#tpl-save').onclick = async () => {
    if (S.project.tracks.every((x) => !x.clips.length)) { toast('Adicione algo à linha do tempo primeiro'); return; }
    const name = await promptModal('Nome do modelo', S.project.name);
    if (!name) return;
    const { snapshotThumb } = await import('./stage.js');
    await saveAsTemplate(name, snapshotThumb());
    loadUserTemplates();
  };
}

// ---------- Kit da marca ----------
function brandTab() {
  const fontOpts = (cur) => `<option value="">Padrão</option>${FONTS.map((f) => `<option value="${esc(f)}" ${f === cur ? 'selected' : ''} data-noi18n>${esc(f)}</option>`).join('')}`;
  panel.innerHTML = `
    <div class="hint">O kit da marca vale para todos os projetos: logos, cores e fontes sempre à mão.</div>
    <h3>Logos</h3>
    <div class="media-grid">${brand.logos.map((p, i) => `<div class="media-item logo-item" data-logo="${i}" style="background-image:url('${mediaUrl(p)}')" title="${esc(p)}"><button class="add" title="Adicionar ao vídeo">+</button><button class="del" data-dellogo="${i}" title="Remover">✕</button></div>`).join('')}</div>
    <div class="lib-actions" style="margin-top:8px"><button id="logo-add">${icon('import')} Adicionar logo</button></div>
    <h3 style="margin-top:14px">Cores</h3>
    <div class="swatches big">${brand.colors.map((c, i) => `<button class="sw" data-col="${i}" title="${c} — clique para aplicar à seleção" style="background:${c}"><span data-delcol="${i}">✕</span></button>`).join('')}
      <label class="sw add" title="Adicionar cor">+<input type="color" id="col-add" value="#7c5cff"></label></div>
    <div class="hint">Clique numa cor para aplicá-la ao texto, forma ou fundo selecionado.</div>
    <h3 style="margin-top:14px">Fontes</h3>
    <div class="row"><label>Títulos</label><select id="f-title">${fontOpts(brand.fontTitle)}</select></div>
    <div class="row"><label>Textos</label><select id="f-body">${fontOpts(brand.fontBody)}</select></div>
    <div class="btn-row"><button id="f-apply">Aplicar à seleção</button><button id="f-all">Aplicar a todos os textos</button></div>`;
  panel.querySelector('#logo-add').onclick = async () => {
    const files = await window.native.pickMedia('image');
    if (!files.length) return;
    brand.logos = [...new Set([...brand.logos, ...files])];
    saveBrand();
  };
  panel.querySelectorAll('[data-logo]').forEach((el) => {
    el.onclick = async (e) => {
      const i = +el.dataset.logo;
      if (e.target.closest('[data-dellogo]')) { brand.logos.splice(i, 1); saveBrand(); return; }
      const [m] = await importPaths([brand.logos[i]]);
      if (!m) return;
      const c = makeMediaClip(m);
      const W = S.project.width, H = S.project.height;
      const fit = Math.min(W / m.width, H / m.height);
      c.scale = (0.16 * Math.min(W, H)) / (Math.max(m.width, m.height) * fit);
      const bw = (m.width * fit * c.scale) / W, bh = (m.height * fit * c.scale) / H;
      c.x = 0.5 - bw / 2 - 0.025; c.y = -0.5 + bh / 2 + 0.035;
      c.dur = Math.max(3, S.project.duration - S.t) || 5;
      addClip(c, S.t);
      toast('Logo adicionado no canto superior direito');
    };
  });
  panel.querySelector('#col-add').onchange = (e) => { if (!brand.colors.includes(e.target.value)) { brand.colors.push(e.target.value); saveBrand(); } };
  panel.querySelectorAll('[data-col]').forEach((el) => {
    el.onclick = (e) => {
      const i = +el.dataset.col;
      if (e.target.closest('[data-delcol]')) { brand.colors.splice(i, 1); saveBrand(); return; }
      const f = selClip();
      const c = f?.clip;
      const key = c && { text: 'color', shape: 'fill', color: 'color' }[c.type];
      if (!key) { toast('Selecione um texto, forma ou fundo'); return; }
      checkpoint(); c[key] = brand.colors[i]; changed('structure');
    };
  });
  panel.querySelector('#f-title').onchange = (e) => { brand.fontTitle = e.target.value; saveBrand(); };
  panel.querySelector('#f-body').onchange = (e) => { brand.fontBody = e.target.value; saveBrand(); };
  const fontFor = (c) => (c.size >= 0.075 ? brand.fontTitle : brand.fontBody) || brand.fontTitle || brand.fontBody;
  panel.querySelector('#f-apply').onclick = () => {
    const f = selClip();
    if (!f || f.clip.type !== 'text') { toast('Selecione um texto'); return; }
    const font = fontFor(f.clip);
    if (!font) { toast('Escolha uma fonte da marca primeiro'); return; }
    checkpoint(); f.clip.font = font; changed('structure');
  };
  panel.querySelector('#f-all').onclick = () => {
    if (!brand.fontTitle && !brand.fontBody) { toast('Escolha uma fonte da marca primeiro'); return; }
    checkpoint();
    let n = 0;
    for (const tr of S.project.tracks) for (const c of tr.clips) if (c.type === 'text') { c.font = fontFor(c); n++; }
    changed('structure');
    toast(t('Fonte aplicada a {0} texto(s)', n));
  };
}

function effectsTab() {
  panel.innerHTML = `<h3>Efeitos de vídeo</h3><div class="tile-grid">${EFFECTS.map((e) =>
    `<div class="tile" draggable="true" data-fx="${e.id}" data-drag="${dragData({ kind: 'clip', clip: makeEffectClip(e.id) })}"><span class="big">${e.icon}</span>${e.name}</div>`).join('')}</div>
    <div class="hint" style="margin-top:12px">Efeitos ficam numa faixa própria e afetam tudo que está abaixo dela.</div>`;
  panel.querySelectorAll('[data-fx]').forEach((t) => { t.onclick = () => addClip(makeEffectClip(t.dataset.fx)); });
}

function junctionTarget() {
  if (S.sel?.kind === 'junction') return S.sel.id;
  const f = selClip();
  if (f && f.track.kind === 'main' && f.index < f.track.clips.length - 1) return f.clip.id;
  // nearest cut to the playhead
  const clips = mainTrack().clips;
  let best = null, bd = Infinity;
  clips.forEach((c, i) => {
    if (i === clips.length - 1) return;
    const d = Math.abs(c.start + clipDuration(c) - S.t);
    if (d < bd) { bd = d; best = c.id; }
  });
  return best;
}

function transitionsTab() {
  const tgt = junctionTarget();
  const cur = tgt ? S.project.tracks[0].clips.find((c) => c.id === tgt)?.transition?.type : null;
  panel.innerHTML = `<h3>Transições</h3><div class="tile-grid">${TRANSITIONS.map((t) =>
    `<div class="tile ${cur === t.id ? 'on' : ''}" data-tr="${t.id}"><span class="big">${trIcon(t.id)}</span>${t.name}</div>`).join('')}</div>
    <div class="hint" style="margin-top:12px">${tgt ? 'Aplicando no corte selecionado (ou o mais próximo do cursor).' : 'Adicione pelo menos dois clipes à faixa principal.'}</div>`;
  panel.querySelectorAll('[data-tr]').forEach((t) => {
    t.onclick = () => {
      const id = junctionTarget();
      if (!id) { toast('Adicione dois clipes na faixa principal primeiro'); return; }
      setTransition(id, t.dataset.tr);
      S.sel = { kind: 'junction', id };
      emit('change', 'select');
    };
  });
}

function trIcon(id) {
  return { none: '∅', fade: '◐', black: '●', white: '○', 'slide-left': '⇠', 'slide-right': '⇢', 'slide-up': '⇡', 'push-left': '⇇', 'wipe-right': '▶', 'wipe-down': '▼', circle: '◎', 'zoom-in': '⊕', blur: '◌', spin: '↻' }[id] || '⇄';
}

function filtersTab() {
  const f = selClip();
  const c = f && (f.clip.type === 'video' || f.clip.type === 'image' || f.clip.type === 'sticker') ? f.clip : null;
  const thumb = c && c.mediaId ? cache.thumbs[c.mediaId] : null;
  const prevImg = thumb || Object.values(cache.thumbs)[0] || '';
  panel.innerHTML = `<h3>Filtros</h3>
    ${c ? '' : '<div class="hint">Selecione um clipe de vídeo ou foto para aplicar um filtro.</div>'}
    <div class="tile-grid">${FILTERS.map((fl) => {
      const ff = fl.f || {};
      const css = [];
      if (ff.brightness) css.push(`brightness(${ff.brightness})`);
      if (ff.contrast) css.push(`contrast(${ff.contrast})`);
      if (ff.saturate) css.push(`saturate(${ff.saturate})`);
      if (ff.sepia) css.push(`sepia(${ff.sepia})`);
      if (ff.grayscale) css.push(`grayscale(${ff.grayscale})`);
      if (ff.hue) css.push(`hue-rotate(${ff.hue}deg)`);
      return `<div class="tile ${c && c.filter?.name === fl.id ? 'on' : ''}" data-filter="${fl.id}">
        <div class="fprev" style="background-image:url('${prevImg}');filter:${css.join(' ') || 'none'}">${fl.tint ? `<div class="tint" style="background:${fl.tint[0]};opacity:${fl.tint[1]}"></div>` : ''}</div>${fl.name}</div>`;
    }).join('')}</div>
    ${c ? '<div class="btn-row" style="margin-top:12px"><button id="f-all">Aplicar a todos os clipes</button></div>' : ''}`;
  panel.querySelectorAll('[data-filter]').forEach((t) => {
    t.onclick = () => {
      const f2 = selClip();
      if (!f2 || !f2.clip.filter) { toast('Selecione um clipe de vídeo ou foto'); return; }
      checkpoint();
      f2.clip.filter = { name: t.dataset.filter, intensity: f2.clip.filter.intensity ?? 1 };
      S.inspTab[f2.clip.type] = 'Ajustar';
      changed('structure');
    };
  });
  const all = panel.querySelector('#f-all');
  if (all) all.onclick = () => {
    checkpoint();
    for (const tr of S.project.tracks) for (const x of tr.clips) if (x.filter) x.filter = deepClone(c.filter);
    changed('structure');
    toast('Filtro aplicado a todos os clipes');
  };
}
