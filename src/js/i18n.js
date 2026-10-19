// Interface localization. The UI is authored in Portuguese (pt-BR); other languages are applied by
// translating DOM text nodes and title/placeholder attributes as they appear (MutationObserver),
// plus t() for strings that never reach the DOM (canvas text, default names).
import DICT from './i18n-dict.js';

export const LANGUAGES = [['pt-BR', 'Português (BR)'], ['en', 'English'], ['es', 'Español'], ['ru', 'Русский']];
const COL = { en: 0, es: 1, ru: 2 };
const KEY = 'clipnova.lang';

function detect() {
  const n = (navigator.language || 'pt-BR').toLowerCase();
  if (n.startsWith('pt')) return 'pt-BR';
  if (n.startsWith('es')) return 'es';
  if (n.startsWith('ru')) return 'ru';
  if (n.startsWith('en')) return 'en';
  return 'pt-BR';
}

let saved = null;
try { saved = localStorage.getItem(KEY); } catch {}
export const lang = LANGUAGES.some(([c]) => c === saved) ? saved : detect();
export const locale = lang === 'pt-BR' ? 'pt-BR' : lang === 'en' ? 'en-US' : lang === 'es' ? 'es-ES' : 'ru-RU';
const col = COL[lang];

export function setLang(code) {
  try { localStorage.setItem(KEY, code); } catch {}
  location.reload();
}

const exact = new Map();
const patterns = [];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
if (col != null) {
  for (const [pt, tr] of Object.entries(DICT)) {
    const out = tr[col];
    if (out == null) continue;
    if (/\{\d\}/.test(pt)) {
      const re = new RegExp('^' + escRe(pt).replace(/\\\{(\d)\\\}/g, '(.+?)') + '$', 's');
      const order = [...pt.matchAll(/\{(\d)\}/g)].map((m) => +m[1]);
      patterns.push({ re, out, order });
    } else exact.set(pt, out);
  }
  // longer patterns first so the most specific one wins
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
}

function translate(s) {
  if (col == null || !s) return null;
  const hit = exact.get(s);
  if (hit != null) return hit;
  for (const p of patterns) {
    const m = p.re.exec(s);
    if (!m) continue;
    let out = p.out;
    p.order.forEach((idx, i) => {
      const v = m[i + 1];
      out = out.replace(`{${idx}}`, translate(v) ?? v);
    });
    return out;
  }
  return null;
}

// t('texto {0}', valor) — used for strings that don't go through the DOM.
// A leading '§' marks a key that is only for t() (stripped in Portuguese).
export function t(s, ...args) {
  let out = translate(s) ?? s.replace(/^§/, '');
  args.forEach((a, i) => { out = out.replace(`{${i}}`, a); });
  return out;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CANVAS', 'SVG', 'svg']);
const ATTRS = ['title', 'placeholder'];

function doText(node) {
  const raw = node.nodeValue;
  const core = raw.trim();
  if (!core || core.length > 400) return;
  const tr = translate(core);
  if (tr != null && tr !== core) node.nodeValue = raw.replace(core, tr);
}

function doAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const tr = translate(v.trim());
    if (tr != null && tr !== v) el.setAttribute(a, tr);
  }
}

function walk(node) {
  if (node.nodeType === 3) { if (!node.parentElement?.closest('[data-noi18n]')) doText(node); return; }
  if (node.nodeType !== 1 || node.hasAttribute('data-noi18n')) return;
  doAttrs(node);
  if (SKIP.has(node.tagName)) return;
  for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
}

export function startDomTranslation() {
  document.documentElement.lang = lang;
  if (col == null) return;
  walk(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(walk);
      else if (m.type === 'characterData') { if (!m.target.parentElement?.closest('[data-noi18n]')) doText(m.target); }
      else if (m.type === 'attributes' && !m.target.closest('[data-noi18n]')) doAttrs(m.target);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
