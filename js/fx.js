// Canvas effects layer: a beat-reactive starfield "tunnel", particle bursts,
// shockwave rings and screen shake. Respects prefers-reduced-motion.

export class FX {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.parts = [];
    this.rings = [];
    this.stars = [];
    this.hue = 265;
    this.targetHue = 265;
    this.pulse = 0;
    this.speed = 0.25;
    this.targetSpeed = 0.25;
    this.shakeAmt = 0;
    this.flash = 0;
    this.flashColor = '255,60,90';
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
    addEventListener('resize', () => this.resize());
    for (let i = 0; i < 140; i++) this.stars.push(this.newStar(true));
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = innerWidth;
    this.h = innerHeight;
    this.c.width = this.w * dpr;
    this.c.height = this.h * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  newStar(anywhere = false) {
    return { a: Math.random() * Math.PI * 2, r: anywhere ? Math.random() : Math.random() * 0.05, z: 0.3 + Math.random() * 0.7 };
  }

  setHue(h) {
    this.targetHue = h;
  }
  setSpeed(s) {
    this.targetSpeed = s;
  }
  beat(s = 1) {
    this.pulse = Math.max(this.pulse, s);
  }
  shake(a) {
    if (!this.reduced) this.shakeAmt = Math.max(this.shakeAmt, a);
  }
  hit(color = '255,60,90', a = 0.35) {
    this.flashColor = color;
    this.flash = a;
  }

  burst(x, y, color, n = 30, power = 1) {
    if (this.reduced) n = Math.round(n / 3);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = (2 + Math.random() * 7) * power;
      this.parts.push({
        x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 1.5,
        life: 1, decay: 0.012 + Math.random() * 0.02, size: 2 + Math.random() * 4, color,
        spin: Math.random() * 6, rot: Math.random() * 6, sq: Math.random() < 0.5,
      });
    }
  }

  ring(x, y, color, max = 260) {
    this.rings.push({ x, y, r: 20, max, color, life: 1 });
  }

  frame(dt) {
    const g = this.g;
    const k = Math.min(dt / 16.67, 3);
    this.hue += (((this.targetHue - this.hue + 540) % 360) - 180) * 0.04 * k;
    this.speed += (this.targetSpeed - this.speed) * 0.03 * k;
    this.pulse *= Math.pow(0.88, k);
    this.flash *= Math.pow(0.88, k);
    this.shakeAmt *= Math.pow(0.85, k);

    const { w, h } = this;
    const cx = w / 2;
    const cy = h / 2;
    const hue = this.hue;

    const bg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
    bg.addColorStop(0, `hsl(${hue} 70% ${10 + this.pulse * 6}%)`);
    bg.addColorStop(1, `hsl(${(hue + 40) % 360} 60% 3%)`);
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    // Starfield tunnel: stars stream outward, faster as tempo rises.
    const R = Math.hypot(cx, cy);
    const sp = (this.reduced ? 0.3 : 1) * (this.speed + this.pulse * 0.6);
    g.lineCap = 'round';
    for (const s of this.stars) {
      const pr = s.r;
      s.r += 0.0025 * sp * s.z * (0.3 + s.r * 3) * k;
      if (s.r > 1.05) Object.assign(s, this.newStar());
      const x1 = cx + Math.cos(s.a) * pr * R;
      const y1 = cy + Math.sin(s.a) * pr * R;
      const x2 = cx + Math.cos(s.a) * s.r * R;
      const y2 = cy + Math.sin(s.a) * s.r * R;
      const alpha = Math.min(1, s.r * 2.2) * s.z;
      g.strokeStyle = `hsla(${(hue + 60 * s.z) % 360} 100% 80% / ${alpha})`;
      g.lineWidth = 1 + s.r * 2.5 * s.z;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2 + (x2 - x1) * 2, y2 + (y2 - y1) * 2);
      g.stroke();
    }

    // Beat glow behind the pad.
    if (this.pulse > 0.02) {
      const pr = Math.min(w, h) * (0.32 + this.pulse * 0.08);
      const glow = g.createRadialGradient(cx, cy, pr * 0.4, cx, cy, pr * 1.4);
      glow.addColorStop(0, `hsla(${hue} 100% 65% / ${0.25 * this.pulse})`);
      glow.addColorStop(1, 'hsla(0 0% 0% / 0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, w, h);
    }

    // Shockwave rings.
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += (r.max - r.r) * 0.12 * k;
      r.life -= 0.035 * k;
      if (r.life <= 0) {
        this.rings.splice(i, 1);
        continue;
      }
      g.strokeStyle = `rgba(${r.color},${r.life})`;
      g.lineWidth = 6 * r.life;
      g.beginPath();
      g.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      g.stroke();
    }

    // Particles (confetti squares + glowing dots).
    g.globalCompositeOperation = 'lighter';
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.vy += 0.18 * k;
      p.vx *= Math.pow(0.985, k);
      p.rot += p.spin * 0.02 * k;
      p.life -= p.decay * k;
      if (p.life <= 0) {
        this.parts.splice(i, 1);
        continue;
      }
      g.fillStyle = `rgba(${p.color},${p.life})`;
      if (p.sq) {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillRect(-p.size, -p.size * 0.5, p.size * 2, p.size);
        g.restore();
      } else {
        g.beginPath();
        g.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalCompositeOperation = 'source-over';

    if (this.flash > 0.01) {
      g.fillStyle = `rgba(${this.flashColor},${this.flash})`;
      g.fillRect(0, 0, w, h);
    }

    const s = this.shakeAmt;
    return s > 0.3 ? { x: (Math.random() - 0.5) * s * 2, y: (Math.random() - 0.5) * s * 2, r: (Math.random() - 0.5) * s * 0.15 } : null;
  }
}
