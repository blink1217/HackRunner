/**
 * PaceBeat RECOVERY ENGINE — biometrically-guided contrast therapy
 *
 * Science:
 * - arXiv 2509.17112 (RISE): adaptive music aligned to exercise intensity
 * - Frontiers Psychol. 2026 meta-analysis: music intervention improves HRV (RMSSD/HF)
 * - Jeong et al. 2024: slow-tempo post-exercise music accelerates HR return, raises HRV
 * - Resonance-frequency breathing (6 breaths/min) maximally stimulates vagal tone
 *
 * Parse BLE R-R intervals (Apple Watch / Polar / Garmin standard HRM),
 * compute rolling RMSSD + HR, drive a Recovery state machine with
 * slow-tempo procedural music + resonance breathing pacer.
 */

class HRVTracker {
  constructor() {
    this.rr = [];           // R-R intervals in ms (last 90s)
    this.hr = [];           // HR samples
    this.maxAge = 90000;
    this.rmssd = null;
    this.hrAvg = null;
    this.baselineRmssd = null; // learned personal baseline
  }

  /** Feed BLE heart_rate_measurement. Returns {hr, rr} parsed. */
  feedHRM(dv) {
    const flags = dv.getUint8(0);
    const is16 = (flags & 1) === 1;
    const hr = is16 ? dv.getUint16(1, true) : dv.getUint8(1);
    let n = is16 ? 3 : 2;
    let rr = null;
    if (flags & 0x10) { // RR-Interval present (bit 4), 1/1024 s units
      rr = dv.getUint16(n, true) * (1000 / 1024);
    }
    this.push(hr, rr);
    return { hr, rr };
  }

  push(hr, rrMs) {
    const now = Date.now();
    this.hr.push({ t: now, v: hr });
    if (rrMs && rrMs >= 300 && rrMs <= 2000) {
      this.rr.push({ t: now, v: rrMs });
    }
    this.hr = this.hr.filter(s => now - s.t < this.maxAge);
    this.rr = this.rr.filter(s => now - s.t < this.maxAge);
    this._compute();
  }

  /** Feed fallback: synthetic HR from any source (GPS cadence etc.) */
  pushHR(hr) { this.push(hr, null); }

  _compute() {
    if (this.hr.length) {
      const recent = this.hr.slice(-10);
      this.hrAvg = recent.reduce((a, b) => a + b.v, 0) / recent.length;
    }
    // RMSSD: root mean square of successive RR differences (needs ≥6 intervals)
    if (this.rr.length >= 6) {
      let sum = 0, cnt = 0;
      for (let i = 1; i < this.rr.length; i++) {
        const d = this.rr[i].v - this.rr[i - 1].v;
        sum += d * d; cnt++;
      }
      this.rmssd = Math.sqrt(sum / cnt);
      // learn personal baseline (slow EMA toward observed max)
      if (this.baselineRmssd == null) this.baselineRmssd = this.rmssd;
      else this.baselineRmssd += (Math.max(this.rmssd, this.baselineRmssd) - this.baselineRmssd) * 0.002;
    }
    // else: keep previous rmssd — don't null out on sparse data
  }

  /** HR decay rate %/min — steeper = better recovery */
  hrDecayPerMin() {
    if (this.hr.length < 20) return 0;
    const first = this.hr[0], last = this.hr[this.hr.length - 1];
    const mins = (last.t - first.t) / 60000;
    if (mins < 0.2) return 0;
    return (first.v - last.v) / mins;
  }

  /** 0-100 recovery readiness score */
  readiness() {
    if (this.hrAvg == null) return 0;
    let score = 0;
    // HR component (max 55): hr 50 → 55pts, hr 100+ → 0
    score += Math.max(0, Math.min(55, (110 - this.hrAvg) * 0.7857));
    // RMSSD component (max 35): ≥60ms excellent, ≤15ms poor
    if (this.rmssd != null) {
      score += Math.max(0, Math.min(35, (this.rmssd - 12) * 0.73));
    }
    // Decay component (max 10): ≥15 bpm/min = excellent
    score += Math.max(0, Math.min(10, this.hrDecayPerMin() * 0.66));
    return Math.round(Math.min(100, score));
  }
}

class ResonanceBreath {
  /** 6 breaths/min = 10s cycle (5.5s inhale-pacer, 4.5s exhale) — vagal maximizer */
  constructor(periodMs = 10000) {
    this.period = periodMs;
    this.phase = 0;
  }

  /** Returns 0..1 breath curve for audio pacer + UI ring */
  value(t) {
    const p = ((t % this.period) / this.period);
    // inhale 0-0.55 (rise), exhale 0.55-1 (fall)
    return p < 0.55 ? p / 0.55 : 1 - (p - 0.55) / 0.45;
  }

  inhaling(t) { return ((t % this.period) / this.period) < 0.55; }
}

class RecoveryEngine {
  constructor() {
    this.hrv = new HRVTracker();
    this.breath = new ResonanceBreath();
    this.state = 'ACTIVE';   // ACTIVE → COOLDOWN → DEEP_RECOVERY → READY
    this.stateSince = Date.now();
    this.sauna = null;       // {startedAt, targetMin} when in sauna
    this.log = [];
    this.hrStartRecovery = null;
    this.onStateChange = null;
  }

  update(hrNow, isRunning, gpsSpeed) {
    if (hrNow != null) this.hrv.pushHR(hrNow);

    // instantaneous HR drives state transitions (responsive), hrAvg for display
    const hr = hrNow != null ? hrNow : (this.hrv.hrAvg || 0);
    const prev = this.state;

    if (isRunning && gpsSpeed > 2) {
      this._setState('ACTIVE');
    } else if (hr > 115) {
      this._setState('COOLDOWN');
    } else if (hr > 72) {
      this._setState('DEEP_RECOVERY');
      if (prev === 'COOLDOWN' && this.hrStartRecovery == null) this.hrStartRecovery = hr;
    } else if (hr > 0) {
      this._setState('READY');
    }

    // sauna protocol progress
    if (this.sauna) {
      const mins = (Date.now() - this.sauna.startedAt) / 60000;
      if (mins >= this.sauna.targetMin || (hr > 0 && hr > 130)) this.endSauna(hr);
    }
    return { state: this.state, hr, rmssd: this.hrv.rmssd, readiness: this.hrv.readiness() };
  }

  _setState(s) {
    if (s === this.state) return;
    this.stateSince = Date.now();
    this.state = s;
    // lock recovery baseline at COOLDOWN entry (start of the recovery window)
    if (s === 'COOLDOWN') this.hrStartRecovery = this.hrv.hrAvg;
    if ((s === 'DEEP_RECOVERY' || s === 'READY') && this.hrStartRecovery == null) {
      this.hrStartRecovery = this.hrv.hrAvg;
    }
    if (this.onStateChange) this.onStateChange(s, this.summary());
  }

  startSauna(targetMin) {
    this.sauna = { startedAt: Date.now(), targetMin: targetMin || 15 };
    this._setState('SAUNA');
    this.sauna = { startedAt: Date.now(), targetMin: targetMin || 15 };
    this.log.push({ t: Date.now(), ev: 'SAUNA_START', hr: this.hrv.hrAvg });
  }

  endSauna(hr) {
    if (!this.sauna) return;
    this.log.push({ t: Date.now(), ev: 'SAUNA_END', min: ((Date.now() - this.sauna.startedAt) / 60000).toFixed(1), hr });
    this.sauna = null;
    this._setState('DEEP_RECOVERY');
  }

  saunaRemaining() {
    if (!this.sauna) return 0;
    return Math.max(0, this.sauna.targetMin - (Date.now() - this.sauna.startedAt) / 60000);
  }

  /** Recovery speed vs first-cooldown HR — the demo headline number */
  recoverySpeed() {
    if (this.hrStartRecovery == null || this.hrv.hrAvg == null) return null;
    const mins = Math.max(0.2, (Date.now() - this.stateSince) / 60000);
    return ((this.hrStartRecovery - this.hrv.hrAvg) / mins);
  }

  summary() {
    return {
      state: this.state,
      hr: this.hrv.hrAvg,
      rmssd: this.hrv.rmssd,
      readiness: this.hrv.readiness(),
      decay: this.hrv.hrDecayPerMin(),
      speed: this.recoverySpeed(),
      baseline: this.hrv.baselineRmssd
    };
  }
}

/** Procedural recovery music: 62 BPM ambient wash + resonance pacer */
class RecoveryMusic {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.dest = dest;
    this.playing = false;
    this.bpm = 62;
    this.nextNote = 0;
    this.timer = null;
    this.step = 0;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.nextNote = this.ctx.currentTime + 0.1;
    this.timer = setInterval(() => this._schedule(), 50);
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
  }

  _schedule() {
    if (!this.playing) return;
    const spb = 60 / this.bpm;
    while (this.nextNote < this.ctx.currentTime + 0.15) {
      const t = this.nextNote, s = this.step % 16;
      if (s % 8 === 0) this._pad(t, 41, 3.2, 0.10);          // F2 pad swell
      if (s % 16 === 6) this._pad(t, 48, 2.8, 0.08);         // C3 answer
      if (s % 4 === 0) this._softKick(t, 0.25);              // heartbeat pulse
      if (s === 0) this._pacer(t);                            // breath pacer blip
      if (s === 5 || s === 11) this._shimmer(t, 0.05);       // high sparkle
      this.nextNote += spb / 4;
      this.step++;
    }
  }

  /** Resonance pacer: rising blip on inhale, falling on exhale (10s cycle) */
  _pacer(t) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(392, t); // G4
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g).connect(this.dest);
    o.start(t); o.stop(t + 1);
  }

  _pad(t, midi, len, vel) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel, t + len * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    g.connect(f).connect(this.dest);
    [0, 7, 12].forEach(off => {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = 440 * Math.pow(2, (midi + off - 69) / 12);
      o.detune.value = Math.random() * 6 - 3;
      o.connect(g); o.start(t); o.stop(t + len + 0.1);
    });
  }

  _softKick(t, vel) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.dest);
    o.start(t); o.stop(t + 0.32);
  }

  _shimmer(t, vel) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = 1760 + Math.random() * 400;
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    o.connect(g).connect(this.dest);
    o.start(t); o.stop(t + 1.5);
  }
}

if (typeof window !== 'undefined') {
  window.HRVTracker = HRVTracker;
  window.ResonanceBreath = ResonanceBreath;
  window.RecoveryEngine = RecoveryEngine;
  window.RecoveryMusic = RecoveryMusic;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HRVTracker, ResonanceBreath, RecoveryEngine, RecoveryMusic };
}
