// BOOP audio engine: every sound is synthesized live with the Web Audio API.
// No samples, no audio files. Music is a lookahead step sequencer whose
// tempo, key and arrangement escalate with the game's level.

const A2 = 110;
const semis = (f, n) => f * Math.pow(2, n / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = (this.ctx = new AC({ latencyHint: 'interactive' }));

    this.master = c.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master.connect(comp);
    comp.connect(c.destination);

    // Music bus runs through a filter so misses can "duck" the whole track.
    this.musicFilter = c.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 18000;
    this.musicFilter.Q.value = 0.8;
    this.musicBus = c.createGain();
    this.musicBus.gain.value = 0.5;
    this.musicBus.connect(this.musicFilter);
    this.musicFilter.connect(this.master);

    this.sfxBus = c.createGain();
    this.sfxBus.gain.value = 0.8;
    this.sfxBus.connect(this.master);

    // Shared noise buffer for drums, risers and whooshes.
    const len = c.sampleRate;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Short feedback delay for the lead and UI sparkle.
    this.delay = c.createDelay(1);
    this.delay.delayTime.value = 0.18;
    const fb = c.createGain();
    fb.gain.value = 0.32;
    const wet = c.createGain();
    wet.gain.value = 0.35;
    this.delay.connect(fb);
    fb.connect(this.delay);
    this.delay.connect(wet);
    wet.connect(this.master);
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') return this.ctx.resume();
    return Promise.resolve();
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.now, 0.02);
  }

  // ---------- primitives ----------

  env(g, t, vol, attack, dur) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  tone({ type = 'sine', f = 440, f2, t = this.now, dur = 0.2, vol = 0.3, attack = 0.004, bus, cutoff, q = 1, send = 0, detune = 0 }) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    let node = o;
    if (cutoff) {
      const fl = c.createBiquadFilter();
      fl.type = 'lowpass';
      fl.frequency.value = cutoff;
      fl.Q.value = q;
      o.connect(fl);
      node = fl;
    }
    node.connect(g);
    g.connect(bus || this.sfxBus);
    if (send) {
      const s = c.createGain();
      s.gain.value = send;
      g.connect(s);
      s.connect(this.delay);
    }
    this.env(g, t, vol, attack, dur);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  noise({ t = this.now, dur = 0.1, vol = 0.3, type = 'highpass', freq = 6000, freq2, q = 1, bus, attack = 0.002 }) {
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const fl = c.createBiquadFilter();
    fl.type = type;
    fl.frequency.setValueAtTime(freq, t);
    if (freq2) fl.frequency.exponentialRampToValueAtTime(freq2, t + dur);
    fl.Q.value = q;
    const g = c.createGain();
    s.connect(fl);
    fl.connect(g);
    g.connect(bus || this.sfxBus);
    this.env(g, t, vol, attack, dur);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  // ---------- drum kit ----------

  kick(t, vol = 0.9) {
    this.tone({ f: 150, f2: 42, t, dur: 0.32, vol, attack: 0.002, bus: this.musicBus });
    this.tone({ type: 'square', f: 900, f2: 200, t, dur: 0.012, vol: 0.12, bus: this.musicBus });
  }
  snare(t, vol = 0.45) {
    this.noise({ t, dur: 0.18, vol, type: 'bandpass', freq: 2200, q: 0.7, bus: this.musicBus });
    this.tone({ type: 'triangle', f: 240, f2: 160, t, dur: 0.1, vol: vol * 0.6, bus: this.musicBus });
  }
  clap(t, vol = 0.35) {
    for (let i = 0; i < 3; i++) this.noise({ t: t + i * 0.011, dur: 0.05 + i * 0.04, vol: vol * (i === 2 ? 1 : 0.6), type: 'bandpass', freq: 1400, q: 1.2, bus: this.musicBus });
  }
  hat(t, open = false, vol = 0.14) {
    this.noise({ t, dur: open ? 0.22 : 0.04, vol, type: 'highpass', freq: 8000, bus: this.musicBus });
  }

  // ---------- melodic voices ----------

  bass(t, f, dur) {
    this.tone({ type: 'sawtooth', f, t, dur, vol: 0.32, attack: 0.005, bus: this.musicBus, cutoff: 520, q: 6 });
    this.tone({ type: 'sine', f: f / 2, t, dur, vol: 0.3, attack: 0.005, bus: this.musicBus });
  }
  lead(t, f, dur, vol = 0.07) {
    this.tone({ type: 'square', f, t, dur, vol, attack: 0.004, bus: this.musicBus, cutoff: 2600, q: 2, send: 0.6 });
  }
  pad(t, freqs, dur, vol = 0.035) {
    freqs.forEach((f) => {
      this.tone({ type: 'sawtooth', f, t, dur, vol, attack: dur * 0.3, bus: this.musicBus, cutoff: 1200, detune: -8 });
      this.tone({ type: 'sawtooth', f, t, dur, vol, attack: dur * 0.3, bus: this.musicBus, cutoff: 1200, detune: 8 });
    });
  }

  // ---------- game sfx ----------

  // A distinct sonic signature per command so players can play by ear.
  cue(kind, t = this.now) {
    switch (kind) {
      case 'tap':
        this.tone({ f: 520, f2: 1040, t, dur: 0.09, vol: 0.32 });
        break;
      case 'double':
        this.tone({ f: 660, t, dur: 0.06, vol: 0.28, type: 'triangle' });
        this.tone({ f: 880, t: t + 0.08, dur: 0.06, vol: 0.28, type: 'triangle' });
        break;
      case 'hold':
        this.tone({ type: 'sawtooth', f: 220, t, dur: 0.35, vol: 0.12, cutoff: 900, attack: 0.08 });
        this.tone({ f: 330, t, dur: 0.35, vol: 0.16, attack: 0.08 });
        break;
      case 'swipe':
        this.noise({ t, dur: 0.18, vol: 0.28, type: 'bandpass', freq: 600, freq2: 5000, q: 2 });
        break;
      case 'shake':
        for (let i = 0; i < 5; i++) this.noise({ t: t + i * 0.045, dur: 0.035, vol: 0.22, type: 'bandpass', freq: 4500, q: 3 });
        break;
      case 'shout':
        this.tone({ type: 'sawtooth', f: 180, f2: 420, t, dur: 0.22, vol: 0.14, cutoff: 1800, q: 4 });
        break;
      case 'freeze':
        [1568, 2093, 2637].forEach((f, i) => this.tone({ type: 'sine', f, t: t + i * 0.03, dur: 0.4, vol: 0.08, send: 0.8 }));
        break;
    }
  }

  success(combo = 0, fast = false) {
    const t = this.now;
    const base = 880 * Math.pow(2, Math.min(combo, 24) / 24);
    this.tone({ type: 'triangle', f: base, t, dur: 0.12, vol: 0.22, send: 0.3 });
    this.tone({ type: 'triangle', f: base * 1.5, t: t + 0.05, dur: 0.14, vol: 0.18, send: 0.3 });
    if (fast) this.tone({ type: 'sine', f: base * 2, t: t + 0.1, dur: 0.2, vol: 0.14, send: 0.8 });
  }

  holdTick(progress) {
    this.tone({ type: 'sine', f: 300 + progress * 600, dur: 0.04, vol: 0.06 });
  }

  partial() {
    this.tone({ type: 'triangle', f: 700, dur: 0.05, vol: 0.15 });
  }

  fail() {
    const t = this.now;
    this.tone({ type: 'sawtooth', f: 220, f2: 55, t, dur: 0.45, vol: 0.25, cutoff: 1400 });
    this.tone({ type: 'square', f: 233, f2: 58, t, dur: 0.45, vol: 0.1, cutoff: 900 });
    this.noise({ t, dur: 0.25, vol: 0.2, type: 'lowpass', freq: 1200, freq2: 100 });
    this.duck();
  }

  duck() {
    const f = this.musicFilter.frequency;
    const t = this.now;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.exponentialRampToValueAtTime(350, t + 0.05);
    f.exponentialRampToValueAtTime(18000, t + 1.1);
  }

  lifeUp() {
    const t = this.now;
    [784, 988, 1175, 1568].forEach((f, i) => this.tone({ type: 'square', f, t: t + i * 0.06, dur: 0.1, vol: 0.1, cutoff: 3000 }));
  }

  levelUp(t = this.now) {
    this.noise({ t, dur: 0.9, vol: 0.18, type: 'bandpass', freq: 400, freq2: 9000, q: 3, attack: 0.6 });
    [523, 659, 784, 1047].forEach((f, i) => this.tone({ type: 'triangle', f, t: t + 0.6 + i * 0.05, dur: 0.35, vol: 0.14, send: 0.6 }));
  }

  countTick(final = false, t = this.now) {
    this.tone({ type: 'square', f: final ? 1760 : 880, t, dur: final ? 0.25 : 0.08, vol: 0.12, cutoff: 4000, send: final ? 0.5 : 0 });
  }

  // The "tape stop": the track drops pitch and darkens as the run ends.
  gameOver() {
    const t = this.now;
    const f = this.musicFilter.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.exponentialRampToValueAtTime(120, t + 1.2);
    this.tone({ type: 'sawtooth', f: 440, f2: 40, t, dur: 1.3, vol: 0.2, cutoff: 1600 });
    this.tone({ type: 'sine', f: 330, f2: 30, t: t + 0.05, dur: 1.3, vol: 0.25 });
  }

  restoreMusic() {
    if (!this.ctx) return;
    const f = this.musicFilter.frequency;
    f.cancelScheduledValues(this.now);
    f.setValueAtTime(18000, this.now);
  }

  ui() {
    this.tone({ type: 'triangle', f: 1200, f2: 1800, dur: 0.05, vol: 0.12 });
  }
}

// ---------- sequencer ----------

// Minor-key loop: i - VI - III - VII. Semitone offsets from the key root.
const PROG = [
  { root: 0, triad: [0, 3, 7] },
  { root: -4, triad: [0, 4, 7] },
  { root: 3, triad: [0, 4, 7] },
  { root: -2, triad: [0, 4, 7] },
];
const BASS_PATTERN = [0, null, 12, null, 0, null, 0, 12, null, 0, null, 12, 0, null, 7, null];
const ARP = [0, 1, 2, 3, 2, 1, 0, 2, 1, 3, 2, 0, 3, 1, 2, 3];

export class Sequencer {
  constructor(audio) {
    this.a = audio;
    this.bpm = 100;
    this.targetBpm = 100;
    this.level = 1;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;
    this.onBeat = null; // (audioTime, beatIndex) => void
    this.beat = 0;
  }

  get stepDur() {
    return 60 / this.bpm / 4;
  }
  get beatDur() {
    return 60 / this.bpm;
  }

  start() {
    this.stop();
    this.step = 0;
    this.beat = 0;
    this.bpm = this.targetBpm;
    this.nextTime = this.a.now + 0.08;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return !!this.timer;
  }

  setLevel(level, bpm) {
    this.level = level;
    this.targetBpm = bpm;
  }

  schedule() {
    const horizon = this.a.now + 0.12;
    while (this.nextTime < horizon) {
      // Tempo changes land on bar lines so the groove never stumbles.
      if (this.step % 16 === 0) this.bpm = this.targetBpm;
      this.play(this.step, this.nextTime);
      if (this.step % 4 === 0) {
        this.onBeat && this.onBeat(this.nextTime, this.beat);
        this.beat++;
      }
      this.nextTime += this.stepDur;
      this.step++;
    }
  }

  play(step, t) {
    const a = this.a;
    const L = this.level;
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const chord = PROG[bar % 4];
    const key = Math.min(L - 1, 7); // modulate up a semitone each level
    const root = semis(A2, key + chord.root);

    if (s % 4 === 0) a.kick(t);
    if (L >= 2 && (s === 4 || s === 12)) L >= 4 ? a.snare(t) : a.clap(t);
    if (s % 4 === 2) a.hat(t, L >= 5 && s === 14);
    else if (L >= 4 && s % 2 === 1) a.hat(t, false, 0.06);

    const b = BASS_PATTERN[s];
    if (b !== null) a.bass(t, semis(root, L >= 6 ? b : Math.min(b, 7)), this.stepDur * 1.6);

    if (L >= 3 && s % 2 === 0) {
      const tones = [...chord.triad, 12];
      const n = tones[ARP[s] % tones.length];
      a.lead(t, semis(root * 4, n), this.stepDur * 1.8, L >= 6 ? 0.08 : 0.06);
    }
    if (L >= 4 && s === 0) a.pad(t, chord.triad.map((n) => semis(root * 2, n)), this.stepDur * 16);
  }
}
