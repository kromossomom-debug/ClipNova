// Shared modal helpers.
export function modal(html, { onClose, width } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal"${width ? ` style="width:${width}px"` : ''}>${html}</div>`;
  document.getElementById('modal-root').append(back);
  const close = () => { back.remove(); onClose?.(); };
  back.addEventListener('pointerdown', (e) => { if (e.target === back && !back.dataset.locked) close(); });
  return { el: back.querySelector('.modal'), close, back };
}

export function confirmModal(title, text, okText = 'Confirmar', danger = false) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${title}</h2><div class="muted">${text}</div><div class="foot"><button data-x>Cancelar</button><button class="${danger ? 'danger' : 'primary'}" data-ok>${okText}</button></div>`, { onClose: () => resolve(false) });
    m.el.querySelector('[data-x]').onclick = () => m.close();
    m.el.querySelector('[data-ok]').onclick = () => { m.back.remove(); resolve(true); };
  });
}

export function promptModal(title, value) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${title}</h2><input type="text" style="width:100%" data-v><div class="foot"><button data-x>Cancelar</button><button class="primary" data-ok>OK</button></div>`, { onClose: () => resolve(null) });
    const inp = m.el.querySelector('[data-v]');
    inp.value = value; setTimeout(() => { inp.focus(); inp.select(); }, 10);
    const ok = () => { m.back.remove(); resolve(inp.value.trim()); };
    m.el.querySelector('[data-x]').onclick = () => m.close();
    m.el.querySelector('[data-ok]').onclick = ok;
    inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') m.close(); };
  });
}

// Progress dialog that can't be dismissed by clicking outside.
export function progressModal(title, text = '') {
  const m = modal(`<h2>${title}</h2><div data-t class="muted">${text}</div><div class="progress"><div data-bar style="width:0"></div></div>`);
  m.back.dataset.locked = '1';
  return {
    set(frac, t) {
      if (frac == null) { m.el.querySelector('[data-bar]').style.cssText = 'width:100%;animation:blink 1.2s infinite'; }
      else m.el.querySelector('[data-bar]').style.cssText = `width:${(frac * 100).toFixed(1)}%`;
      if (t != null) m.el.querySelector('[data-t]').textContent = t;
    },
    close: () => m.back.remove(),
  };
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
