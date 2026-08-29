/**
 * PaceBeat V3 — The Adaptive DJ Engine
 * 8-stem procedural arrangement with vocal state machine + entropy tracking
 */

class AudioGraphRouter {
  constructor(ctx) {
    this.ctx = ctx;
    this.stems = {
      kick: { bus: ctx.createGain(), pan: ctx.createStereoPanner(), active: false },
      snare_clap: { bus: ctx.createGain(), pan: ctx.createStereoPanner(), active: false },
      percussion_tops: { bus: ctx.createGain(), pan: ctx.createStereoPanner(), active: false },
      sub_mid_bass: { bus: ctx.createGain(), pan: ctx.createStereoPanner(), active: false },
      harmonic_pads: { bus: ctx.createGain(), pan: ctx.createStereoPanner(), active: false },
      lead_synths: { bus: ctx.createGain(), pan: ctx.createStereoPanner(), active: false },
      vocal_layer: { bus: ctx.createGain(), pan: ctx.createStereoPanner(), active: false },
      transition_fx: { bus: ctx.createGain(), pan: ctx.createStereoPanner(), active: false }
    };
    
    // Panning: kick/bass/vocal center, others spread
    this.stems.kick.pan.pan.value = 0;
    this.stems.sub_mid_bass.pan.pan.value = 0;
    this.stems.vocal_layer.pan.pan.value = 0;
    this.stems.snare_clap.pan.pan.value = 0.15;
    this.stems.percussion_tops.pan.pan.value = 0.4;
    this.stems.harmonic_pads.pan.pan.value = -0.5;
    this.stems.lead_synths.pan.pan.value = 0.35;
    this.stems.transition_fx.pan.pan.value = 0;
    
    // Master chain
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.1;
    
    // Route stems → pan → master → compressor → destination
    for (let name in this.stems) {
      this.stems[name].bus.connect(this.stems[name].pan);
      this.stems[name].pan.connect(this.master);
    }
    this.master.connect(this.compressor);
    this.compressor.connect(ctx.destination);
    
    // Sidechain ducking nodes (pads + synths duck when vocal active)
    this.duckGain = {
      harmonic_pads: ctx.createGain(),
      lead_synths: ctx.createGain()
    };
    this.duckGain.harmonic_pads.gain.value = 1;
    this.duckGain.lead_synths.gain.value = 1;
    this.stems.harmonic_pads.bus.disconnect();
    this.stems.harmonic_pads.bus.connect(this.duckGain.harmonic_pads);
    this.duckGain.harmonic_pads.connect(this.stems.harmonic_pads.pan);
    
    this.stems.lead_synths.bus.disconnect();
    this.stems.lead_synths.bus.connect(this.duckGain.lead_synths);
    this.duckGain.lead_synths.connect(this.stems.lead_synths.pan);
  }
  
  setStemGain(name, value, time) {
    if (!this.stems[name]) return;
    this.stems[name].bus.gain.setTargetAtTime(value, time || this.ctx.currentTime, 0.02);
    this.stems[name].active = value > 0.01;
  }
  
  applyDucking(amount, time) {
    // amount: 0 = no duck, 1 = full duck (-6dB)
    const target = 1 - (amount * 0.5); // -6dB max
    const t = time || this.ctx.currentTime;
    this.duckGain.harmonic_pads.gain.setTargetAtTime(target, t, 0.01);
    this.duckGain.lead_synths.gain.setTargetAtTime(target, t, 0.01);
  }
  
  getMixEnergy() {
    let total = 0;
    for (let name in this.stems) {
      if (this.stems[name].active) total += this.stems[name].bus.gain.value;
    }
    return Math.min(100, (total / 8) * 100);
  }
}

class VocalController {
  constructor(router, ctx) {
    this.router = router;
    this.ctx = ctx;
    this.density = 0.4; // 0-1 (Standard = 40%)
    this.activeTier = null;
    this.lastTrigger = 0;
    
    // Formant definitions for vocal tiers
    this.formants = {
      MELODIC_HOOK: { f1: 800, f2: 1200, f3: 2500, f0: 220 },
      HYPE_STAB: { f1: 600, f2: 1000, f3: 2800, f0: 280 },
      CHOP_STUTTER: { f1: 700, f2: 1100, f3: 2600, f0: 240 },
      AMBIENT_WASH: { f1: 500, f2: 900, f3: 2400, f0: 180 }
    };
  }
  
  setDensity(value) {
    this.density = Math.max(0, Math.min(1, value));
  }
  
  shouldTrigger(tier, splitDelta, cadence, isFinal100m) {
    const now = this.ctx.currentTime;
    if (now - this.lastTrigger < 2) return false; // min 2s between triggers
    
    if (this.density === 0) return false;
    
    const roll = Math.random();
    const threshold = this.density * 0.5; // scale probability by density
    
    switch (tier) {
      case 'MELODIC_HOOK':
        return Math.abs(splitDelta) < 2.0 && roll < threshold;
      case 'HYPE_STAB':
        return (splitDelta < -3.0 || isFinal100m) && roll < threshold * 1.5;
      case 'CHOP_STUTTER':
        return cadence > 170 && roll < threshold * 0.7;
      case 'AMBIENT_WASH':
        return roll < threshold * 0.3;
      default:
        return false;
    }
  }
  
  trigger(tier, time) {
    if (!this.formants[tier]) return;
    const f = this.formants[tier];
    const t = time || this.ctx.currentTime;
    
    // Glottal source (sawtooth)
    const src = this.ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(f.f0 * 1.1, t);
    src.frequency.exponentialRampToValueAtTime(f.f0 * 0.95, t + 0.25);
    
    // Formant bank (3 parallel bandpass filters)
    const formantNodes = [f.f1, f.f2, f.f3].map((freq, i) => {
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 10 - i * 2;
      const g = this.ctx.createGain();
      g.gain.value = [1, 0.6, 0.35][i];
      src.connect(bp);
      bp.connect(g);
      return g;
    });
    
    // Envelope
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.001, t);
    env.gain.linearRampToValueAtTime(0.35, t + 0.015);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    
    formantNodes.forEach(n => n.connect(env));
    env.connect(this.router.stems.vocal_layer.bus);
    
    // Breath noise transient
    const noise = this.ctx.createBufferSource();
    const noiseBuf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.03, this.ctx.sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) {
      noiseData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / noiseData.length, 2);
    }
    noise.buffer = noiseBuf;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.15;
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 1800;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.router.stems.vocal_layer.bus);
    
    src.start(t);
    src.stop(t + 0.3);
    noise.start(t);
    
    // Apply ducking to pads/synths
    this.router.applyDucking(0.7, t);
    setTimeout(() => this.router.applyDucking(0, t + 0.15), 150);
    
    this.activeTier = tier;
    this.lastTrigger = t;
  }
}

class EntropyTracker {
  constructor() {
    this.history = [];
    this.maxRepeats = 3; // 3 cycles = 12 bars
    this.currentConfig = null;
  }
  
  recordConfiguration(stemGains) {
    const config = JSON.stringify(stemGains);
    if (config === this.currentConfig) {
      this.history.push(config);
    } else {
      this.history = [config];
      this.currentConfig = config;
    }
    return this.history.length;
  }
  
  needsVariation() {
    return this.history.length >= this.maxRepeats * 16; // 16 steps per bar
  }
  
  reset() {
    this.history = [];
    this.currentConfig = null;
  }
}

class AdaptiveDJEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.router = new AudioGraphRouter(ctx);
    this.vocal = new VocalController(this.router, ctx);
    this.entropy = new EntropyTracker();
    
    this.state = 'WARMUP'; // WARMUP, DRIVE, APEX, RECOVERY
    this.barCount = 0;
    this.stepCount = 0;
    
    // Telemetry
    this.splitDelta = 0;
    this.cadence = 127;
    this.isFinal100m = false;
    this.stationaryTime = 0;
  }
  
  updateTelemetry(splitDelta, cadence, isFinal100m, gpsSpeed) {
    this.splitDelta = splitDelta;
    this.cadence = cadence;
    this.isFinal100m = isFinal100m;
    
    // Detect stationary
    if (gpsSpeed < 1.0) {
      this.stationaryTime += 0.06; // tick interval
    } else {
      this.stationaryTime = 0;
    }
    
    // State transitions
    const prevState = this.state;
    if (gpsSpeed < 2.0) {
      this.state = 'WARMUP';
    } else if (splitDelta < -3.0 || isFinal100m) {
      this.state = 'APEX';
    } else if (Math.abs(splitDelta) < 1.5 && cadence > 150) {
      this.state = 'DRIVE';
    } else if (splitDelta > 2.0) {
      this.state = 'RECOVERY';
    }
    
    if (prevState !== this.state) {
      this.entropy.reset();
    }
  }
  
  onStep(step, bar) {
    this.stepCount = step;
    if (step === 0) {
      this.barCount = bar;
      this.checkArrangement();
    }
    
    // Vocal triggers
    this.checkVocals(step, bar);
  }
  
  checkArrangement() {
    const stemGains = {};
    for (let name in this.router.stems) {
      stemGains[name] = this.router.stems[name].bus.gain.value;
    }
    
    const repeats = this.entropy.recordConfiguration(stemGains);
    
    if (this.entropy.needsVariation() || this.stationaryTime > 60) {
      this.forceVariation();
    }
    
    // Auto-arrange based on state
    this.applyArrangement();
  }
  
  applyArrangement() {
    const t = this.ctx.currentTime;
    switch (this.state) {
      case 'WARMUP':
        this.router.setStemGain('kick', 0.5, t);
        this.router.setStemGain('snare_clap', 0, t);
        this.router.setStemGain('percussion_tops', 0.6, t);
        this.router.setStemGain('sub_mid_bass', 0.3, t);
        this.router.setStemGain('harmonic_pads', 0.7, t);
        this.router.setStemGain('lead_synths', 0.2, t);
        this.router.setStemGain('vocal_layer', 0.3, t);
        this.router.setStemGain('transition_fx', 0.4, t);
        break;
        
      case 'DRIVE':
        this.router.setStemGain('kick', 0.9, t);
        this.router.setStemGain('snare_clap', 0.8, t);
        this.router.setStemGain('percussion_tops', 0.85, t);
        this.router.setStemGain('sub_mid_bass', 0.8, t);
        this.router.setStemGain('harmonic_pads', 0.6, t);
        this.router.setStemGain('lead_synths', 0.7, t);
        this.router.setStemGain('vocal_layer', 0.5, t);
        this.router.setStemGain('transition_fx', 0.3, t);
        break;
        
      case 'APEX':
        this.router.setStemGain('kick', 1.0, t);
        this.router.setStemGain('snare_clap', 0.95, t);
        this.router.setStemGain('percussion_tops', 1.0, t);
        this.router.setStemGain('sub_mid_bass', 0.9, t);
        this.router.setStemGain('harmonic_pads', 0.5, t);
        this.router.setStemGain('lead_synths', 0.9, t);
        this.router.setStemGain('vocal_layer', 0.8, t);
        this.router.setStemGain('transition_fx', 0.7, t);
        break;
        
      case 'RECOVERY':
        this.router.setStemGain('kick', 0.4, t);
        this.router.setStemGain('snare_clap', 0.3, t);
        this.router.setStemGain('percussion_tops', 0.5, t);
        this.router.setStemGain('sub_mid_bass', 0.2, t);
        this.router.setStemGain('harmonic_pads', 0.9, t);
        this.router.setStemGain('lead_synths', 0.3, t);
        this.router.setStemGain('vocal_layer', 0.2, t);
        this.router.setStemGain('transition_fx', 0.5, t);
        break;
    }
  }
  
  forceVariation() {
    // Swap lead motif or inject fill
    const t = this.ctx.currentTime;
    if (Math.random() < 0.5) {
      // Inject transition FX
      this.triggerFill(t);
    }
    this.entropy.reset();
  }
  
  triggerFill(time) {
    // Riser sweep
    const t = time || this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(2000, t + 1.0);
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(8000, t + 1.0);
    filter.Q.value = 5;
    
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.4, t + 0.9);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.router.stems.transition_fx.bus);
    
    osc.start(t);
    osc.stop(t + 1.1);
  }
  
  checkVocals(step, bar) {
    // Trigger vocals at phrase boundaries
    if (step === 0 && bar % 4 === 0) {
      // Check each tier
      if (this.vocal.shouldTrigger('MELODIC_HOOK', this.splitDelta, this.cadence, this.isFinal100m)) {
        this.vocal.trigger('MELODIC_HOOK');
      } else if (this.vocal.shouldTrigger('HYPE_STAB', this.splitDelta, this.cadence, this.isFinal100m)) {
        this.vocal.trigger('HYPE_STAB');
      } else if (this.vocal.shouldTrigger('CHOP_STUTTER', this.splitDelta, this.cadence, this.isFinal100m)) {
        this.vocal.trigger('CHOP_STUTTER');
      } else if (this.vocal.shouldTrigger('AMBIENT_WASH', this.splitDelta, this.cadence, this.isFinal100m)) {
        this.vocal.trigger('AMBIENT_WASH');
      }
    }
  }
  
  getMixEnergy() {
    return this.router.getMixEnergy();
  }
  
  getArrangementState() {
    return this.state;
  }
}

// Export
if (typeof window !== 'undefined') {
  window.AudioGraphRouter = AudioGraphRouter;
  window.VocalController = VocalController;
  window.EntropyTracker = EntropyTracker;
  window.AdaptiveDJEngine = AdaptiveDJEngine;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AudioGraphRouter, VocalController, EntropyTracker, AdaptiveDJEngine };
}
