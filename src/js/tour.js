// Guided tour of the editor: a spotlight on each area with an explanation card.
import { t } from './i18n.js';
import { S, emit } from './store.js';

const DONE_KEY = 'clipnova.tourDone';

const STEPS = [
  { title: 'Bem-vindo ao ClipNova!', text: 'Este tour rápido mostra as principais funções do editor. Use as setas do teclado ou os botões para navegar.' },
  { sel: '#lib-tabs', side: 'right', title: 'Biblioteca', text: 'Aqui ficam suas mídias, áudios, textos, stickers, efeitos, transições e filtros. Importe arquivos ou arraste-os do computador direto para a janela.' },
  { sel: '.lib-tab[data-tab="ai"]', side: 'right', before: () => emit('lib-tab', 'ai'), title: 'Inteligência artificial', text: 'Gere legendas automáticas a partir da fala, traduza legendas e crie narrações com vozes de IA usando sua chave do Gemini. Há também ferramentas locais: remover silêncios, dividir por cenas e melhorar a voz.' },
  { sel: '#stage', side: 'bottom', after: () => emit('lib-tab', 'media'), title: 'Reprodutor', text: 'Prévia em tempo real. Clique em uma camada para selecioná-la e arraste para mover; use os cantos para redimensionar e a alça de cima para girar.' },
  { sel: '.transport', side: 'top', title: 'Controles de reprodução', text: 'Reproduza com a barra de espaço, avance quadro a quadro com as setas e troque a proporção do vídeo (16:9, 9:16, 1:1…).' },
  { sel: '#inspector', side: 'left', title: 'Propriedades', text: 'Ajuste o clipe selecionado: posição, escala, keyframes, máscara, chroma key, filtros, cor, animações, velocidade e áudio. Sem nada selecionado, aparecem as configurações do projeto.' },
  { sel: '#tl-toolbar', side: 'top', title: 'Ferramentas de edição', text: 'Dividir (Ctrl+B), excluir, duplicar, congelar quadro, inverter, espelhar, girar, recortar e extrair áudio. O ímã encaixa os clipes automaticamente.' },
  { sel: '#tl-scroll', side: 'top', title: 'Linha do tempo', text: 'Organize tudo em faixas: principal (magnética), sobreposições, textos, efeitos e áudio. Arraste para mover, puxe as bordas para cortar e use Ctrl + roda do mouse para zoom. Clique no + entre dois clipes para adicionar uma transição.' },
  { sel: '#btn-export', side: 'bottom', title: 'Exportar', text: 'Quando terminar, exporte em MP4 de 480p a 4K, de 24 a 60 fps. O resultado é idêntico à prévia.' },
  { sel: '#btn-tour', side: 'bottom', title: 'Tudo pronto!', text: 'Você pode rever este tour a qualquer momento por este botão. Boa edição!' },
];

let root = null, idx = 0;

export function shouldAutoStart() {
  try { return !localStorage.getItem(DONE_KEY); } catch { return false; }
}

export function startTour() {
  endTour(false);
  idx = 0;
  root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `<div class="tour-hole"></div><div class="tour-card" role="dialog"><div class="tour-step"></div><h3></h3><p></p>
    <div class="tour-foot"><button data-skip class="link">${t('Pular tour')}</button><div class="grow"></div><button data-prev>${t('Anterior')}</button><button data-next class="primary"></button></div></div>`;
  document.body.append(root);
  root.querySelector('[data-skip]').onclick = () => endTour(true);
  root.querySelector('[data-prev]').onclick = () => go(idx - 1);
  root.querySelector('[data-next]').onclick = () => (idx === STEPS.length - 1 ? endTour(true) : go(idx + 1));
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey, true);
  go(0);
}

function onKey(e) {
  if (!root) return;
  if (e.key === 'Escape') { endTour(true); }
  else if (e.key === 'ArrowRight' || e.key === 'Enter') { idx === STEPS.length - 1 ? endTour(true) : go(idx + 1); }
  else if (e.key === 'ArrowLeft') { go(idx - 1); }
  else return;
  e.preventDefault(); e.stopPropagation();
}

function go(i) {
  if (!root || i < 0 || i >= STEPS.length) return;
  STEPS[idx]?.after?.();
  idx = i;
  const st = STEPS[idx];
  st.before?.();
  root.querySelector('.tour-step').textContent = t('{0} de {1}', idx + 1, STEPS.length);
  root.querySelector('h3').textContent = t(st.title);
  root.querySelector('p').textContent = t(st.text);
  root.querySelector('[data-prev]').disabled = idx === 0;
  root.querySelector('[data-next]').textContent = idx === STEPS.length - 1 ? t('Concluir') : t('Próximo');
  requestAnimationFrame(place);
}

function place() {
  if (!root) return;
  const st = STEPS[idx];
  const hole = root.querySelector('.tour-hole');
  const card = root.querySelector('.tour-card');
  const el = st.sel && document.querySelector(st.sel);
  const vw = window.innerWidth, vh = window.innerHeight, pad = 6, gap = 14;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  if (!el) {
    hole.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0`;
    card.style.left = (vw - cw) / 2 + 'px';
    card.style.top = (vh - ch) / 2 + 'px';
    return;
  }
  const r = el.getBoundingClientRect();
  const x = r.left - pad, y = r.top - pad, w = r.width + pad * 2, h = r.height + pad * 2;
  hole.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  let cx, cy;
  const side = st.side || 'bottom';
  if (side === 'right') { cx = x + w + gap; cy = y + Math.min(40, h / 2); }
  else if (side === 'left') { cx = x - cw - gap; cy = y + Math.min(40, h / 2); }
  else if (side === 'top') { cx = x + w / 2 - cw / 2; cy = y - ch - gap; }
  else { cx = x + w / 2 - cw / 2; cy = y + h + gap; }
  // keep the card on screen; if it would cover the target vertically, flip
  if (side === 'bottom' && cy + ch > vh - 8) cy = y - ch - gap;
  if (side === 'top' && cy < 8) cy = Math.min(vh - ch - 8, y + h + gap);
  card.style.left = Math.max(8, Math.min(vw - cw - 8, cx)) + 'px';
  card.style.top = Math.max(8, Math.min(vh - ch - 8, cy)) + 'px';
}

export function endTour(markDone) {
  if (!root) return;
  STEPS[idx]?.after?.();
  root.remove();
  root = null;
  window.removeEventListener('resize', place);
  document.removeEventListener('keydown', onKey, true);
  if (markDone) try { localStorage.setItem(DONE_KEY, '1'); } catch {}
}

export const tourActive = () => !!root;
export { S };
