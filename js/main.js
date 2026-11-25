import { AudioEngine, Sequencer } from './audio.js';
import { Input } from './input.js';
import { FX } from './fx.js';

// ---------- helpers ----------

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('boop:' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('boop:' + k, JSON.stringify(v));
    } catch {}
  },
};
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
const vibrate = (p) => {
  try {
    navigator.vibrate && navigator.vibrate(p);
  } catch {}
};
const isTouch = matchMedia('(pointer: coarse)').matches;

// ---------- content ----------

const ICONS = {
  tap: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="#fff" stroke="none"/><circle cx="12" cy="12" r="8.5" opacity=".6"/></svg>',
  double: '<svg viewBox="0 0 32 24"><circle cx="9" cy="12" r="4" fill="#fff" stroke="none"/><circle cx="23" cy="12" r="4" fill="#fff" stroke="none"/></svg>',
  hold: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  shake: '<svg viewBox="0 0 32 24"><rect x="11" y="3" width="10" height="18" rx="2.5"/><path d="M6 8l-3 4 3 4M26 8l3 4-3 4"/></svg>',
  shout: '<svg viewBox="0 0 28 24"><path d="M4 9v6h4l6 5V4L8 9z" fill="#fff"/><path d="M18 8.5a5 5 0 0 1 0 7M21.5 5.5a9 9 0 0 1 0 13"/></svg>',
  freeze: '<svg viewBox="0 0 24 24"><path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 2.5L15 4M9 20l3-2.5 3 2.5"/></svg>',
};
const ROT = { right: 0, down: 90, left: 180, up: 270 };
const arrow = (dir) => `<svg viewBox="0 0 24 24" style="transform:rotate(${ROT[dir]}deg)"><path d="M4 12h15M12.5 5l7 7-7 7" stroke-width="3.2"/></svg>`;
const OPP = { left: 'right', right: 'left', up: 'down', down: 'up' };

const CMD = {
  tap: { label: 'BOOP', color: '255,94,168', min: 1, w: 3, hint: isTouch ? 'Tap the pad' : 'Click the pad or press Space' },
  swipe: { label: 'SWIPE', color: '46,230,201', min: 1, w: 3, hint: isTouch ? 'Swipe the way the arrow points' : 'Drag across the pad or press an arrow key' },
  double: { label: 'BOOP BOOP', color: '255,176,46', min: 2, w: 1.6, hint: isTouch ? 'Tap twice, quickly' : 'Double-click or press Space twice' },
  hold: { label: 'HOLD', color: '140,110,255', min: 2, w: 1.4, extra: 1, hint: isTouch ? 'Press and hold until it fills' : 'Hold the mouse button or Space' },
  shout: { label: 'SHOUT', color: '255,230,0', min: 2, w: 1.3, extra: 1, needs: 'mic', hint: 'Make some noise!' },
  shake: { label: 'SHAKE', color: '255,122,46', min: 3, w: 1.3, hint: isTouch ? 'Shake your phone, or scribble on the screen' : 'Scribble back and forth on the pad, or press S' },
  freeze: { label: 'FREEZE', color: '200,230,255', min: 3, w: 1, hint: "Don't touch anything" },
};

const PER_LEVEL = 8;
const HUES = [265, 205, 165, 320, 240, 185, 290, 345, 150, 215];
const params = (level) => ({
  bpm: Math.min(100 + (level - 1) * 8, 180),
  beats: Math.max(1.6, 4 - (level - 1) * 0.32),
});

// ---------- systems ----------

const audio = new AudioEngine();
const seq = new Sequencer(audio);
const fx = new FX($('#fx'));
const input = new Input($('#play'), onInput);

const el = {
  stage: $('#stage'), hud: $('#hud'), score: $('#score'), mult: $('#mult'), lvl: $('#lvl'), bpm: $('#bpm'), lives: $('#lives'),
  pad: $('#pad'), padIcon: $('#pad-icon'), padLabel: $('#pad-label'), padSub: $('#pad-sub'), ring: $('#ring'), ringFg: $('#ring-fg'),
  feedback: $('#feedback'), hint: $('#hint'), banner: $('#banner'), micMeter: $('#mic-meter'),
  title: $('#title'), over: $('#over'), paused: $('#paused'), toast: $('#toast'),
};
const RING_C = 590.6;

const settings = {
  sound: store.get('sound', true),
  motion: false, // must be re-granted each session on iOS
  mic: false,
  mode: store.get('mode', 'endless'),
};
audio.setMuted(!settings.sound);

let G = null;
let wakeLock = null;
const seen = store.get('seen', {});

function newGame() {
  const daily = settings.mode === 'daily';
  return {
    state: 'countdown',
    daily,
    rng: daily ? mulberry32(hashStr('boop' + todayKey())) : Math.random,
    caps: { mic: !daily && !!input.mic },
    score: 0, shown: 0, lives: 3, combo: 0, bestCombo: 0,
    level: 1, hits: 0, misses: 0,
    log: [], // {kind, ms, fast, miss}
    cmd: null, waitUntil: Infinity, lastKind: null, countBeat: 0,
  };
}

// ---------- flow ----------

let stopTimer = null;
async function startGame() {
  if (G && G.state !== 'over') return;
  clearTimeout(stopTimer);
  audio.init();
  await audio.resume();
  audio.restoreMusic();
  G = newGame();
  showScreen(null);
  el.hud.classList.remove('hidden');
  el.micMeter.classList.toggle('hidden', !G.caps.mic);
  input.enabled = true;
  renderHud(true);
  applyLevel(1, true);
  setPadIdle('');
  el.hint.textContent = '';
  seq.onBeat = onBeat;
  seq.start();
  requestWakeLock();
}

function applyLevel(level, silent = false) {
  G.level = level;
  const p = params(level);
  seq.setLevel(level, p.bpm);
  fx.setHue(HUES[(level - 1) % HUES.length]);
  fx.setSpeed(0.25 + (p.bpm - 100) / 80);
  el.lvl.textContent = `LEVEL ${level}`;
  el.bpm.textContent = `${p.bpm} BPM`;
  if (!silent) {
    showBanner(`LEVEL ${level}`, `${p.bpm} BPM`);
    audio.levelUp();
    fx.burst(innerWidth / 2, innerHeight / 2, '255,255,255', 60, 1.4);
  }
}

// Fires ~100ms ahead of each beat with its exact audio timestamp, so
// visuals and command cues land on the beat rather than "about now".
function onBeat(audioT, beat) {
  if (!G) return;
  const delay = Math.max(0, (audioT - audio.now) * 1000);
  const perfT = performance.now() + delay;

  setTimeout(() => {
    if (!G || G.state === 'over' || G.state === 'paused') return;
    fx.beat(beat % 4 === 0 ? 1 : 0.55);
    if (!G.cmd) {
      el.pad.classList.remove('beat');
      void el.pad.offsetWidth;
      el.pad.classList.add('beat');
    }
  }, delay);

  if (G.state === 'countdown') {
    const n = G.countBeat++;
    if (n < 4) {
      audio.countTick(n === 3, audioT);
      setTimeout(() => G && G.state === 'countdown' && setPadIdle(n === 3 ? 'GO!' : String(3 - n), n < 3), delay);
    }
    if (n === 3) G.waitUntil = perfT + 1; // first command on the next beat
    if (n >= 4) G.state = 'playing';
    else return;
  }

  if (G.state === 'playing' && !G.cmd && perfT >= G.waitUntil) issue(audioT, perfT, delay);
}

function pick() {
  const avail = Object.entries(CMD).filter(([k, d]) => G.level >= d.min && (!d.needs || G.caps[d.needs]));
  const pool = avail.filter(([k]) => k !== G.lastKind || k === 'swipe');
  const total = pool.reduce((s, [, d]) => s + d.w, 0);
  let r = G.rng() * total;
  let kind = pool[0][0];
  for (const [k, d] of pool) {
    if ((r -= d.w) <= 0) {
      kind = k;
      break;
    }
  }
  const c = { kind, def: CMD[kind] };
  if (kind === 'swipe') {
    const dirs = ['left', 'right', 'up', 'down'];
    c.dir = dirs[Math.floor(G.rng() * 4)];
    c.opposite = G.level >= 5 && G.rng() < 0.35;
    c.target = c.opposite ? OPP[c.dir] : c.dir;
  }
  return c;
}

function issue(audioT, perfT, delay) {
  const c = pick();
  const { bpm, beats } = params(G.level);
  c.windowMs = (beats + (c.def.extra || 0)) * (60000 / bpm);
  c.holdMs = Math.min(700, c.windowMs * 0.45);
  c.start = perfT;
  c.deadline = perfT + c.windowMs;
  c.taps = 0;
  c.active = false;
  G.cmd = c;
  G.lastKind = c.kind;
  audio.cue(c.kind, audioT);
  setTimeout(() => {
    if (G && G.cmd === c) {
      // If the timer fired late (throttled tab, slow frame), shift the
      // window so the player always gets the full time to react.
      const lag = performance.now() - c.start;
      if (lag > 40) {
        c.start += lag;
        c.deadline += lag;
      }
      c.active = true;
      if (c.kind === 'hold' && input.pressing) c.holdStart = c.start;
      renderCmd(c);
    }
  }, delay);
}

function resolve(ok, info = {}) {
  const c = G.cmd;
  if (!c) return;
  G.cmd = null;
  const now = performance.now();
  const ms = Math.max(0, (info.t || now) - c.start);
  const beatMs = 60000 / params(G.level).bpm;
  G.waitUntil = now + Math.max(220, beatMs * 0.5);
  setRing(0);
  el.pad.style.setProperty('--hold', 0);
  const rect = el.pad.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  if (ok) {
    const fast = c.kind !== 'freeze' && ms < c.windowMs * 0.35;
    G.combo++;
    G.bestCombo = Math.max(G.bestCombo, G.combo);
    G.hits++;
    const mult = Math.min(8, 1 + Math.floor(G.combo / 5));
    const pts = (100 + (fast ? 50 : 0)) * mult;
    G.score += pts;
    G.log.push({ kind: c.kind, ms, fast, miss: false });
    audio.success(G.combo, fast);
    vibrate(12);
    fx.burst(cx, cy, c.def.color, fast ? 46 : 28, fast ? 1.3 : 1);
    fx.ring(cx, cy, c.def.color, rect.width * 0.9);
    flashPad('ok');
    showFeedback(fast ? `FAST! +${pts}` : `+${pts}`, fast ? 'fast' : 'good');
    if (G.combo % 20 === 0 && G.lives < 3) {
      G.lives++;
      audio.lifeUp();
      showBanner('+1 LIFE', `${G.combo} STREAK`);
      renderLives(true);
    }
    if (G.hits % PER_LEVEL === 0) {
      applyLevel(G.level + 1);
      G.waitUntil = now + beatMs * 2.5;
    }
    setPadIdle('');
  } else {
    G.combo = 0;
    G.misses++;
    G.lives--;
    G.log.push({ kind: c.kind, ms: c.windowMs, fast: false, miss: true });
    audio.fail();
    vibrate([40, 30, 60]);
    fx.shake(16);
    fx.hit('255,60,90', 0.28);
    flashPad('bad');
    showFeedback(info.reason || 'MISS', 'bad');
    renderLives();
    setPadIdle('');
    if (G.lives <= 0) {
      gameOver();
      return;
    }
    G.waitUntil = now + beatMs * 1.5;
  }
  renderHud();
}

function gameOver() {
  G.state = 'over';
  input.enabled = false;
  el.hint.textContent = '';
  audio.gameOver();
  stopTimer = setTimeout(() => seq.stop(), 1300);
  releaseWakeLock();

  const key = G.daily ? 'best-daily-' + todayKey() : 'best-endless';
  const prev = store.get(key, 0);
  const isBest = G.score > prev;
  if (isBest) store.set(key, G.score);

  setTimeout(() => {
    el.hud.classList.add('hidden');
    setPadIdle('');
    const hits = G.log.filter((l) => !l.miss && l.kind !== 'freeze');
    const avg = hits.length ? hits.reduce((s, l) => s + l.ms, 0) / hits.length : 0;
    const fastest = hits.length ? Math.min(...hits.map((l) => l.ms)) : 0;
    $('#over-kicker').textContent = G.daily ? `DAILY · ${todayKey()}` : 'GAME OVER';
    $('#st-level').textContent = G.level;
    $('#st-streak').textContent = G.bestCombo;
    $('#st-avg').textContent = hits.length ? `${Math.round(avg)}ms` : '-';
    $('#st-fast').textContent = hits.length ? `${Math.round(fastest)}ms` : '-';
    $('#new-best').classList.toggle('hidden', !isBest || G.score === 0);
    showScreen('over');
    countUp($('#final-score'), G.score, 900);
    drawChart();
    if (isBest && G.score > 0) {
      fx.burst(innerWidth / 2, innerHeight * 0.3, '255,225,77', 90, 1.6);
      audio.lifeUp();
    }
  }, 1100);
}

function pause() {
  if (!G || G.state === 'over' || G.state === 'paused') return;
  G.prevState = G.state === 'countdown' ? 'countdown' : 'playing';
  G.state = 'paused';
  G.cmd = null; // the in-flight command is voided, not failed
  seq.stop();
  input.enabled = false;
  setRing(0);
  setPadIdle('II');
  showScreen('paused');
}

async function resumeGame() {
  if (!G || G.state !== 'paused') return;
  await audio.resume();
  showScreen(null);
  G.state = 'countdown';
  G.countBeat = 0;
  input.enabled = true;
  seq.start();
}

function quitToMenu() {
  if (G && G.state !== 'over') {
    seq.stop();
  }
  G = null;
  input.enabled = false;
  el.hud.classList.add('hidden');
  setPadIdle('');
  releaseWakeLock();
  refreshTitle();
  showScreen('title');
}

// ---------- judging ----------

function onInput(ev) {
  if (!G) return;
  if (ev.type === 'down') el.pad.classList.add('pressed');
  if (ev.type === 'up') el.pad.classList.remove('pressed');
  if (G.state !== 'playing') return;
  const c = G.cmd;
  if (!c || !c.active) return;

  // Motion and mic only count when asked for, so loud rooms or a bumpy
  // bus ride can't fail an unrelated command.
  if ((ev.type === 'shout' || (ev.type === 'shake' && ev.via === 'motion')) && c.kind !== ev.type) return;

  const tap = ev.type === 'up' && !ev.moved;
  const ok = () => resolve(true, { t: ev.t });
  const wrong = (reason) => resolve(false, { reason });

  switch (c.kind) {
    case 'tap':
      if (tap) ok();
      else if (ev.type === 'swipe') wrong('THAT WAS A SWIPE');
      else if (ev.type === 'shake') wrong('WRONG MOVE');
      break;
    case 'double':
      if (tap) {
        c.taps++;
        if (c.taps >= 2) ok();
        else {
          c.firstTap = ev.t;
          audio.partial();
          flashPad('ok');
        }
      } else if (ev.type === 'swipe' || ev.type === 'shake') wrong('WRONG MOVE');
      break;
    case 'hold':
      if (ev.type === 'down') c.holdStart = ev.t;
      else if (ev.type === 'up' && c.holdStart) wrong('LET GO TOO SOON');
      else if (ev.type === 'shake') wrong('WRONG MOVE');
      break;
    case 'swipe':
      if (ev.type === 'swipe') ev.dir === c.target ? ok() : wrong(c.opposite ? 'OTHER WAY!' : 'WRONG WAY');
      else if (tap) wrong('SWIPE, DON’T TAP');
      else if (ev.type === 'shake') wrong('WRONG MOVE');
      break;
    case 'freeze':
      if (ev.type === 'down' || ev.type === 'swipe' || ev.type === 'shake') wrong('YOU MOVED');
      break;
    case 'shake':
      if (ev.type === 'shake') ok();
      else if (tap || ev.type === 'swipe') wrong('SHAKE IT');
      break;
    case 'shout':
      if (ev.type === 'shout') ok();
      else if (tap || ev.type === 'swipe') wrong('USE YOUR VOICE');
      break;
  }
}

// ---------- frame loop ----------

let last = performance.now();
function frame(now) {
  const dt = Math.min(now - last, 100);
  last = now;
  input.poll(dt);

  if (G && G.state === 'playing' && G.cmd && G.cmd.active) {
    const c = G.cmd;
    const left = Math.max(0, 1 - (now - c.start) / c.windowMs);
    setRing(left);
    el.ring.classList.toggle('urgent', left < 0.3 && c.kind !== 'freeze');
    if (c.kind === 'hold' && c.holdStart) {
      const p = Math.min(1, (now - c.holdStart) / c.holdMs);
      el.pad.style.setProperty('--hold', p);
      if (p >= 1) resolve(true, { t: c.holdStart });
    } else if (c.kind === 'double' && c.taps === 1 && now - c.firstTap > 450) {
      resolve(false, { reason: 'ONE MORE BOOP' });
    } else if (now > c.deadline) {
      c.kind === 'freeze' ? resolve(true, { t: now }) : resolve(false, { reason: 'TOO SLOW' });
    }
  }

  if (G && G.shown !== G.score) {
    G.shown += Math.max(1, (G.score - G.shown) * 0.2);
    if (G.shown > G.score) G.shown = G.score;
    el.score.textContent = fmt(G.shown);
  }
  if (input.mic && G && G.caps.mic) el.micMeter.firstElementChild.style.width = `${input.level * 100}%`;

  const s = fx.frame(dt);
  el.stage.style.transform = s ? `translate(${s.x}px,${s.y}px) rotate(${s.r}deg)` : '';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- rendering ----------

function setRing(frac) {
  el.ringFg.style.strokeDashoffset = String(RING_C * (1 - frac));
}

function renderCmd(c) {
  const p = el.pad;
  p.className = `show kind-${c.kind}${c.opposite ? ' opposite' : ''}`;
  p.style.setProperty('--c', c.def.color);
  el.ring.style.setProperty('--c', c.def.color);
  p.style.setProperty('--hold', 0);
  void p.offsetWidth;
  el.padIcon.innerHTML = c.kind === 'swipe' ? arrow(c.dir) : ICONS[c.kind] || '';
  el.padLabel.className = '';
  el.padLabel.textContent = c.def.label;
  el.padSub.textContent = c.opposite ? 'OPPOSITE' : '';
  // Teach each command the first few times a player meets it.
  const n = seen[c.kind] || 0;
  el.hint.textContent = n < 3 ? (c.opposite ? 'Swipe the OTHER way' : c.def.hint) : '';
  seen[c.kind] = n + 1;
  store.set('seen', seen);
}

function setPadIdle(text, count = false) {
  const p = el.pad;
  const keep = p.classList.contains('ok') ? 'ok' : p.classList.contains('bad') ? 'bad' : '';
  p.className = `idle ${keep}`;
  p.style.removeProperty('--c');
  el.ring.style.removeProperty('--c');
  el.ring.classList.remove('urgent');
  el.padIcon.innerHTML = '';
  el.padSub.textContent = '';
  el.padLabel.textContent = text;
  el.padLabel.className = count || text === 'II' ? 'count' : '';
  if (count) {
    p.classList.add('show');
  }
}

function flashPad(kind) {
  const p = el.pad;
  p.classList.remove('ok', 'bad');
  void p.offsetWidth;
  p.classList.add(kind);
}

function showFeedback(text, cls) {
  const f = el.feedback;
  f.className = '';
  void f.offsetWidth;
  f.textContent = text;
  f.className = `show ${cls}`;
}

function showBanner(title, sub) {
  const b = el.banner;
  b.className = '';
  void b.offsetWidth;
  b.innerHTML = `${title}<small>${sub}</small>`;
  b.className = 'show';
}

const HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.5 1.2 5.3 3.1 1.8-1.9 3.2-3.1 5.3-3.1 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>';
function renderLives(pop = false) {
  el.lives.innerHTML = HEART.repeat(3);
  [...el.lives.children].forEach((h, i) => {
    if (i >= G.lives) h.classList.add('lost');
    if (pop && i === G.lives - 1) h.classList.add('pop');
  });
}

let lastMult = 1;
function renderHud(reset = false) {
  if (reset) {
    el.score.textContent = '0';
    lastMult = 1;
    renderLives();
  }
  const mult = Math.min(8, 1 + Math.floor(G.combo / 5));
  el.mult.textContent = `×${mult}${G.combo >= 3 ? ` · ${G.combo}` : ''}`;
  el.mult.classList.toggle('hot', mult > 1);
  if (mult !== lastMult) {
    el.mult.classList.remove('bump');
    void el.mult.offsetWidth;
    el.mult.classList.add('bump');
    lastMult = mult;
  }
  el.score.classList.remove('bump');
  void el.score.offsetWidth;
  el.score.classList.add('bump');
}

function countUp(node, to, dur) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    node.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function drawChart() {
  const cv = $('#chart');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const log = G.log;
  if (!log.length) return;
  const max = Math.max(...log.filter((l) => l.kind !== 'freeze' && !l.miss).map((l) => l.ms), 500);
  const n = log.length;
  const gap = n > 40 ? 1 : 2;
  const bw = Math.max(1, (w - gap * (n - 1)) / n);
  log.forEach((l, i) => {
    // FREEZE has no reaction time (you win by waiting), so it gets a short marker.
    const frozen = l.kind === 'freeze' && !l.miss;
    const bh = l.miss ? h : frozen ? 6 : Math.max(3, (l.ms / max) * (h - 4));
    g.fillStyle = l.miss ? 'rgba(255,60,90,0.85)' : frozen ? 'rgba(200,230,255,0.7)' : l.fast ? '#ffe14d' : 'rgb(46,230,140)';
    const x = i * (bw + gap);
    const r = Math.min(3, bw / 2);
    g.beginPath();
    g.roundRect ? g.roundRect(x, h - bh, bw, bh, [r, r, 0, 0]) : g.rect(x, h - bh, bw, bh);
    g.fill();
  });
}

function shareText() {
  const row = G.log.slice(0, 40).map((l) => (l.miss ? '🟥' : l.fast ? '🟨' : '🟩')).join('');
  const head = G.daily ? `BOOP Daily ${todayKey()}` : 'BOOP';
  return `${head}: ${fmt(G.score)} pts · level ${G.level} · ${G.bestCombo} streak\n${row}\nhttps://hughtures.github.io/boop-it/`;
}

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.toast.classList.remove('show'), 1800);
}

function showScreen(name) {
  for (const s of ['title', 'over', 'paused']) el[s].classList.toggle('hidden', s !== name);
  el.stage.style.visibility = name === 'title' ? 'hidden' : '';
}

// ---------- title screen ----------

function refreshTitle() {
  $('#best-endless').textContent = fmt(store.get('best-endless', 0));
  $('#best-daily').textContent = fmt(store.get('best-daily-' + todayKey(), 0));
  $('#daily-date').textContent = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode)));
}

document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    settings.mode = b.dataset.mode;
    store.set('mode', settings.mode);
    refreshTitle();
    if (audio.ctx) audio.ui();
  })
);

const optSound = $('#opt-sound');
optSound.checked = settings.sound;
optSound.addEventListener('change', () => {
  settings.sound = optSound.checked;
  store.set('sound', settings.sound);
  audio.setMuted(!settings.sound);
});

if (!Input.motionAvailable) $('#tog-motion').classList.add('hidden');
const optMotion = $('#opt-motion');
optMotion.addEventListener('change', async () => {
  if (optMotion.checked) {
    const ok = await input.enableMotion();
    if (!ok) {
      optMotion.checked = false;
      toast('Motion access was blocked');
    } else toast('Shake your phone when it says SHAKE');
  }
});

const optMic = $('#opt-mic');
optMic.addEventListener('change', async () => {
  if (optMic.checked) {
    audio.init();
    await audio.resume();
    const ok = await input.enableMic(audio.ctx);
    if (!ok) {
      optMic.checked = false;
      toast('Microphone access was blocked');
    } else toast(settings.mode === 'daily' ? 'SHOUT is on in Endless mode' : 'SHOUT commands are on');
  } else input.disableMic();
});

$('#play-btn').addEventListener('click', startGame);
$('#again-btn').addEventListener('click', startGame);
$('#menu-btn').addEventListener('click', quitToMenu);
$('#pause-btn').addEventListener('click', pause);
$('#resume-btn').addEventListener('click', resumeGame);
$('#quit-btn').addEventListener('click', quitToMenu);
$('#howto-btn').addEventListener('click', () => $('#howto').showModal());
$('#share-btn').addEventListener('click', async () => {
  const text = shareText();
  try {
    if (navigator.share && isTouch) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    }
  } catch {}
});

addEventListener('keydown', (e) => {
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (G && G.state === 'paused') resumeGame();
    else pause();
  } else if (e.code === 'Enter' && !G && !$('#howto').open && el.title.offsetParent !== null) {
    startGame();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}
function releaseWakeLock() {
  try {
    wakeLock && wakeLock.release();
  } catch {}
  wakeLock = null;
}

// First visit: show the rules once.
if (!store.get('onboarded', false)) {
  store.set('onboarded', true);
  setTimeout(() => $('#howto').showModal(), 400);
}

refreshTitle();
setPadIdle('');
showScreen('title');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for automated testing only.
window.__boop = { get G() { return G; }, audio, seq, input };
