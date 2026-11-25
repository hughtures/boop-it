// Unified input: pointer gestures, keyboard, device motion and microphone,
// all normalized into one small event vocabulary the game can judge:
//   down | up {moved, dur} | swipe {dir} | shake | shout

const SWIPE_MIN = 42; // px
const REVERSAL_STEP = 26; // px travel that counts as a scribble stroke
const SHAKE_REVERSALS = 3;

export class Input {
  constructor(el, emit) {
    this.el = el;
    this.emit = emit;
    this.p = null; // active pointer
    this.keyDown = false;
    this.enabled = false;
    this.motionOn = false;
    this.mic = null;
    this.level = 0; // mic level 0..1 for the meter
    this._lastShake = 0;
    this._lastShout = 0;
    this._loud = 0;

    el.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e, true));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
  }

  fire(type, extra = {}) {
    if (!this.enabled) return;
    this.emit({ type, t: performance.now(), ...extra });
  }

  // ---------- pointer ----------

  onDown(e) {
    if (this.p || !this.enabled) return;
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    this.p = {
      id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(),
      ax: e.clientX, ay: e.clientY, sx: 0, sy: 0, rev: 0, shook: false,
    };
    this.fire('down', { x: e.clientX, y: e.clientY });
  }

  onMove(e) {
    const p = this.p;
    if (!p || e.pointerId !== p.id) return;
    // Scribble detection: count direction reversals on either axis.
    const dx = e.clientX - p.ax;
    if (Math.abs(dx) >= REVERSAL_STEP) {
      const s = Math.sign(dx);
      if (p.sx && s !== p.sx) p.rev++;
      p.sx = s;
      p.ax = e.clientX;
    }
    const dy = e.clientY - p.ay;
    if (Math.abs(dy) >= REVERSAL_STEP) {
      const s = Math.sign(dy);
      if (p.sy && s !== p.sy) p.rev++;
      p.sy = s;
      p.ay = e.clientY;
    }
    if (!p.shook && p.rev >= SHAKE_REVERSALS) {
      p.shook = true;
      this.fire('shake', { via: 'scribble' });
    }
  }

  onUp(e, cancelled = false) {
    const p = this.p;
    if (!p || e.pointerId !== p.id) return;
    this.p = null;
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    const dist = Math.hypot(dx, dy);
    const dur = performance.now() - p.t0;
    if (p.shook || cancelled) {
      this.fire('up', { moved: true, dur });
      return;
    }
    if (dist >= SWIPE_MIN) {
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      this.fire('swipe', { dir });
      this.fire('up', { moved: true, dur });
    } else {
      this.fire('up', { moved: false, dur });
    }
  }

  get pressing() {
    return !!this.p || this.keyDown;
  }

  // ---------- keyboard ----------

  onKey(e, down) {
    const k = e.code;
    if (k === 'Space' || k === 'Enter') {
      if (!this.enabled) return;
      e.preventDefault();
      if (down && !e.repeat && !this.keyDown) {
        this.keyDown = true;
        this._kt = performance.now();
        this.fire('down');
      } else if (!down && this.keyDown) {
        this.keyDown = false;
        this.fire('up', { moved: false, dur: performance.now() - this._kt });
      }
      return;
    }
    if (!down || e.repeat) return;
    const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyA: 'left', KeyD: 'right', KeyW: 'up' };
    if (dirs[k]) {
      e.preventDefault();
      this.fire('swipe', { dir: dirs[k] });
    } else if (k === 'KeyS') {
      this.fire('shake', { via: 'key' });
    } else if (k === 'KeyX') {
      this.fire('shout', { via: 'key' });
    }
  }

  // ---------- device motion ----------

  static get motionAvailable() {
    return typeof DeviceMotionEvent !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  }

  async enableMotion() {
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch {
      return false;
    }
    if (!this._motionHandler) {
      let peaks = [];
      this._motionHandler = (e) => {
        const a = e.acceleration && e.acceleration.x !== null ? e.acceleration : null;
        let mag;
        if (a) mag = Math.hypot(a.x, a.y, a.z);
        else if (e.accelerationIncludingGravity) {
          const g = e.accelerationIncludingGravity;
          mag = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
        } else return;
        const now = performance.now();
        if (mag > 16) {
          peaks = peaks.filter((t) => now - t < 450);
          peaks.push(now);
          if (peaks.length >= 2 && now - this._lastShake > 700) {
            this._lastShake = now;
            peaks = [];
            this.fire('shake', { via: 'motion' });
          }
        }
      };
      window.addEventListener('devicemotion', this._motionHandler);
    }
    this.motionOn = true;
    return true;
  }

  // ---------- microphone ----------

  async enableMic(ctx) {
    if (this.mic) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an); // analysis only, never routed to the speakers
      this.mic = { stream, an, buf: new Float32Array(an.fftSize), floor: 0.01 };
      return true;
    } catch {
      return false;
    }
  }

  disableMic() {
    if (!this.mic) return;
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.level = 0;
  }

  // Called once per animation frame.
  poll(dt) {
    const m = this.mic;
    if (!m) return;
    m.an.getFloatTimeDomainData(m.buf);
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
    const rms = Math.sqrt(sum / m.buf.length);
    // Adaptive noise floor: follows quiet rooms quickly, loud ones slowly.
    const threshold = Math.max(0.09, m.floor * 5);
    if (rms < threshold) m.floor += (rms - m.floor) * (rms < m.floor ? 0.2 : 0.01);
    this.level = Math.min(1, rms / threshold);
    if (rms > threshold) this._loud += dt;
    else this._loud = 0;
    const now = performance.now();
    if (this._loud > 90 && now - this._lastShout > 700) {
      this._lastShout = now;
      this._loud = 0;
      this.fire('shout', { via: 'mic' });
    }
  }
}
