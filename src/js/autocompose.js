// Automatic video: pick media, a style and a length; ClipNova cuts, orders, adds transitions, a title and music.
// Everything runs locally (simple editing rules, no cloud service).
import { S, checkpoint, changed, importPaths, mainTrack, placeClip, toast, emit } from './store.js';
import { newProject, makeMediaClip, makeTextClip, layout, clipDuration, clamp, TEXT_STYLES, deepClone, sizeForRatio } from './model.js';
import { soundFile } from './sfx.js';
import { encodeWav } from './export.js';
import { modal, esc } from './ui.js';
import { icon } from './icons.js';
import { brand } from './brand.js';
import { t } from './i18n.js';

const STYLES = {
  energetic: { name: 'Energético', trans: ['zoom-in', 'push-left', 'white', 'slide-up', 'spin', 'slide-left'], tdur: 0.35, seg: 0.7, title: 'pop', text: 'Contorno', music: 'pop', filter: 'vivid', kb: false },
  elegant: { name: 'Elegante', trans: ['fade'], tdur: 0.9, seg: 1.1, title: 'fade', text: 'Sombra', music: 'corporate', filter: 'film', kb: true },
  soft: { name: 'Suave', trans: ['fade', 'blur'], tdur: 0.7, seg: 1, title: 'slide-up', text: 'Simples', music: 'lofi', filter: 'warm', kb: true },
  epic: { name: 'Épico', trans: ['black', 'zoom-in', 'fade'], tdur: 0.6, seg: 0.9, title: 'zoom-out', text: 'Contorno', music: 'cinematic', filter: 'drama', kb: true },
};

export function openAutoCompose(openProject) {
  let paths = [];
  const f = { title: '', style: 'energetic', ratio: '16:9', dur: 30, music: true };
  const m = modal(`
    <h2>${icon('ai')} Criar vídeo automaticamente</h2>
    <div class="hint">Escolha suas fotos e vídeos. O ClipNova monta o vídeo com cortes no ritmo, transições, título e trilha sonora — depois você pode editar tudo.</div>
    <div class="btn-row"><button class="primary" data-pick>${icon('import')} Escolher mídias</button></div>
    <div class="ac-list" data-list><span class="muted">Nenhuma mídia escolhida.</span></div>
    <div class="row"><label>Título</label><input type="text" data-title placeholder="${esc(t('Opcional — aparece no início'))}"></div>
    <div class="row"><label>Estilo</label><div class="seg" data-style>${Object.entries(STYLES).map(([k, s]) => `<button data-v="${k}" class="${k === f.style ? 'on' : ''}">${s.name}</button>`).join('')}</div></div>
    <div class="row"><label>Formato</label><div class="seg" data-ratio>${[['16:9', '16:9 Paisagem'], ['9:16', '9:16 Vertical'], ['1:1', '1:1 Quadrado']].map(([v, n]) => `<button data-v="${v}" class="${v === f.ratio ? 'on' : ''}">${n}</button>`).join('')}</div></div>
    <div class="row"><label>Duração</label><div class="seg" data-dur>${[15, 30, 60].map((v) => `<button data-v="${v}" class="${v === f.dur ? 'on' : ''}">${v}s</button>`).join('')}</div></div>
    <label class="check"><input type="checkbox" data-music checked> Adicionar trilha sonora (ou use um áudio entre as mídias escolhidas)</label>
    <div class="foot"><button data-x>Cancelar</button><button class="primary" data-go disabled>Criar vídeo</button></div>`, { width: 560 });
  const q = (s) => m.el.querySelector(s);
  const segs = (sel, key, num) => m.el.querySelectorAll(`${sel} button`).forEach((b) => {
    b.onclick = () => { f[key] = num ? +b.dataset.v : b.dataset.v; m.el.querySelectorAll(`${sel} button`).forEach((x) => x.classList.toggle('on', x === b)); };
  });
  segs('[data-style]', 'style'); segs('[data-ratio]', 'ratio'); segs('[data-dur]', 'dur', true);
  q('[data-pick]').onclick = async () => {
    const add = await window.native.pickMedia('media');
    paths = [...new Set([...paths, ...add])];
    q('[data-list]').innerHTML = paths.length
      ? paths.map((p) => `<span class="ac-chip" data-noi18n>${esc(p.split(/[\\/]/).pop())}</span>`).join('')
      : '<span class="muted">Nenhuma mídia escolhida.</span>';
    q('[data-go]').disabled = !paths.length;
  };
  q('[data-x]').onclick = () => m.close();
  q('[data-go]').onclick = async () => {
    f.title = q('[data-title]').value.trim();
    f.music = q('[data-music]').checked;
    m.close();
    const p = newProject(f.title || t('Vídeo automático'), f.ratio);
    await openProject(p, true);
    emit('busy', 'Montando o vídeo…');
    try { await compose(paths, f); } catch (e) { toast('Falha na criação automática: ' + e.message, true); } finally { emit('busy', null); }
  };
}

export async function compose(paths, f) {
  const st = STYLES[f.style];
  const media = await importPaths(paths);
  const visuals = media.filter((x) => x.type !== 'audio');
  const audios = media.filter((x) => x.type === 'audio');
  if (!visuals.length) { toast('Escolha pelo menos uma foto ou vídeo', true); return; }
  checkpoint();
  const p = S.project;
  Object.assign(p, sizeForRatio(f.ratio), { ratio: f.ratio });
  emit('resize');
  const W = p.width, H = p.height;
  const seg = clamp((f.dur / visuals.length) * st.seg, 1.2, 7);
  const main = mainTrack();
  visuals.forEach((m, i) => {
    const c = makeMediaClip(m);
    if (m.type === 'image') c.dur = seg;
    else {
      const len = Math.min(m.duration, seg * 1.25);
      c.in = Math.max(0, (m.duration - len) * 0.35);
      c.out = c.in + len;
    }
    // fill the frame (no black bars), like a social video
    if (m.width) c.scale = Math.max(W / m.width, H / m.height) / Math.min(W / m.width, H / m.height);
    if (st.kb && m.type === 'image') {
      const d = clipDuration(c), zoomIn = i % 2 === 0;
      const k0 = c.scale * (zoomIn ? 1 : 1.12), k1 = c.scale * (zoomIn ? 1.12 : 1);
      c.keyframes = [{ t: 0, x: 0, y: 0, scale: k0, rotation: 0, opacity: 1 }, { t: d, x: zoomIn ? 0.02 : -0.02, y: 0, scale: k1, rotation: 0, opacity: 1 }];
    }
    c.filter = { name: st.filter, intensity: 0.55 };
    if (i < visuals.length - 1) c.transition = { type: st.trans[i % st.trans.length], dur: st.tdur };
    main.clips.push(c);
  });
  const last = main.clips[main.clips.length - 1];
  last.anim.out = { type: 'fade', dur: Math.min(1, clipDuration(last) / 2) };
  layout(p);
  const total = p.duration;

  if (f.title) {
    const tc = makeTextClip(f.title);
    const style = TEXT_STYLES.find((x) => x.name === st.text);
    if (style) {
      const s = deepClone(style.s);
      if (s.color) tc.color = s.color;
      for (const k of ['stroke', 'bg', 'shadow', 'glow']) if (s[k]) Object.assign(tc[k], s[k]);
    }
    if (brand.fontTitle) tc.font = brand.fontTitle;
    tc.size = f.ratio === '9:16' ? 0.055 : 0.09;
    tc.dur = Math.min(3.5, total);
    tc.anim = { in: { type: st.title, dur: 0.6 }, out: { type: 'fade', dur: 0.5 }, loop: { type: 'none', speed: 1 } };
    placeClip(tc, 0.2);
  }

  if (f.music) {
    let track = audios[0];
    if (!track) {
      const file = await soundFile('music', st.music, encodeWav);
      [track] = await importPaths([file]);
      if (track) track.name = t('Trilha automática');
    }
    if (track) {
      const hasVideoSound = visuals.some((m) => m.hasAudio);
      for (const c of main.clips) if (c.type === 'video') c.volume = 0.5;
      let at = 0;
      while (at < total - 0.05) {
        const len = Math.min(track.duration, total - at);
        const a = makeMediaClip(track);
        a.in = 0; a.out = len;
        a.volume = hasVideoSound ? 0.55 : 0.8;
        a.fadeIn = at === 0 ? 0.5 : 0;
        a.fadeOut = at + len >= total - 0.05 ? Math.min(2, len / 2) : 0;
        placeClip(a, at);
        at += len;
      }
    }
  }
  S.sel = null;
  S.t = 0;
  changed('structure');
  emit('seek', 0);
  toast(t('Vídeo criado com {0} mídia(s) — {1}s', visuals.length, Math.round(total)));
}
