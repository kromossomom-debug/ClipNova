// Built-in music beds and sound effects, synthesized with WebAudio (original material, no samples).
// Each sound is rendered once with an OfflineAudioContext, cached on disk by the main process and
// imported like any other audio file.

const RATE = 44100;
const VERSION = 'v2'; // bump to re-render cached files after changing a recipe

export const MUSIC = [
  { id: 'lofi', name: 'Lo-fi tranquilo', mood: 'Calmo · 80 BPM', dur: 60 },
  { id: 'pop', name: 'Energia pop', mood: 'Animado · 118 BPM', dur: 60 },
  { id: 'corporate', name: 'Corporativo inspirador', mood: 'Positivo · 100 BPM', dur: 60 },
  { id: 'electro', name: 'Batida eletrônica', mood: 'Intenso · 126 BPM', dur: 60 },
  { id: 'cinematic', name: 'Trailer épico', mood: 'Dramático · 70 BPM', dur: 60 },
  { id: 'ambient', name: 'Ambiente suave', mood: 'Relaxante · sem bateria', dur: 60 },
];

export const SFX = [
  { id: 'whoosh', name: 'Whoosh', dur: 0.9 }, { id: 'riser', name: 'Subida (riser)', dur: 2.6 },
  { id: 'impact', name: 'Impacto', dur: 1.6 }, { id: 'pop', name: 'Pop', dur: 0.25 },
  { id: 'ding', name: 'Ding', dur: 1.4 }, { id: 'click', name: 'Clique', dur: 0.1 },
  { id: 'beep', name: 'Bipe', dur: 0.3 }, { id: 'success', name: 'Sucesso', dur: 0.9 },
  { id: 'error', name: 'Erro', dur: 0.5 }, { id: 'coin', name: 'Moeda', dur: 0.5 },
  { id: 'notify', name: 'Notificação', dur: 0.6 }, { id: 'drumroll', name: 'Rufar de tambor', dur: 2.2 },
  { id: 'shutter', name: 'Câmera', dur: 0.35 }, { id: 'typing', name: 'Digitação', dur: 2 },
  { id: 'swoosh-down', name: 'Queda', dur: 1.2 }, { id: 'tada', name: 'Tcharam!', dur: 1.8 },
];

export const assetName = (kind, id) => `${kind}-${id}-${VERSION}`;

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const QUAL = { maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], add9: [0, 4, 7, 14], sus2: [0, 2, 7] };
// "Am7" -> midi notes around octave 4
function chord(name, oct = 4) {
  const m = /^([A-G][#b]?)(.*)$/.exec(name);
  const q = { '': 'maj', m: 'min', maj7: 'maj7', m7: 'm7', add9: 'add9', sus2: 'sus2' }[m[2]] || 'maj';
  const root = 12 * (oct + 1) + NOTE[m[1]];
  return { root, notes: QUAL[q].map((x) => root + x) };
}

class Synth {
  constructor(dur) {
    this.ctx = new OfflineAudioContext(2, Math.ceil(dur * RATE), RATE);
    this.dur = dur;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
    this.master = this.ctx.createGain();
    this.master.connect(comp).connect(this.ctx.destination);
    const n = RATE * 2;
    this.noiseBuf = this.ctx.createBuffer(1, n, RATE);
    const d = this.noiseBuf.getChannelData(0);
    let seed = 1234567;
    for (let i = 0; i < n; i++) { seed = (seed * 16807) % 2147483647; d[i] = (seed / 2147483647) * 2 - 1; }
  }

  bus(gain = 1, pan = 0) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    if (pan) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(this.master); } else g.connect(this.master);
    return g;
  }

  env(g, t, dur, peak, attack = 0.005, release = null) {
    const rel = release ?? dur;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + rel);
  }

  tone(t, dur, freq, { type = 'sine', gain = 0.3, attack = 0.005, freqEnd = null, dest = this.master, detune = 0, sustain = false } = {}) {
    const o = this.ctx.createOscillator();
    o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = this.ctx.createGain();
    if (sustain) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + attack);
      g.gain.setValueAtTime(gain, t + Math.max(attack, dur - 0.08));
      g.gain.linearRampToValueAtTime(0, t + dur);
    } else this.env(g, t, dur, gain, attack, dur - attack);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  noise(t, dur, { gain = 0.3, type = 'bandpass', freq = 1000, freqEnd = null, q = 1, attack = 0.003, dest = this.master, curve = null } = {}) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = this.ctx.createGain();
    if (curve) g.gain.setValueCurveAtTime(curve.map((v) => v * gain), t, dur);
    else this.env(g, t, dur, gain, attack, dur - attack);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  kick(t, gain = 0.9, dest) { this.tone(t, 0.32, 150, { freqEnd: 42, gain, dest }); }
  snare(t, gain = 0.35, dest) { this.noise(t, 0.18, { gain, type: 'bandpass', freq: 1900, q: 0.8, dest }); this.tone(t, 0.1, 190, { gain: gain * 0.6, dest }); }
  clap(t, gain = 0.3, dest) { for (let i = 0; i < 3; i++) this.noise(t + i * 0.012, 0.12, { gain, type: 'bandpass', freq: 1300, q: 1.2, dest }); }
  hat(t, gain = 0.08, open = false, dest) { this.noise(t, open ? 0.22 : 0.05, { gain, type: 'highpass', freq: 7500, q: 0.7, dest }); }

  // sustained chord through a low-pass filter
  pad(t, dur, notes, { type = 'sawtooth', gain = 0.05, cutoff = 1400, attack = 0.4, dest = this.master } = {}) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = 0.5;
    f.connect(dest);
    for (const n of notes) for (const dt of [-7, 7]) this.tone(t, dur, midi(n), { type, gain, attack, detune: dt, dest: f, sustain: true });
  }

  async render() {
    const buf = await this.ctx.startRendering();
    // gentle fade at both ends so loops and cuts never click
    const fade = Math.min(buf.length / 4, RATE * (this.dur > 10 ? 2.5 : 0.01));
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < 64 && i < d.length; i++) d[i] *= i / 64;
      for (let i = 0; i < fade; i++) d[d.length - 1 - i] *= i / fade;
    }
    return buf;
  }
}

// ---------- music ----------
function band(s, { bpm, prog, beats, beatsPerChord = 4, drums = 'four', bass = 'root', padType = 'sawtooth', padGain = 0.04, cutoff = 1500, arp = null, swing = 0, keys = false }) {
  const beat = 60 / bpm;
  const bars = beats;
  const padBus = s.bus(1), drumBus = s.bus(1), bassBus = s.bus(1), arpBus = s.bus(0.9, 0.25);
  const chords = prog.map((c) => chord(c));
  for (let b = 0; b < bars; b++) {
    const t = b * beat;
    const ci = Math.floor(b / beatsPerChord) % chords.length;
    const ch = chords[ci];
    const inBar = b % 4;
    if (b % beatsPerChord === 0) s.pad(t, beat * beatsPerChord, ch.notes, { type: padType, gain: padGain, cutoff, dest: padBus });
    // drums
    if (drums === 'four') {
      s.kick(t, 0.8, drumBus);
      if (inBar % 2 === 1) s.clap(t, 0.25, drumBus);
      s.hat(t + beat / 2, 0.07, true, drumBus);
      s.hat(t, 0.04, false, drumBus);
    } else if (drums === 'pop') {
      if (inBar === 0 || inBar === 2) s.kick(t, 0.85, drumBus);
      if (inBar === 2) s.kick(t + beat / 2, 0.6, drumBus);
      if (inBar % 2 === 1) s.snare(t, 0.32, drumBus);
      s.hat(t, 0.06, false, drumBus); s.hat(t + beat / 2, 0.05, false, drumBus);
    } else if (drums === 'lofi') {
      if (inBar === 0) s.kick(t, 0.7, drumBus);
      if (inBar === 2) s.kick(t + beat / 2, 0.6, drumBus);
      if (inBar % 2 === 1) s.snare(t, 0.2, drumBus);
      s.hat(t, 0.035, false, drumBus); s.hat(t + beat * (0.5 + swing), 0.03, false, drumBus);
    } else if (drums === 'soft') {
      if (inBar === 0 || inBar === 2) s.kick(t, 0.55, drumBus);
      if (inBar % 2 === 1) s.clap(t, 0.15, drumBus);
      s.hat(t + beat / 2, 0.035, false, drumBus);
    } else if (drums === 'epic') {
      if (inBar === 0) { s.kick(t, 1, drumBus); s.noise(t, 1.2, { gain: 0.08, type: 'lowpass', freq: 400, dest: drumBus }); }
      if (inBar === 3) { s.tone(t, 0.4, 110, { freqEnd: 70, gain: 0.5, dest: drumBus }); s.tone(t + beat / 2, 0.4, 98, { freqEnd: 60, gain: 0.5, dest: drumBus }); }
    }
    // bass
    const root = midi(ch.root - 24);
    if (bass === 'root') s.tone(t, beat * 0.9, root, { type: 'triangle', gain: 0.28, dest: bassBus, sustain: true, attack: 0.01 });
    else if (bass === 'offbeat') s.tone(t + beat / 2, beat * 0.45, root, { type: 'sawtooth', gain: 0.13, dest: bassBus, sustain: true, attack: 0.005 });
    else if (bass === 'long' && b % beatsPerChord === 0) s.tone(t, beat * beatsPerChord, root, { type: 'sine', gain: 0.3, dest: bassBus, sustain: true, attack: 0.2 });
    // arpeggio / keys
    if (arp) {
      const steps = arp.steps;
      for (let k = 0; k < steps; k++) {
        const n = ch.notes[(b * steps + k) % ch.notes.length] + 12 * (arp.oct || 0);
        s.tone(t + (k * beat) / steps, (beat / steps) * 0.9, midi(n), { type: arp.type, gain: arp.gain, dest: arpBus });
      }
    }
    if (keys && b % 2 === 0) for (const n of ch.notes) s.tone(t, beat * 1.8, midi(n + 12), { type: 'triangle', gain: 0.05, dest: arpBus });
  }
}

// One chord cycle is synthesized and then repeated to the full length (much faster than rendering every bar).
const RECIPES = {
  lofi: {
    bpm: 80, prog: ['Fmaj7', 'Em7', 'Dm7', 'Cmaj7'], drums: 'lofi', bass: 'root', padType: 'triangle', padGain: 0.07, cutoff: 1100, swing: 0.12, keys: true,
    extra: (s, len) => s.noise(0, len, { gain: 0.012, type: 'lowpass', freq: 3000, curve: new Float32Array([1, 1]) }),
  },
  pop: { bpm: 118, prog: ['C', 'G', 'Am', 'F'], drums: 'pop', bass: 'root', padGain: 0.035, cutoff: 2200, arp: { steps: 4, type: 'square', gain: 0.025, oct: 1 } },
  corporate: { bpm: 100, prog: ['Cadd9', 'Am7', 'Fmaj7', 'Gsus2'], drums: 'soft', bass: 'root', padType: 'triangle', padGain: 0.05, cutoff: 1800, arp: { steps: 2, type: 'triangle', gain: 0.07, oct: 1 } },
  electro: { bpm: 126, prog: ['Am', 'F', 'C', 'G'], drums: 'four', bass: 'offbeat', padGain: 0.03, cutoff: 2600, arp: { steps: 4, type: 'sawtooth', gain: 0.02, oct: 1 } },
  cinematic: { bpm: 70, prog: ['Dm', 'Bb', 'F', 'C'], drums: 'epic', bass: 'long', padGain: 0.05, cutoff: 900 },
  ambient: {
    bpm: 60, prog: ['Am7', 'Fmaj7', 'Cmaj7', 'Gsus2'], beatsPerChord: 8, drums: 'none', bass: 'long', padType: 'sine', padGain: 0.07, cutoff: 2000,
    extra: (s, len) => { for (let t = 1; t < len - 1; t += 2.3) s.tone(t, 2.2, midi(76 + [0, 3, 7, 10, 12][Math.floor(t * 7) % 5]), { type: 'sine', gain: 0.025, attack: 0.3 }); },
  },
};

async function renderMusic(meta) {
  const cfg = RECIPES[meta.id];
  const beats = (cfg.beatsPerChord || 4) * cfg.prog.length;
  const cycle = (beats * 60) / cfg.bpm;
  const s = new Synth(cycle + 2.5); // the tail (reverb-ish releases) overlaps the next repetition
  band(s, { ...cfg, beats });
  cfg.extra?.(s, cycle);
  const loop = await s.ctx.startRendering();
  const len = Math.ceil(meta.dur * RATE), step = Math.round(cycle * RATE);
  const out = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: RATE });
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const o = out.getChannelData(ch), l = loop.getChannelData(ch);
    for (let off = 0; off < len; off += step) {
      const n = Math.min(l.length, len - off);
      for (let i = 0; i < n; i++) o[off + i] += l[i];
    }
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(o[i]));
  }
  const norm = peak > 0.97 ? 0.97 / peak : 1;
  const fade = RATE * 2.5;
  for (let ch = 0; ch < 2; ch++) {
    const o = out.getChannelData(ch);
    for (let i = 0; i < len; i++) o[i] *= norm;
    for (let i = 0; i < 64; i++) o[i] *= i / 64;
    for (let i = 0; i < fade; i++) o[len - 1 - i] *= i / fade;
  }
  return out;
}

const SFX_RECIPES = {
  whoosh: (s) => s.noise(0, 0.85, { gain: 0.5, type: 'bandpass', freq: 300, freqEnd: 3500, q: 1.5, curve: new Float32Array([0, 0.3, 1, 0.6, 0]) }),
  'swoosh-down': (s) => { s.noise(0, 1.1, { gain: 0.45, type: 'bandpass', freq: 4000, freqEnd: 200, q: 1.5, curve: new Float32Array([0, 1, 0.6, 0.2, 0]) }); s.tone(0, 1.1, 900, { freqEnd: 90, gain: 0.12, type: 'triangle' }); },
  riser: (s) => { s.noise(0, 2.5, { gain: 0.35, type: 'bandpass', freq: 200, freqEnd: 7000, q: 2, curve: new Float32Array([0, 0.2, 0.5, 1, 0]) }); s.tone(0, 2.5, 110, { freqEnd: 880, type: 'sawtooth', gain: 0.06, attack: 1.5 }); },
  impact: (s) => { s.tone(0, 1.4, 90, { freqEnd: 30, gain: 1 }); s.noise(0, 1.2, { gain: 0.35, type: 'lowpass', freq: 1500, freqEnd: 100 }); },
  pop: (s) => s.tone(0, 0.12, 700, { freqEnd: 180, gain: 0.7 }),
  ding: (s) => { s.tone(0, 1.3, 1318.5, { gain: 0.35 }); s.tone(0, 0.9, 2637, { gain: 0.12 }); s.tone(0, 0.6, 3951, { gain: 0.05 }); },
  click: (s) => s.noise(0, 0.03, { gain: 0.6, type: 'highpass', freq: 3000 }),
  beep: (s) => s.tone(0, 0.22, 1000, { type: 'square', gain: 0.15, sustain: true, attack: 0.005 }),
  success: (s) => [72, 76, 79, 84].forEach((n, i) => s.tone(i * 0.1, 0.45, midi(n), { type: 'triangle', gain: 0.3 })),
  error: (s) => { s.tone(0, 0.18, 233, { type: 'square', gain: 0.15, sustain: true }); s.tone(0.2, 0.25, 185, { type: 'square', gain: 0.15, sustain: true }); },
  coin: (s) => { s.tone(0, 0.08, 988, { type: 'square', gain: 0.15, sustain: true }); s.tone(0.08, 0.35, 1319, { type: 'square', gain: 0.15 }); },
  notify: (s) => { s.tone(0, 0.25, 880, { gain: 0.35 }); s.tone(0.14, 0.4, 1174.7, { gain: 0.35 }); },
  drumroll: (s) => {
    let t = 0;
    for (let i = 0; t < 1.6; i++) { s.snare(t, 0.12 + t * 0.12); t += Math.max(0.035, 0.09 - i * 0.003); }
    s.snare(1.7, 0.5); s.kick(1.7, 0.9); s.noise(1.7, 0.5, { gain: 0.2, type: 'highpass', freq: 5000 });
  },
  shutter: (s) => { s.noise(0, 0.04, { gain: 0.6, type: 'bandpass', freq: 2500 }); s.noise(0.12, 0.06, { gain: 0.5, type: 'bandpass', freq: 1800 }); },
  typing: (s) => {
    let t = 0.02, seed = 7;
    while (t < 1.9) { seed = (seed * 9301 + 49297) % 233280; const r = seed / 233280; s.noise(t, 0.025, { gain: 0.35 + r * 0.2, type: 'bandpass', freq: 2500 + r * 2000, q: 2 }); t += 0.07 + r * 0.12; }
  },
  tada: (s) => {
    s.tone(0, 0.15, midi(67), { type: 'sawtooth', gain: 0.1, sustain: true });
    for (const n of [72, 76, 79]) s.pad(0.15, 1.5, [n], { type: 'sawtooth', gain: 0.06, cutoff: 3000, attack: 0.02 });
    s.clap(0.15, 0.3);
  },
};

export async function renderSound(kind, id) {
  const meta = (kind === 'music' ? MUSIC : SFX).find((x) => x.id === id);
  if (kind === 'music') return renderMusic(meta);
  const s = new Synth(meta.dur);
  SFX_RECIPES[id](s);
  return s.render();
}

// Cached, imported-ready file path for a library sound.
const memo = new Map();
export async function soundFile(kind, id, encodeWav) {
  const name = assetName(kind, id);
  const hit = await window.native.libraryAsset(name);
  if (hit) return hit;
  if (!memo.has(name)) memo.set(name, (async () => {
    const buf = await renderSound(kind, id);
    return window.native.saveLibraryAsset(name, encodeWav(buf));
  })());
  return memo.get(name);
}

// Quick preview through the speakers (renders on first use).
let previewCtx = null, previewNode = null;
const bufMemo = new Map();
export async function previewSound(kind, id, onEnd) {
  stopPreview();
  previewCtx ||= new AudioContext();
  const key = `${kind}:${id}`;
  if (!bufMemo.has(key)) bufMemo.set(key, await renderSound(kind, id));
  const src = previewCtx.createBufferSource();
  src.buffer = bufMemo.get(key);
  src.connect(previewCtx.destination);
  src.onended = () => { if (previewNode === src) previewNode = null; onEnd?.(); };
  src.start();
  previewNode = src;
}
export function stopPreview() { if (previewNode) { try { previewNode.stop(); } catch {} previewNode = null; } }
export const isPreviewing = () => !!previewNode;
