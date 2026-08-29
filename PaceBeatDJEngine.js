/**
 * PaceBeatDJEngine - Festival-grade adaptive audio engine
 * 
 * Features:
 * - 4-channel stem mixer (Kick/Sub, Perc, Chords, Accents)
 * - Phrase-quantized transitions (16-beat boundaries)
 * - State machine: BEHIND_PACE, ON_PACE, SURGE
 * - Smooth BPM interpolation (120-175 BPM)
 * - BiquadFilter automation for tension/release
 * - Zero-dependency procedural synthesis
 */

class PaceBeatDJEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.filter = null;
    this.stems = {
      kick: { gain: null, pattern: [], muted: false },
      perc: { gain: null, pattern: [], muted: false },
      chords: { gain: null, pattern: [], muted: false },
      accents: { gain: null, pattern: [], muted: false }
    };
    
    // Timing
    this.bpm = 127;
    this.targetBpm = 127;
    this.nextNoteTime = 0;
    this.current16th = 0;
    this.barCount = 0;
    this.phraseCount = 0;
    this.lookahead = 0.05; // 50ms lookahead
    this.scheduleInterval = null;
    
    // State machine
    this.state = 'ON_PACE';
    this.previousState = 'ON_PACE';
    this.stateTransitionQueued = false;
    this.transitionAtPhrase = 0;
    
    // Runner telemetry
    this.deltaSec = 0;
    this.isSurging = false;
    
    // Patterns (16 steps per bar)
    this.patterns = {
      kick: [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0], // 4-on-the-floor
      perc: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0], // hats on offbeats
      chords: [1,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0], // syncopated
      accents: [0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0] // trumpet on beat 3
    };
    
    // Musical content
    this.chordProgression = [
      [41, 44, 48], // Fm
      [41, 44, 48], // Fm
      [39, 43, 46], // Eb
      [39, 43, 46]  // Eb
    ];
    
    this.bassNotes = [29, 29, 27, 27]; // F1, F1, Eb1, Eb1
    
    // Effects
    this.reverb = null;
    this.delay = null;
    
    this.isPlaying = false;
  }
  
  /**
   * Initialize audio context and routing
   */
  init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    
    // Master chain: stems -> filter -> master -> destination
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'highpass';
    this.filter.frequency.value = 20;
    this.filter.Q.value = 0.7;
    
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8;
    
    this.filter.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
    
    // Create stem gains
    for (let stem in this.stems) {
      this.stems[stem].gain = this.ctx.createGain();
      this.stems[stem].gain.gain.value = 1.0;
      this.stems[stem].gain.connect(this.filter);
    }
    
    // Create effects
    this._createReverb();
    this._createDelay();
    
    return this;
  }
  
  /**
   * Create hall reverb using convolution
   */
  _createReverb() {
    this.reverb = this.ctx.createConvolver();
    const duration = 1.2;
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * duration;
    const impulse = this.ctx.createBuffer(2, length, sampleRate);
    
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
      }
    }
    
    this.reverb.buffer = impulse;
    
    const reverbGain = this.ctx.createGain();
    reverbGain.gain.value = 0.3;
    this.reverb.connect(reverbGain);
    reverbGain.connect(this.filter);
  }
  
  /**
   * Create stereo delay
   */
  _createDelay() {
    this.delay = this.ctx.createDelay(1.0);
    this.delay.delayTime.value = 60 / this.bpm / 4 * 3; // dotted 8th
    
    const feedback = this.ctx.createGain();
    feedback.gain.value = 0.3;
    
    const delayGain = this.ctx.createGain();
    delayGain.gain.value = 0.25;
    
    this.delay.connect(feedback);
    feedback.connect(this.delay);
    this.delay.connect(delayGain);
    delayGain.connect(this.filter);
  }
  
  /**
   * Start the engine
   */
  start() {
    if (this.isPlaying) return;
    
    this.ctx.resume();
    this.isPlaying = true;
    this.nextNoteTime = this.ctx.currentTime;
    
    // Lookahead scheduler (50ms interval)
    this.scheduleInterval = setInterval(() => {
      this._scheduler();
    }, this.lookahead * 1000);
    
    return this;
  }
  
  /**
   * Stop the engine
   */
  stop() {
    if (!this.isPlaying) return;
    
    this.isPlaying = false;
    clearInterval(this.scheduleInterval);
    this.scheduleInterval = null;
    
    return this;
  }
  
  /**
   * Update cadence (SPM) - smoothly interpolates BPM
   * @param {number} spm - Steps per minute
   */
  updateCadence(spm) {
    // Clamp to valid range
    this.targetBpm = Math.max(120, Math.min(175, spm));
    
    // Smooth interpolation over 2 beats
    const transitionTime = 60 / this.bpm * 2;
    this.masterGain.gain.setTargetAtTime(0.8, this.ctx.currentTime, transitionTime / 4);
    
    // Update delay time to match new tempo
    const newDelayTime = 60 / this.targetBpm / 4 * 3;
    this.delay.delayTime.setTargetAtTime(newDelayTime, this.ctx.currentTime, transitionTime / 4);
  }
  
  /**
   * Update runner status - triggers state transitions
   * @param {Object} status - { deltaSec, isSurging }
   */
  setRunnerStatus(status) {
    this.deltaSec = status.deltaSec || 0;
    this.isSurging = status.isSurging || false;
    
    // Determine target state
    let targetState = 'ON_PACE';
    
    if (this.deltaSec > 1.5) {
      targetState = 'BEHIND_PACE';
    } else if (this.deltaSec < -1.0 || this.isSurging) {
      targetState = 'SURGE';
    }
    
    // Queue transition at next phrase boundary
    if (targetState !== this.state && !this.stateTransitionQueued) {
      this.previousState = this.state;
      this.targetState = targetState;
      this.stateTransitionQueued = true;
      this.transitionAtPhrase = this.phraseCount + 1;
    }
  }
  
  /**
   * Trigger trumpet stab accent
   */
  triggerTrumpetStab() {
    const time = this.ctx.currentTime;
    this._playTrumpet(time, 65, 0.4); // F4
  }
  
  /**
   * Lookahead scheduler - called every 50ms
   */
  _scheduler() {
    while (this.nextNoteTime < this.ctx.currentTime + this.lookahead) {
      this._scheduleNote(this.nextNoteTime, this.current16th);
      this._advanceTime();
    }
  }
  
  /**
   * Schedule a single 16th note
   */
  _scheduleNote(time, step) {
    const barStep = step % 16;
    
    // Check for phrase boundary (every 16 steps = 1 bar)
    if (barStep === 0) {
      this.barCount++;
      
      // Check for 4-bar phrase boundary
      if (this.barCount % 4 === 0) {
        this.phraseCount++;
        this._handlePhraseBoundary();
      }
    }
    
    // Smooth BPM interpolation
    if (Math.abs(this.bpm - this.targetBpm) > 0.1) {
      this.bpm += (this.targetBpm - this.bpm) * 0.01;
    }
    
    // Play stem patterns
    if (this.patterns.kick[barStep] && !this.stems.kick.muted) {
      this._playKick(time, 0.9);
      this._playSubBass(time, this.bassNotes[Math.floor(this.barCount / 4) % 4], 0.6);
    }
    
    if (this.patterns.perc[barStep] && !this.stems.perc.muted) {
      this._playHat(time, barStep % 2 === 1, 0.3);
      if (barStep === 4 || barStep === 12) {
        this._playClap(time, 0.5);
      }
    }
    
    if (this.patterns.chords[barStep] && !this.stems.chords.muted) {
      const chordIdx = Math.floor(this.barCount / 4) % 4;
      this._playChord(time, this.chordProgression[chordIdx], 0.15);
    }
    
    if (this.patterns.accents[barStep] && !this.stems.accents.muted) {
      if (this.state === 'SURGE' || this.state === 'ON_PACE') {
        const chordIdx = Math.floor(this.barCount / 4) % 4;
        this._playTrumpet(time, this.chordProgression[chordIdx][0] + 12, 0.3);
      }
    }
  }
  
  /**
   * Handle phrase boundary - execute state transitions
   */
  _handlePhraseBoundary() {
    if (this.stateTransitionQueued && this.phraseCount >= this.transitionAtPhrase) {
      this.state = this.targetState || this.state;
      this.stateTransitionQueued = false;
      this._applyStateTransition();
    }
  }
  
  /**
   * Apply state-specific audio changes
   */
  _applyStateTransition() {
    const time = this.ctx.currentTime;
    const transitionTime = 60 / this.bpm * 4; // 4 beats
    
    switch (this.state) {
      case 'BEHIND_PACE':
        // Highpass sweep up to 600Hz, mute sub-bass, add tension
        this.filter.frequency.setTargetAtTime(600, time, transitionTime);
        this.stems.kick.gain.gain.setTargetAtTime(0.3, time, transitionTime / 2);
        this._triggerSnareRiser(time, transitionTime);
        break;
        
      case 'SURGE':
        // DJ drop - snap filter back, full kick, trumpet accent
        this.filter.frequency.setTargetAtTime(20, time, 0.05);
        this.stems.kick.gain.gain.setTargetAtTime(1.0, time, 0.05);
        this.triggerTrumpetStab();
        break;
        
      case 'ON_PACE':
        // Sustained flow - melodic top-lines, ride cymbals
        this.filter.frequency.setTargetAtTime(20, time, transitionTime);
        this.stems.kick.gain.gain.setTargetAtTime(0.8, time, transitionTime);
        this.stems.chords.gain.gain.setTargetAtTime(1.0, time, transitionTime / 2);
        break;
    }
  }
  
  /**
   * Trigger snare riser roll
   */
  _triggerSnareRiser(startTime, duration) {
    const steps = 16;
    const stepDuration = duration / steps;
    
    for (let i = 0; i < steps; i++) {
      const time = startTime + i * stepDuration;
      const velocity = 0.2 + (i / steps) * 0.6;
      this._playSnare(time, velocity);
    }
  }
  
  /**
   * Advance to next 16th note
   */
  _advanceTime() {
    const secondsPerBeat = 60.0 / this.bpm;
    const secondsPer16th = secondsPerBeat / 4;
    
    this.nextNoteTime += secondsPer16th;
    this.current16th = (this.current16th + 1) % 16;
  }
  
  // ===== Procedural Synthesis Functions =====
  
  _playKick(time, velocity) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.5);
    
    gain.gain.setValueAtTime(velocity, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);
    
    osc.connect(gain);
    gain.connect(this.stems.kick.gain);
    
    osc.start(time);
    osc.stop(time + 0.5);
  }
  
  _playSubBass(time, note, velocity) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.value = this._midiToFreq(note);
    
    gain.gain.setValueAtTime(velocity, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    
    osc.connect(gain);
    gain.connect(this.stems.kick.gain);
    
    osc.start(time);
    osc.stop(time + 0.3);
  }
  
  _playHat(time, open, velocity) {
    const bufferSize = this.ctx.sampleRate * (open ? 0.2 : 0.05);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
    }
    
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    
    source.buffer = buffer;
    filter.type = 'highpass';
    filter.frequency.value = open ? 6000 : 8000;
    
    gain.gain.setValueAtTime(velocity, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + (open ? 0.2 : 0.05));
    
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.stems.perc.gain);
    
    source.start(time);
  }
  
  _playClap(time, velocity) {
    const bufferSize = this.ctx.sampleRate * 0.15;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      const env = Math.pow(1 - i / bufferSize, 2);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    
    source.buffer = buffer;
    filter.type = 'bandpass';
    filter.frequency.value = 1200;
    filter.Q.value = 0.5;
    
    gain.gain.setValueAtTime(velocity, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
    
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.stems.perc.gain);
    
    source.start(time);
  }
  
  _playSnare(time, velocity) {
    const bufferSize = this.ctx.sampleRate * 0.2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      const env = Math.pow(1 - i / bufferSize, 2.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    
    source.buffer = buffer;
    filter.type = 'bandpass';
    filter.frequency.value = 2000;
    filter.Q.value = 0.7;
    
    gain.gain.setValueAtTime(velocity, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
    
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.stems.perc.gain);
    
    source.start(time);
  }
  
  _playChord(time, notes, velocity) {
    notes.forEach((note, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.value = this._midiToFreq(note);
      osc.detune.value = (Math.random() - 0.5) * 10;
      
      gain.gain.setValueAtTime(0.001, time);
      gain.gain.linearRampToValueAtTime(velocity, time + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.4);
      
      osc.connect(gain);
      gain.connect(this.stems.chords.gain);
      gain.connect(this.reverb);
      
      osc.start(time);
      osc.stop(time + 0.4);
    });
  }
  
  _playTrumpet(time, note, velocity) {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    
    osc1.type = 'sawtooth';
    osc1.frequency.value = this._midiToFreq(note);
    
    osc2.type = 'square';
    osc2.frequency.value = this._midiToFreq(note) * 1.005;
    
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, time);
    filter.frequency.exponentialRampToValueAtTime(2400, time + 0.08);
    filter.Q.value = 2.5;
    
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(velocity, time + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.4);
    
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.stems.accents.gain);
    gain.connect(this.reverb);
    gain.connect(this.delay);
    
    osc1.start(time);
    osc2.start(time);
    osc1.stop(time + 0.4);
    osc2.stop(time + 0.4);
  }
  
  _midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
}

// Export for use in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PaceBeatDJEngine;
}
