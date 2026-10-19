// "Support the project" dialog: Buy Me a Coffee + Pix.
import { modal } from './ui.js';
import { t } from './i18n.js';
import { toast } from './store.js';

export const BMC_URL = 'https://buymeacoffee.com/kromossomoc';
export const PIX_KEY = '94af8068-d112-4c69-bcfa-8789b233246e';
// Static Pix BR Code (EMV) for the key above; CRC16 validated against the Banco Central reference example.
export const PIX_PAYLOAD = '00020126580014br.gov.bcb.pix013694af8068-d112-4c69-bcfa-8789b233246e5204000053039865802BR5908CLIPNOVA6006BRASIL62070503***63047773';

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(t('{0} copiado!', label)); }
  catch { toast(t('Não foi possível copiar'), true); }
}

export function openSupport() {
  const m = modal(`
    <h2>☕ Apoie o ClipNova</h2>
    <div class="muted">O ClipNova é gratuito. Se ele te ajudou, considere apoiar o desenvolvimento.</div>
    <button class="bmc" data-bmc>☕ Buy Me a Coffee</button>
    <div class="pix">
      <img src="assets/pix-qr.png" alt="QR Code Pix" width="180" height="180">
      <div class="pix-info">
        <b>Pix</b>
        <div class="muted">Escaneie o QR Code no app do seu banco ou use a chave abaixo.</div>
        <div class="pix-key" data-noi18n>${PIX_KEY}</div>
        <div class="btn-row"><button data-key>Copiar chave</button><button data-code>Pix copia e cola</button></div>
      </div>
    </div>
    <div class="foot"><button data-x>Fechar</button></div>`, { width: 560 });
  m.el.querySelector('[data-bmc]').onclick = () => window.open(BMC_URL);
  m.el.querySelector('[data-key]').onclick = () => copy(PIX_KEY, t('Chave Pix'));
  m.el.querySelector('[data-code]').onclick = () => copy(PIX_PAYLOAD, t('Código Pix'));
  m.el.querySelector('[data-x]').onclick = () => m.close();
}
