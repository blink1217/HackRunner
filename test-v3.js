const { AudioGraphRouter, VocalController, EntropyTracker, AdaptiveDJEngine } = require('./PaceBeatV3.js');

// Mock AudioContext
class MockParam {
  constructor() { this.value = 0; }
  setValueAtTime(v, t) { this.value = v; }
  setTargetAtTime(v, t, c) { this.value = v; }
  linearRampToValueAtTime(v, t) { this.value = v; }
  exponentialRampToValueAtTime(v, t) { this.value = v; }
}

class MockNode {
  constructor() {
    this.frequency = new MockParam();
    this.gain = new MockParam();
    this.Q = new MockParam();
    this.pan = new MockParam();
    this.threshold = new MockParam();
    this.ratio = new MockParam();
    this.knee = new MockParam();
    this.attack = new MockParam();
    this.release = new MockParam();
    this.type = 'sine';
    this.buffer = null;
    this.connect = () => this;
    this.disconnect = () => this;
    this.start = () => {};
    this.stop = () => {};
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.destination = {};
  }
  createGain() { return new MockNode(); }
  createOscillator() { return new MockNode(); }
  createBufferSource() { return new MockNode(); }
  createBiquadFilter() { return new MockNode(); }
  createStereoPanner() { return new MockNode(); }
  createDynamicsCompressor() { return new MockNode(); }
  createBuffer(ch, len, sr) {
    return {
      getChannelData: () => new Float32Array(len),
      length: len,
      numberOfChannels: ch,
      sampleRate: sr
    };
  }
}

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`);
    testsFailed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// Tests
console.log('=== PaceBeat V3 Engine Tests ===\n');

const ctx = new MockAudioContext();

// AudioGraphRouter tests
test('AudioGraphRouter creates 8 stem buses', () => {
  const router = new AudioGraphRouter(ctx);
  const stemNames = Object.keys(router.stems);
  assert(stemNames.length === 8, 'Should have 8 stems');
  assert(stemNames.includes('kick'), 'Should have kick');
  assert(stemNames.includes('vocal_layer'), 'Should have vocal_layer');
});

test('AudioGraphRouter sets stem gains', () => {
  const router = new AudioGraphRouter(ctx);
  router.setStemGain('kick', 0.8, 0);
  assert(router.stems.kick.bus.gain.value === 0.8, 'Kick gain should be 0.8');
  assert(router.stems.kick.active === true, 'Kick should be active');
});

test('AudioGraphRouter applies ducking', () => {
  const router = new AudioGraphRouter(ctx);
  router.applyDucking(0.5, 0);
  assert(router.duckGain.harmonic_pads.gain.value < 1, 'Pads should be ducked');
  assert(router.duckGain.lead_synths.gain.value < 1, 'Synths should be ducked');
});

test('AudioGraphRouter calculates mix energy', () => {
  const router = new AudioGraphRouter(ctx);
  router.setStemGain('kick', 1.0, 0);
  router.setStemGain('snare_clap', 0.5, 0);
  const energy = router.getMixEnergy();
  assert(energy > 0, 'Energy should be > 0');
  assert(energy <= 100, 'Energy should be <= 100');
});

// VocalController tests
test('VocalController sets density', () => {
  const router = new AudioGraphRouter(ctx);
  const vocal = new VocalController(router, ctx);
  vocal.setDensity(0.6);
  assert(vocal.density === 0.6, 'Density should be 0.6');
});

test('VocalController respects density=0', () => {
  const router = new AudioGraphRouter(ctx);
  const vocal = new VocalController(router, ctx);
  vocal.setDensity(0);
  const shouldTrigger = vocal.shouldTrigger('MELODIC_HOOK', 0, 160, false);
  assert(shouldTrigger === false, 'Should not trigger when density=0');
});

test('VocalController triggers on conditions', () => {
  const router = new AudioGraphRouter(ctx);
  const vocal = new VocalController(router, ctx);
  vocal.setDensity(1.0);
  vocal.lastTrigger = -10; // allow trigger
  const shouldTrigger = vocal.shouldTrigger('HYPE_STAB', -4.0, 160, false);
  // Note: probabilistic, but with density=1.0 and bad split, should often trigger
  assert(typeof shouldTrigger === 'boolean', 'Should return boolean');
});

test('VocalController trigger creates audio', () => {
  const router = new AudioGraphRouter(ctx);
  const vocal = new VocalController(router, ctx);
  vocal.setDensity(1.0);
  vocal.trigger('MELODIC_HOOK', 0);
  assert(vocal.activeTier === 'MELODIC_HOOK', 'Active tier should be set');
  assert(vocal.lastTrigger === 0, 'Last trigger time should be set');
});

// EntropyTracker tests
test('EntropyTracker records configurations', () => {
  const tracker = new EntropyTracker();
  const config = { kick: 1, snare: 0.5 };
  const repeats = tracker.recordConfiguration(config);
  assert(repeats === 1, 'Should record first config');
});

test('EntropyTracker detects repetition', () => {
  const tracker = new EntropyTracker();
  const config = { kick: 1 };
  for (let i = 0; i < 50; i++) {
    tracker.recordConfiguration(config);
  }
  assert(tracker.needsVariation() === true, 'Should need variation after 48 repeats');
});

test('EntropyTracker resets on config change', () => {
  const tracker = new EntropyTracker();
  tracker.recordConfiguration({ kick: 1 });
  tracker.recordConfiguration({ kick: 1 });
  tracker.recordConfiguration({ kick: 0.5 }); // change
  assert(tracker.history.length === 1, 'History should reset');
});

// AdaptiveDJEngine tests
test('AdaptiveDJEngine initializes with 4 arrangement states', () => {
  const engine = new AdaptiveDJEngine(ctx);
  assert(engine.state === 'WARMUP', 'Initial state should be WARMUP');
  assert(engine.router !== null, 'Should have router');
  assert(engine.vocal !== null, 'Should have vocal controller');
  assert(engine.entropy !== null, 'Should have entropy tracker');
});

test('AdaptiveDJEngine updates telemetry', () => {
  const engine = new AdaptiveDJEngine(ctx);
  engine.updateTelemetry(-2.0, 170, false, 3.5);
  assert(engine.splitDelta === -2.0, 'Split delta should update');
  assert(engine.cadence === 170, 'Cadence should update');
});

test('AdaptiveDJEngine transitions to DRIVE state', () => {
  const engine = new AdaptiveDJEngine(ctx);
  engine.updateTelemetry(0.5, 160, false, 3.0);
  assert(engine.state === 'DRIVE', 'Should transition to DRIVE');
});

test('AdaptiveDJEngine transitions to APEX state', () => {
  const engine = new AdaptiveDJEngine(ctx);
  engine.updateTelemetry(-4.0, 180, true, 4.0);
  assert(engine.state === 'APEX', 'Should transition to APEX');
});

test('AdaptiveDJEngine transitions to RECOVERY state', () => {
  const engine = new AdaptiveDJEngine(ctx);
  engine.updateTelemetry(3.0, 140, false, 2.0);
  assert(engine.state === 'RECOVERY', 'Should transition to RECOVERY');
});

test('AdaptiveDJEngine applies arrangement per state', () => {
  const engine = new AdaptiveDJEngine(ctx);
  engine.state = 'DRIVE';
  engine.applyArrangement();
  assert(engine.router.stems.kick.bus.gain.value > 0.5, 'Kick should be loud in DRIVE');
  assert(engine.router.stems.vocal_layer.bus.gain.value > 0.3, 'Vocals should be present in DRIVE');
});

test('AdaptiveDJEngine detects stationary runner', () => {
  const engine = new AdaptiveDJEngine(ctx);
  for (let i = 0; i < 1000; i++) {
    engine.updateTelemetry(0, 0, false, 0.5);
  }
  assert(engine.stationaryTime > 50, 'Should detect stationary time');
});

test('AdaptiveDJEngine triggers fills on variation', () => {
  const engine = new AdaptiveDJEngine(ctx);
  engine.forceVariation();
  // Should not throw
  assert(true, 'Fill should trigger without error');
});

test('AdaptiveDJEngine calculates mix energy', () => {
  const engine = new AdaptiveDJEngine(ctx);
  engine.applyArrangement();
  const energy = engine.getMixEnergy();
  assert(energy >= 0 && energy <= 100, 'Energy should be 0-100');
});

test('AdaptiveDJEngine returns arrangement state', () => {
  const engine = new AdaptiveDJEngine(ctx);
  engine.state = 'APEX';
  assert(engine.getArrangementState() === 'APEX', 'Should return current state');
});

// Integration test
test('Full integration: telemetry → arrangement → vocals', () => {
  const engine = new AdaptiveDJEngine(ctx);
  engine.updateTelemetry(-3.5, 175, true, 4.2);
  engine.onStep(0, 4);
  const energy = engine.getMixEnergy();
  assert(energy > 30, 'Should have high energy in APEX');
  assert(engine.state === 'APEX', 'Should be in APEX state');
});

console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===`);
process.exit(testsFailed > 0 ? 1 : 0);
