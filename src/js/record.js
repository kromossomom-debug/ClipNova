// Screen / camera recorder ("Gravar e criar"). Recordings are transcoded to MP4 and dropped on the timeline;
// in screen + camera mode the camera becomes a round picture-in-picture overlay.
import { S, emit, checkpoint, changed, importPaths, addMedia, placeClip, mainTrack, toast } from './store.js';
import { makeMediaClip } from './model.js';
import { modal, esc } from './ui.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

let active = null;
export const isRecording = () => !!active;

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function pickMime() {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return { cams: all.filter((d) => d.kind === 'videoinput'), mics: all.filter((d) => d.kind === 'audioinput') };
}

// mode: 'screen' | 'camera' | 'both'
export async function openRecorder(mode) {
  if (active) { toast('Já existe uma gravação em andamento'); return; }
  const needScreen = mode !== 'camera', needCam = mode !== 'screen';
  let sources = [];
  if (needScreen) {
    try { sources = await window.native.captureSources(); } catch (e) { toast('Não foi possível listar as telas: ' + e.message, true); return; }
  }
  // labels only appear after a permission grant; ask once so the device list is readable
  if (needCam) await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => s.getTracks().forEach((x) => x.stop())).catch(() => {});
  const { cams, mics } = await listDevices();
  const titles = { screen: 'Gravar tela', camera: 'Gravar câmera', both: 'Gravar tela e câmera' };
  const m = modal(`
    <h2>${titles[mode]}</h2>
    ${needScreen ? `<div class="hint">Escolha o que gravar:</div>
      <div class="cap-grid">${sources.map((s, i) => `<button class="cap-src ${i === 0 ? 'on' : ''}" data-src="${esc(s.id)}"><img src="${s.thumb}"><span data-noi18n>${esc(s.screen ? t('Tela {0}', i + 1) : s.name)}</span></button>`).join('')}</div>` : ''}
    ${needCam ? `<div class="row"><label>Câmera</label><select data-cam>${cams.map((d, i) => `<option value="${esc(d.deviceId)}" data-noi18n>${esc(d.label || t('Câmera {0}', i + 1))}</option>`).join('') || '<option value="">Nenhuma câmera encontrada</option>'}</select></div>
      <video class="cam-prev" data-camprev autoplay muted playsinline></video>` : ''}
    <div class="row"><label>Microfone</label><select data-mic><option value="">Sem microfone</option>${mics.map((d, i) => `<option value="${esc(d.deviceId)}" ${i === 0 ? 'selected' : ''} data-noi18n>${esc(d.label || t('Microfone {0}', i + 1))}</option>`).join('')}</select></div>
    ${needScreen && window.native.platform === 'win32' ? '<label class="check"><input type="checkbox" data-sys checked> Gravar o som do computador</label>' : ''}
    ${needScreen ? '<label class="check"><input type="checkbox" data-min> Minimizar o ClipNova durante a gravação</label>' : ''}
    <div class="hint">A gravação começa após uma contagem de 3 segundos e é adicionada à linha do tempo quando você parar.</div>
    <div class="foot"><button data-x>Cancelar</button><button class="primary" data-go>${icon('record')} Iniciar gravação</button></div>`, { width: needScreen ? 620 : 480, onClose: () => stopPreview() });
  const q = (s) => m.el.querySelector(s);
  let srcId = sources[0]?.id || null;
  m.el.querySelectorAll('[data-src]').forEach((b) => {
    b.onclick = () => { srcId = b.dataset.src; m.el.querySelectorAll('[data-src]').forEach((x) => x.classList.toggle('on', x === b)); };
  });
  let prevStream = null;
  const stopPreview = () => { prevStream?.getTracks().forEach((x) => x.stop()); prevStream = null; };
  const startPreview = async () => {
    stopPreview();
    const id = q('[data-cam]')?.value;
    if (!id && !cams.length) return;
    prevStream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id } } : true }).catch(() => null);
    if (prevStream && q('[data-camprev]')) q('[data-camprev]').srcObject = prevStream;
  };
  if (needCam) { startPreview(); q('[data-cam]').onchange = startPreview; }
  q('[data-x]').onclick = () => m.close();
  q('[data-go]').onclick = async () => {
    const opts = {
      mode, srcId, camId: q('[data-cam]')?.value || null, micId: q('[data-mic]').value || null,
      sysAudio: !!q('[data-sys]')?.checked, minimize: !!q('[data-min]')?.checked,
    };
    if (needCam && !cams.length) { toast('Nenhuma câmera encontrada', true); return; }
    if (needScreen && !srcId) { toast('Nenhuma tela disponível para gravar', true); return; }
    m.close();
    start(opts).catch((e) => { cleanup(); toast('Falha ao iniciar a gravação: ' + e.message, true); });
  };
}

async function start(o) {
  const streams = [];
  const get = async (fn) => { const s = await fn(); streams.push(s); return s; };
  const mic = o.micId ? await get(() => navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: o.micId }, echoCancellation: true, noiseSuppression: true } })) : null;
  let screen = null, cam = null;
  if (o.mode !== 'camera') {
    await window.native.captureSelect(o.srcId, o.sysAudio);
    screen = await get(() => navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: o.sysAudio }));
  }
  if (o.mode !== 'screen') {
    cam = await get(() => navigator.mediaDevices.getUserMedia({ video: { deviceId: o.camId ? { exact: o.camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } }));
  }

  // mix microphone (+ system sound) into one audio track
  let actx = null;
  const mixed = (videoTrack, extra) => {
    const tracks = [videoTrack];
    const ins = [mic, extra].filter((s) => s && s.getAudioTracks().length);
    if (ins.length === 1) tracks.push(ins[0].getAudioTracks()[0]);
    else if (ins.length > 1) {
      actx ||= new AudioContext();
      const dest = actx.createMediaStreamDestination();
      for (const s of ins) actx.createMediaStreamSource(s).connect(dest);
      tracks.push(dest.stream.getAudioTracks()[0]);
    }
    return new MediaStream(tracks);
  };
  const jobs = [];
  const mime = pickMime();
  const rec = (stream, kind) => {
    const r = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: kind === 'screen' ? 12e6 : 6e6 });
    const chunks = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((res) => { r.onstop = () => res(new Blob(chunks, { type: 'video/webm' })); });
    jobs.push({ r, kind, done });
    return r;
  };
  if (screen) rec(mixed(screen.getVideoTracks()[0], screen), 'screen');
  if (cam) rec(o.mode === 'both' ? new MediaStream(cam.getVideoTracks()) : mixed(cam.getVideoTracks()[0]), 'camera');
  // with screen + camera the voice goes with the screen recording

  // countdown
  await countdown();
  const startT = S.t;
  for (const j of jobs) j.r.start(1000);
  const t0 = Date.now();
  active = { jobs, streams, actx, startT, mode: o.mode, t0, minimized: o.minimize, paused: false, pausedFor: 0 };
  showBar();
  for (const s of streams) for (const tr of s.getVideoTracks()) tr.onended = () => stop();
  if (o.minimize) setTimeout(() => window.native.winMinimize(), 300);
}

function countdown() {
  return new Promise((res) => {
    const el = document.createElement('div');
    el.className = 'countdown';
    document.body.append(el);
    let n = 3;
    const tick = () => {
      if (n === 0) { el.remove(); res(); return; }
      el.textContent = n--;
      el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
      setTimeout(tick, 1000);
    };
    tick();
  });
}

let bar = null, timer = 0;
function showBar() {
  bar = document.createElement('div');
  bar.className = 'rec-bar';
  bar.innerHTML = `<span class="rec-dot live"></span><span data-time data-noi18n>00:00</span><button data-pause>Pausar</button><button class="danger" data-stop>■ Parar</button>`;
  document.body.append(bar);
  bar.querySelector('[data-stop]').onclick = () => stop();
  bar.querySelector('[data-pause]').onclick = () => {
    if (!active) return;
    active.paused = !active.paused;
    for (const j of active.jobs) (active.paused ? j.r.pause() : j.r.resume());
    if (active.paused) active.pauseAt = Date.now(); else active.pausedFor += Date.now() - active.pauseAt;
    bar.querySelector('[data-pause]').textContent = t(active.paused ? 'Continuar' : 'Pausar');
    bar.querySelector('.rec-dot').classList.toggle('live', !active.paused);
  };
  timer = setInterval(() => {
    if (!active || active.paused) return;
    bar.querySelector('[data-time]').textContent = fmt((Date.now() - active.t0 - active.pausedFor) / 1000);
  }, 250);
}

function cleanup() {
  clearInterval(timer);
  bar?.remove(); bar = null;
  if (active) {
    for (const s of active.streams) s.getTracks().forEach((x) => x.stop());
    active.actx?.close();
  }
  active = null;
}

export async function stop() {
  if (!active || active.stopping) return;
  const a = active;
  a.stopping = true;
  for (const j of a.jobs) if (j.r.state !== 'inactive') j.r.stop();
  const blobs = await Promise.all(a.jobs.map((j) => j.done.then((b) => ({ kind: j.kind, blob: b }))));
  cleanup();
  if (a.minimized) window.native.winRestore();
  emit('busy', 'Processando gravação…');
  try {
    const files = {};
    for (const { kind, blob } of blobs) {
      if (!blob.size) continue;
      files[kind] = await window.native.saveRecording(S.project.id, new Uint8Array(await blob.arrayBuffer()), 'webm', kind);
    }
    const added = await importPaths(Object.values(files));
    const byPath = Object.fromEntries(added.map((m) => [m.path, m]));
    const scr = files.screen && byPath[files.screen], cm = files.camera && byPath[files.camera];
    const stamp = new Date().toLocaleTimeString();
    if (scr) scr.name = `${t('Gravação de tela')} ${stamp}`;
    if (cm) cm.name = `${t('Gravação da câmera')} ${stamp}`;
    if (scr && cm) {
      addMedia(scr, { time: a.startT });
      checkpoint();
      const c = makeMediaClip(cm);
      // round camera bubble in the lower-right corner: crop to a centred square, then size it
      const W = S.project.width, H = S.project.height;
      const side = Math.min(cm.width, cm.height);
      const cx = (1 - side / cm.width) / 2, cy = (1 - side / cm.height) / 2;
      c.crop = { l: cx, r: cx, t: cy, b: cy };
      const D = 0.28 * Math.min(W, H); // bubble diameter in project pixels
      c.scale = D / (side * Math.min(W / cm.width, H / cm.height));
      c.x = 0.5 - D / W / 2 - 0.02; c.y = 0.5 - D / H / 2 - 0.03;
      c.mask = { ...c.mask, type: 'circle', w: 1, h: 1, feather: 0.02 };
      c.muted = true;
      const mainClip = mainTrack().clips.find((x) => x.mediaId === scr.id);
      placeClip(c, mainClip ? mainClip.start : a.startT);
      S.sel = { kind: 'clip', id: c.id };
      changed('structure');
    } else if (scr || cm) {
      addMedia(scr || cm, { time: a.startT });
    }
    toast(added.length ? 'Gravação adicionada à linha do tempo' : 'A gravação ficou vazia');
  } catch (e) {
    toast('Falha ao salvar a gravação: ' + e.message, true);
  } finally { emit('busy', null); }
}
