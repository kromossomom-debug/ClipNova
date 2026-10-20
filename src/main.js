const { app, BrowserWindow, ipcMain, dialog, protocol, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const { spawn } = require('child_process');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg',
};

function ffmpegPath() {
  return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
}

const dataRoot = () => path.join(app.getPath('documents'), 'ClipNova');
const projectsDir = () => path.join(dataRoot(), 'projects');

async function serveFile(filePath, request) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return new Response('not found', { status: 404 }); }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (end >= stat.size) end = stat.size - 1;
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes' },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    headers: { 'Content-Type': type, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' },
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480, height: 900, minWidth: 1100, minHeight: 680,
    backgroundColor: '#0f1115', title: 'ClipNova', autoHideMenuBar: true, icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.loadURL('app://clipnova/index.html');
  // Automated UI test hook (dev only): CLIPNOVA_TEST_SCRIPT=path runs a script in the renderer.
  if (process.env.CLIPNOVA_TEST_SCRIPT) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
    win.webContents.on('did-finish-load', async () => {
      const code = await fsp.readFile(process.env.CLIPNOVA_TEST_SCRIPT, 'utf8');
      win.webContents.executeJavaScript(code).catch((err) => { console.log('[test] script error', err); app.exit(1); });
    });
    ipcMain.handle('test-shot', async (e, file) => { const img = await win.webContents.capturePage(); await fsp.writeFile(file, img.toPNG()); return true; });
    ipcMain.handle('test-quit', (e, code) => app.exit(code));
  }
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(async () => {
  await fsp.mkdir(projectsDir(), { recursive: true });
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/media/')) {
      return serveFile(decodeURIComponent(url.pathname.slice('/media/'.length)), request);
    }
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([\\/])+/, '');
    const full = path.join(__dirname, rel);
    if (!full.startsWith(__dirname)) return new Response('forbidden', { status: 403 });
    return serveFile(full, request);
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());

// ---------- Media / dialogs ----------
// Native dialog labels follow the language chosen in the renderer.
let uiLang = 'pt-BR';
const DIALOG_L10N = {
  'Áudio': { en: 'Audio', es: 'Audio', ru: 'Аудио' },
  'Mídia': { en: 'Media', es: 'Medios', ru: 'Медиа' },
  'Vídeo MP4': { en: 'MP4 video', es: 'Video MP4', ru: 'Видео MP4' },
};
const L = (s) => DIALOG_L10N[s]?.[uiLang] || s;
ipcMain.on('set-lang', (e, l) => { uiLang = l; });
ipcMain.handle('pick-media', async (e, kind) => {
  const filters = kind === 'audio'
    ? [{ name: L('Áudio'), extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'] }]
    : [{ name: L('Mídia'), extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }];
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile', 'multiSelections'], filters });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('file-exists', async (e, p) => { try { await fsp.access(p); return true; } catch { return false; } });

ipcMain.handle('save-recording', async (e, projectId, bytes, ext) => {
  const dir = path.join(projectsDir(), projectId, 'recordings');
  await fsp.mkdir(dir, { recursive: true });
  const raw = path.join(dir, `voz-${Date.now()}.${ext}`);
  await fsp.writeFile(raw, Buffer.from(bytes));
  // MediaRecorder WebM has no duration in its header and is mistaken for video;
  // remux to AAC/M4A so it imports as a normal audio file with a correct length.
  const out = raw.replace(/\.[^.]+$/, '.m4a');
  const r = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out], { collect: false });
  if (r.code !== 0) return raw;
  await fsp.rm(raw, { force: true }).catch(() => {});
  return out;
});

// ---------- Projects ----------
ipcMain.handle('list-projects', async () => {
  const out = [];
  for (const id of await fsp.readdir(projectsDir()).catch(() => [])) {
    try {
      const p = JSON.parse(await fsp.readFile(path.join(projectsDir(), id, 'project.json'), 'utf8'));
      let thumb = null;
      try { thumb = 'data:image/jpeg;base64,' + (await fsp.readFile(path.join(projectsDir(), id, 'thumb.jpg'))).toString('base64'); } catch {}
      out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, duration: p.duration || 0, ratio: p.ratio, thumb });
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
});

ipcMain.handle('load-project', async (e, id) => JSON.parse(await fsp.readFile(path.join(projectsDir(), id, 'project.json'), 'utf8')));

ipcMain.handle('save-project', async (e, project, thumbDataUrl) => {
  const dir = path.join(projectsDir(), project.id);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'project.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify(project));
  await fsp.rename(tmp, path.join(dir, 'project.json'));
  if (thumbDataUrl) await fsp.writeFile(path.join(dir, 'thumb.jpg'), Buffer.from(thumbDataUrl.split(',')[1], 'base64'));
  return true;
});

ipcMain.handle('delete-project', async (e, id) => {
  await shell.trashItem(path.join(projectsDir(), id)).catch(() => fsp.rm(path.join(projectsDir(), id), { recursive: true, force: true }));
  return true;
});

ipcMain.handle('rename-project', async (e, id, name) => {
  const f = path.join(projectsDir(), id, 'project.json');
  const p = JSON.parse(await fsp.readFile(f, 'utf8'));
  p.name = name;
  await fsp.writeFile(f, JSON.stringify(p));
  return true;
});

// ---------- Export ----------
let exportJob = null;

ipcMain.handle('pick-export-path', async (e, name) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: path.join(app.getPath('videos'), `${name}.mp4`),
    filters: [{ name: L('Vídeo MP4'), extensions: ['mp4'] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('export-start', async (e, opts) => {
  const { outPath, width, height, fps, crf, audioWav } = opts;
  const tmpDir = await fsp.mkdtemp(path.join(app.getPath('temp'), 'clipnova-'));
  const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'];
  let wavPath = null;
  if (audioWav) {
    wavPath = path.join(tmpDir, 'audio.wav');
    await fsp.writeFile(wavPath, Buffer.from(audioWav));
    args.push('-i', wavPath);
  }
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  if (wavPath) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  args.push(outPath);
  const proc = spawn(ffmpegPath(), args, { windowsHide: true });
  let log = '';
  proc.stderr.on('data', (d) => { log = (log + d.toString()).slice(-4000); });
  const done = new Promise((resolve) => proc.on('close', (code) => resolve(code)));
  exportJob = { proc, done, tmpDir, outPath, getLog: () => log };
  return true;
});

ipcMain.handle('export-frame', async (e, frame) => {
  if (!exportJob) throw new Error('nenhuma exportação ativa');
  const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (!exportJob.proc.stdin.write(buf)) await new Promise((r) => exportJob.proc.stdin.once('drain', r));
  return true;
});

ipcMain.handle('export-finish', async (e, cancel) => {
  if (!exportJob) return { ok: false, error: 'nenhuma exportação ativa' };
  const job = exportJob;
  exportJob = null;
  if (cancel) job.proc.kill();
  else job.proc.stdin.end();
  const code = await job.done;
  await fsp.rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
  if (cancel) { await fsp.rm(job.outPath, { force: true }).catch(() => {}); return { ok: false, canceled: true }; }
  return code === 0 ? { ok: true, path: job.outPath } : { ok: false, error: job.getLog() };
});

ipcMain.handle('show-in-folder', (e, p) => shell.showItemInFolder(p));

// ---------- FFmpeg helpers ----------
function runFfmpeg(args, { collect = true } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    const chunks = [];
    let err = '';
    if (collect) proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-20000); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr: err }));
  });
}

ipcMain.handle('probe-media', async (e, file) => {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', file]);
  const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 0;
  const hasAudio = /Stream #.*Audio:/.test(stderr);
  const vs = /Stream #.*Video: ([^,\s]+)/.exec(stderr);
  const isStill = vs && /^(png|mjpeg|bmp|webp|gif|tiff)$/.test(vs[1]) && duration <= 0.05;
  return { duration, hasAudio, hasVideo: !!vs, isStill };
});

// Filmstrip: n frames sampled evenly over the whole video, each tile keeping the video's aspect ratio.
ipcMain.handle('video-strip', async (e, file, duration, aspect) => {
  const n = Math.max(8, Math.min(300, Math.round(duration * 1.5)));
  const th = 72;
  const tw = Math.max(32, Math.min(200, Math.round((th * (aspect || 16 / 9)) / 2) * 2));
  const rate = n / Math.max(duration, 0.1);
  const { code, stdout } = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', file, '-an',
    '-vf', `fps=${rate.toFixed(6)},scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},tile=${n}x1`,
    '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1']);
  if (code !== 0 || !stdout.length) return null;
  return { url: 'data:image/jpeg;base64,' + stdout.toString('base64'), n, w: tw, h: th };
});

ipcMain.handle('decode-audio', async (e, file, rate, channels) => {
  const { code, stdout } = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', file, '-vn',
    '-ac', String(channels), '-ar', String(rate), '-f', 'f32le', 'pipe:1']);
  if (code !== 0) return null;
  return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength);
});

ipcMain.handle('reverse-media', async (e, projectId, file, start, end, hasAudio) => {
  const dir = path.join(projectsDir(), projectId, 'generated');
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `reverso-${Date.now()}.mp4`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-to', String(end), '-i', file, '-vf', 'reverse'];
  if (hasAudio) args.push('-af', 'areverse', '-c:a', 'aac', '-b:a', '192k'); else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', out);
  const r = await runFfmpeg(args, { collect: false });
  if (r.code !== 0) throw new Error(r.stderr.slice(-500));
  return out;
});

ipcMain.handle('extract-frame', async (e, projectId, file, time) => {
  const dir = path.join(projectsDir(), projectId, 'generated');
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `quadro-${Date.now()}.png`);
  const r = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(time), '-i', file, '-frames:v', '1', out], { collect: false });
  if (r.code !== 0) throw new Error(r.stderr.slice(-500));
  return out;
});

// Sequential frame decoders used by export (frame-accurate, no seeking in the renderer).
const decoders = new Map();

ipcMain.handle('decoder-open', (e, id, o) => {
  const frameSize = o.width * o.height * 4;
  const vf = `setpts=(PTS-STARTPTS)/${o.speed},fps=${o.fps},scale=${o.width}:${o.height}:flags=bicubic`;
  const proc = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', String(o.start), '-t', String(o.length),
    '-i', o.path, '-an', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true });
  const d = { proc, frameSize, bufs: [], size: 0, ended: false, waiters: [] };
  const wake = () => { const w = d.waiters.splice(0); w.forEach((f) => f()); };
  proc.stdout.on('data', (chunk) => {
    d.bufs.push(chunk); d.size += chunk.length;
    if (d.size > frameSize * 3) proc.stdout.pause();
    wake();
  });
  proc.stdout.on('end', () => { d.ended = true; wake(); });
  proc.on('error', () => { d.ended = true; wake(); });
  decoders.set(id, d);
  return true;
});

ipcMain.handle('decoder-read', async (e, id) => {
  const d = decoders.get(id);
  if (!d) return null;
  while (d.size < d.frameSize && !d.ended) {
    d.proc.stdout.resume();
    await new Promise((r) => d.waiters.push(r));
  }
  if (d.size < d.frameSize) return null;
  const all = d.bufs.length === 1 ? d.bufs[0] : Buffer.concat(d.bufs);
  const frame = Buffer.from(all.subarray(0, d.frameSize));
  const rest = all.subarray(d.frameSize);
  d.bufs = rest.length ? [rest] : []; d.size = rest.length;
  if (d.size < d.frameSize * 3) d.proc.stdout.resume();
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
});

// ---------- AI (Google Gemini, user's own API key) ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
async function readSettings() { try { return JSON.parse(await fsp.readFile(settingsFile(), 'utf8')); } catch { return {}; } }
async function writeSettings(s) { await fsp.writeFile(settingsFile(), JSON.stringify(s, null, 2)); }

async function getApiKey() {
  const s = await readSettings();
  if (!s.geminiKey) return null;
  const buf = Buffer.from(s.geminiKey, 'base64');
  return s.keyEncrypted ? safeStorage.decryptString(buf) : buf.toString('utf8');
}

const AI_DEFAULTS = { captionModel: 'gemini-3.8-flash', textModel: 'gemini-3.8-flash', ttsModel: 'gemini-3.8-flash-tts' };

ipcMain.handle('ai-settings-get', async () => {
  const s = await readSettings();
  const key = await getApiKey().catch(() => null);
  return {
    hasKey: !!key, keyHint: key ? '••••' + key.slice(-4) : '',
    captionModel: s.captionModel || AI_DEFAULTS.captionModel,
    textModel: s.textModel || AI_DEFAULTS.textModel,
    ttsModel: s.ttsModel || AI_DEFAULTS.ttsModel,
  };
});

ipcMain.handle('ai-settings-set', async (e, upd) => {
  const s = await readSettings();
  if (upd.apiKey !== undefined) {
    if (!upd.apiKey) { delete s.geminiKey; delete s.keyEncrypted; }
    else if (safeStorage.isEncryptionAvailable()) { s.geminiKey = safeStorage.encryptString(upd.apiKey.trim()).toString('base64'); s.keyEncrypted = true; }
    else { s.geminiKey = Buffer.from(upd.apiKey.trim()).toString('base64'); s.keyEncrypted = false; }
  }
  for (const k of ['captionModel', 'textModel', 'ttsModel']) if (upd[k]) s[k] = upd[k];
  await writeSettings(s);
  return true;
});

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

async function geminiFetch(url, init = {}, keyOverride) {
  const key = keyOverride || (await getApiKey());
  if (!key) throw new Error('Configure sua chave da API do Gemini em IA › Configurações.');
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', 'x-goog-api-key': key, ...(init.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Erro HTTP ${res.status} da API do Gemini`);
  return j;
}

const modelPath = (m) => (m.startsWith('models/') ? m : `models/${m}`);

async function generate(model, body) {
  const j = await geminiFetch(`${GEMINI}/${modelPath(model)}:generateContent`, { method: 'POST', body: JSON.stringify(body) });
  const cand = j.candidates?.[0];
  if (!cand) throw new Error(j.promptFeedback?.blockReason ? `Bloqueado pela API: ${j.promptFeedback.blockReason}` : 'A API não retornou resposta.');
  return cand;
}

const candText = (cand) => (cand.content?.parts || []).map((p) => p.text || '').join('');

ipcMain.handle('ai-list-models', async (e, keyOverride) => {
  const out = [];
  let token = '';
  do {
    const j = await geminiFetch(`${GEMINI}/models?pageSize=1000${token ? '&pageToken=' + token : ''}`, {}, keyOverride);
    for (const m of j.models || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) out.push({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name });
    }
    token = j.nextPageToken || '';
  } while (token);
  return out;
});

function sendProgress(e, data) { try { e.sender.send('ai-progress', data); } catch {} }

ipcMain.handle('ai-transcribe', async (e, wav, opts) => {
  const s = await readSettings();
  const model = opts.model || s.captionModel || AI_DEFAULTS.captionModel;
  const tmp = await fsp.mkdtemp(path.join(app.getPath('temp'), 'clipnova-ai-'));
  try {
    const inWav = path.join(tmp, 'in.wav');
    await fsp.writeFile(inWav, Buffer.from(wav));
    const CHUNK = 240;
    const r = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', inWav, '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k',
      '-f', 'segment', '-segment_time', String(CHUNK), '-reset_timestamps', '1', path.join(tmp, 'chunk%03d.mp3')], { collect: false });
    if (r.code !== 0) throw new Error('Falha ao preparar o áudio: ' + r.stderr.slice(-300));
    const chunks = (await fsp.readdir(tmp)).filter((f) => f.startsWith('chunk')).sort();
    const segments = [];
    const lang = opts.language && opts.language !== 'auto' ? `no idioma "${opts.language}" (traduza se a fala estiver em outro idioma)` : 'exatamente no idioma original falado';
    for (let i = 0; i < chunks.length; i++) {
      sendProgress(e, { step: i, total: chunks.length });
      const isLast = i === chunks.length - 1;
      const chunkDur = isLast ? Math.max(0.1, opts.duration - i * CHUNK) : CHUNK;
      const data = (await fsp.readFile(path.join(tmp, chunks[i]))).toString('base64');
      const prompt = `Você é um legendador profissional. Transcreva fielmente TODA a fala deste áudio ${lang}.
Divida a transcrição em legendas curtas de no máximo ${opts.maxWords || 7} palavras, respeitando pausas naturais e o ritmo da fala.
Para cada legenda informe "start" e "end" em segundos (com decimais), relativos ao início deste trecho de áudio, que dura ${chunkDur.toFixed(1)} segundos.
Os tempos devem acompanhar com precisão quando cada palavra é dita, ser crescentes e não se sobrepor.
Use pontuação correta. Não descreva sons, música ou ruídos. Se não houver fala, retorne "segments": [].`;
      const cand = await generate(model, {
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/mp3', data } }, { text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { segments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { start: { type: 'NUMBER' }, end: { type: 'NUMBER' }, text: { type: 'STRING' } }, required: ['start', 'end', 'text'] } } },
            required: ['segments'],
          },
        },
      });
      let parsed;
      try { parsed = JSON.parse(candText(cand)); } catch { throw new Error('A IA retornou um formato inesperado. Tente outro modelo.'); }
      for (const sg of parsed.segments || []) {
        const st = Math.max(0, Math.min(chunkDur, +sg.start || 0)), en = Math.max(st + 0.2, Math.min(chunkDur, +sg.end || st + 1));
        const text = String(sg.text || '').trim();
        if (text) segments.push({ start: i * CHUNK + st, end: i * CHUNK + en, text });
      }
    }
    sendProgress(e, { step: chunks.length, total: chunks.length });
    return segments;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

ipcMain.handle('ai-translate', async (e, texts, target) => {
  const s = await readSettings();
  const model = s.textModel || AI_DEFAULTS.textModel;
  const out = [];
  for (let i = 0; i < texts.length; i += 80) {
    sendProgress(e, { step: i, total: texts.length });
    const batch = texts.slice(i, i + 80);
    const cand = await generate(model, {
      contents: [{ role: 'user', parts: [{ text: `Traduza cada legenda abaixo para ${target}. Mantenha o tom natural de legenda, curto e falado. Retorne um array JSON com exatamente ${batch.length} strings, na mesma ordem.\n\n${JSON.stringify(batch)}` }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: { type: 'ARRAY', items: { type: 'STRING' } } },
    });
    let arr;
    try { arr = JSON.parse(candText(cand)); } catch { throw new Error('A IA retornou um formato inesperado.'); }
    for (let k = 0; k < batch.length; k++) out.push(typeof arr[k] === 'string' ? arr[k] : batch[k]);
  }
  return out;
});

function pcmToWav(pcm, rate, channels = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

ipcMain.handle('ai-tts', async (e, projectId, text, voice, style) => {
  const s = await readSettings();
  const model = s.ttsModel || AI_DEFAULTS.ttsModel;
  const cand = await generate(model, {
    contents: [{ role: 'user', parts: [{ text: style ? `${style}:\n${text}` : text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } } },
  });
  const part = (cand.content?.parts || []).find((p) => p.inlineData);
  if (!part) throw new Error('O modelo não retornou áudio. Verifique se o modelo de voz selecionado suporta fala (TTS).');
  const mime = part.inlineData.mimeType || '';
  const raw = Buffer.from(part.inlineData.data, 'base64');
  const dir = path.join(projectsDir(), projectId, 'generated');
  await fsp.mkdir(dir, { recursive: true });
  let file;
  if (/wav/.test(mime)) { file = path.join(dir, `narracao-ia-${Date.now()}.wav`); await fsp.writeFile(file, raw); }
  else if (/mpeg|mp3/.test(mime)) { file = path.join(dir, `narracao-ia-${Date.now()}.mp3`); await fsp.writeFile(file, raw); }
  else {
    const rate = +(/rate=(\d+)/.exec(mime)?.[1] || 24000);
    file = path.join(dir, `narracao-ia-${Date.now()}.wav`);
    await fsp.writeFile(file, pcmToWav(raw, rate));
  }
  return file;
});

// ---------- Smart tools (local, FFmpeg) ----------
ipcMain.handle('detect-silence', async (e, file, start, end, noiseDb, minDur) => {
  const { stderr } = await runFfmpeg(['-hide_banner', '-ss', String(start), '-to', String(end), '-i', file, '-vn',
    '-af', `silencedetect=n=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-'], { collect: false });
  const out = [];
  let cur = null;
  for (const line of stderr.split('\n')) {
    const a = /silence_start: (-?[\d.]+)/.exec(line);
    const b = /silence_end: (-?[\d.]+)/.exec(line);
    if (a) cur = Math.max(0, +a[1]);
    if (b && cur != null) { out.push([start + cur, start + +b[1]]); cur = null; }
  }
  if (cur != null) out.push([start + cur, end]);
  return out;
});

ipcMain.handle('detect-scenes', async (e, file, start, end, threshold) => {
  const r = await new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-ss', String(start), '-to', String(end), '-i', file, '-an',
      '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', () => resolve(err));
  });
  const cuts = [];
  for (const m of r.matchAll(/pts_time:([\d.]+)/g)) cuts.push(start + +m[1]);
  return cuts;
});

ipcMain.handle('enhance-audio', async (e, projectId, file, isVideo) => {
  const dir = path.join(projectsDir(), projectId, 'generated');
  await fsp.mkdir(dir, { recursive: true });
  const chain = 'highpass=f=80,lowpass=f=13000,afftdn=nf=-25:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11';
  const ext = path.extname(file).toLowerCase();
  let out, args;
  if (isVideo) {
    out = path.join(dir, `voz-melhorada-${Date.now()}.mp4`);
    const copy = ['.mp4', '.mov', '.m4v'].includes(ext);
    args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-af', chain,
      ...(copy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p']),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out];
  } else {
    out = path.join(dir, `voz-melhorada-${Date.now()}.m4a`);
    args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-af', chain, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out];
  }
  const r = await runFfmpeg(args, { collect: false });
  if (r.code !== 0) throw new Error(r.stderr.slice(-400));
  return out;
});

ipcMain.handle('save-text-file', async (e, name, content, ext) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: path.join(app.getPath('documents'), `${name}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled) return null;
  await fsp.writeFile(r.filePath, content, 'utf8');
  return r.filePath;
});

ipcMain.handle('open-text-file', async (e, ext) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled) return null;
  return fsp.readFile(r.filePaths[0], 'utf8');
});

ipcMain.handle('decoder-close', (e, id) => {
  const d = decoders.get(id);
  if (d) { d.proc.kill(); decoders.delete(id); }
  return true;
});
