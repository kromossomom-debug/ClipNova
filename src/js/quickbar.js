// Floating toolbar over the preview with the most used actions for the selected clip.
import { S, on, emit, selClip, frameSelected, rotateSelected, mirrorSelected, splitAtPlayhead, duplicateSelected, deleteSelected } from './store.js';
import { icon } from './icons.js';

let el;

export function initQuickbar() {
  el = document.getElementById('quick-bar');
  on('change', (k) => { if (k !== 'props' && k !== 'move' && k !== 'trim') render(); });
  render();
}

function render() {
  const f = S.project && selClip();
  const c = f?.clip;
  if (!c || c.type === 'audio' || c.type === 'effect') { el.classList.add('hidden'); return; }
  const media = c.type === 'video' || c.type === 'image';
  const items = [];
  if (media) {
    items.push(['crop', 'Recortar', () => { S.inspTab[c.type] = 'Vídeo'; S.inspCollapsed = false; document.getElementById('workspace').classList.remove('insp-collapsed'); emit('change', 'select'); }]);
    items.push(['fitframe', 'Ajustar', () => frameSelected('fit')], ['fill', 'Preencher', () => frameSelected('fill')], ['pip', 'Imagem em imagem', () => frameSelected('pip')], '|');
  }
  if (c.type === 'text') items.push(['text', 'Editar texto', () => { S.inspTab.text = 'Texto'; emit('change', 'select'); setTimeout(() => document.getElementById('text-input')?.focus(), 30); }], '|');
  if (c.type !== 'color') items.push(['rotate', 'Girar 90°', rotateSelected]);
  items.push(['mirror', 'Espelhar', mirrorSelected], '|');
  items.push(['split', 'Dividir (Ctrl+B)', splitAtPlayhead], ['copy', 'Duplicar (Ctrl+D)', duplicateSelected], ['trash', 'Excluir (Delete)', deleteSelected]);
  el.innerHTML = '';
  for (const it of items) {
    if (it === '|') { el.append(Object.assign(document.createElement('div'), { className: 'sep' })); continue; }
    const b = document.createElement('button');
    b.className = 'icon-btn'; b.title = it[1]; b.innerHTML = icon(it[0]);
    b.onclick = it[2];
    el.append(b);
  }
  el.classList.remove('hidden');
}
