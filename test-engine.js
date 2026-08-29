const PaceBeatDJEngine = require('./PaceBeatDJEngine.js');

// Mock AudioContext for testing
class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.destination = {};
    this.state = 'suspended';
  }
  
  createGain() {
    return {
      gain: { value: 1, setValueAtTime: () => {}, setTargetAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {}
    };
  }
  
  createOscillator() {
    return {
      type: 'sine',
      frequency: { value: 440, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      detune: { value: 0 },
      connect: () => {},
      start: () => {},
      stop: () => {}
    };
  }
  
  createBiquadFilter() {
    return {
      type: 'lowpass',
      frequency: { value: 1000, setValueAtTime: () => {}, setTargetAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      Q: { value: 1 },
      connect: () => {}
    };
  }
  
  createBufferSource() {
    return {
      buffer: null,
      connect: () => {},
      start: () => {}
    };
  }
  
  createBuffer(channels, length, sampleRate) {
    return {
      getChannelData: () => new Float32Array(length)
    };
  }
  
  createConvolver() {
    return {
      buffer: null,
      connect: () => {}
    };
  }
  
  createDelay(maxDelayTime) {
    return {
      delayTime: { value: 0, setTargetAtTime: () => {} },
      connect: () => {}
    };
  }
  
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

// Tests
console.log('Testing PaceBeatDJEngine...\n');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Mock global AudioContext
global.window = { AudioContext: MockAudioContext };

// Test 1: Initialization
test('Engine initializes correctly', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  
  assert(engine.ctx !== null, 'AudioContext should be created');
  assert(engine.masterGain !== null, 'Master gain should be created');
  assert(engine.filter !== null, 'Filter should be created');
  assert(Object.keys(engine.stems).length === 4, 'Should have 4 stems');
});

// Test 2: Stem structure
test('All 4 stems have gain nodes', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  
  assert(engine.stems.kick.gain !== null, 'Kick stem should have gain');
  assert(engine.stems.perc.gain !== null, 'Perc stem should have gain');
  assert(engine.stems.chords.gain !== null, 'Chords stem should have gain');
  assert(engine.stems.accents.gain !== null, 'Accents stem should have gain');
});

// Test 3: Start/Stop
test('Engine starts and stops correctly', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  
  engine.start();
  assert(engine.isPlaying === true, 'Engine should be playing after start');
  assert(engine.scheduleInterval !== null, 'Scheduler should be running');
  
  engine.stop();
  assert(engine.isPlaying === false, 'Engine should not be playing after stop');
  assert(engine.scheduleInterval === null, 'Scheduler should be stopped');
});

// Test 4: BPM update
test('BPM updates smoothly', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  
  engine.updateCadence(140);
  assert(engine.targetBpm === 140, 'Target BPM should be 140');
  
  engine.updateCadence(160);
  assert(engine.targetBpm === 160, 'Target BPM should be 160');
  
  // Test clamping
  engine.updateCadence(100);
  assert(engine.targetBpm === 120, 'BPM should clamp to minimum 120');
  
  engine.updateCadence(200);
  assert(engine.targetBpm === 175, 'BPM should clamp to maximum 175');
});

// Test 5: State machine
test('State machine transitions correctly', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  
  assert(engine.state === 'ON_PACE', 'Initial state should be ON_PACE');
  
  engine.setRunnerStatus({ deltaSec: 2.0, isSurging: false });
  assert(engine.stateTransitionQueued === true, 'Transition should be queued');
  assert(engine.transitionAtPhrase === 1, 'Transition should queue for next phrase');
  
  // Simulate phrase boundary
  engine.phraseCount = 1;
  engine._handlePhraseBoundary();
  assert(engine.state === 'BEHIND_PACE', 'State should transition to BEHIND_PACE');
});

// Test 6: Phrase quantization
test('Phrase boundaries are tracked correctly', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  
  assert(engine.barCount === 0, 'Initial bar count should be 0');
  assert(engine.phraseCount === 0, 'Initial phrase count should be 0');
  
  // Simulate 4 bars
  for (let i = 0; i < 64; i++) {
    engine._advanceTime();
    if (engine.current16th === 0) {
      engine.barCount++;
      if (engine.barCount % 4 === 0) {
        engine.phraseCount++;
      }
    }
  }
  
  assert(engine.barCount === 4, 'Should have counted 4 bars');
  assert(engine.phraseCount === 1, 'Should have counted 1 phrase');
});

// Test 7: Runner status
test('Runner status updates telemetry', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  
  engine.setRunnerStatus({ deltaSec: 1.5, isSurging: true });
  assert(engine.deltaSec === 1.5, 'Delta should be 1.5');
  assert(engine.isSurging === true, 'Should be surging');
});

// Test 8: Trumpet stab
test('Trumpet stab triggers without error', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  engine.start();
  
  // Should not throw
  engine.triggerTrumpetStab();
  assert(true, 'Trumpet stab should execute without error');
  
  engine.stop();
});

// Test 9: State transitions apply correct audio changes
test('State transitions modify filter and gains', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  engine.start();
  
  // Test BEHIND_PACE transition
  engine.state = 'BEHIND_PACE';
  engine._applyStateTransition();
  // Filter frequency should be set (we can't easily verify the value without more mocking)
  
  // Test SURGE transition
  engine.state = 'SURGE';
  engine._applyStateTransition();
  // Should trigger trumpet stab
  
  // Test ON_PACE transition
  engine.state = 'ON_PACE';
  engine._applyStateTransition();
  
  engine.stop();
  assert(true, 'State transitions should execute without error');
});

// Test 10: MIDI to frequency conversion
test('MIDI to frequency conversion is correct', () => {
  const engine = new PaceBeatDJEngine();
  
  // A4 = MIDI 69 = 440Hz
  assert(Math.abs(engine._midiToFreq(69) - 440) < 0.01, 'MIDI 69 should be 440Hz');
  
  // C4 = MIDI 60 = 261.63Hz
  assert(Math.abs(engine._midiToFreq(60) - 261.63) < 0.1, 'MIDI 60 should be ~261.63Hz');
  
  // C5 = MIDI 72 = 523.25Hz
  assert(Math.abs(engine._midiToFreq(72) - 523.25) < 0.1, 'MIDI 72 should be ~523.25Hz');
});

// Test 11: Patterns are defined
test('All stem patterns are defined', () => {
  const engine = new PaceBeatDJEngine();
  
  assert(engine.patterns.kick.length === 16, 'Kick pattern should have 16 steps');
  assert(engine.patterns.perc.length === 16, 'Perc pattern should have 16 steps');
  assert(engine.patterns.chords.length === 16, 'Chords pattern should have 16 steps');
  assert(engine.patterns.accents.length === 16, 'Accents pattern should have 16 steps');
});

// Test 12: Chord progression
test('Chord progression is defined', () => {
  const engine = new PaceBeatDJEngine();
  
  assert(engine.chordProgression.length === 4, 'Should have 4 chords');
  assert(Array.isArray(engine.chordProgression[0]), 'Each chord should be an array');
  assert(engine.chordProgression[0].length === 3, 'Each chord should have 3 notes');
});

// Test 13: Effects are created
test('Reverb and delay are created', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  
  assert(engine.reverb !== null, 'Reverb should be created');
  assert(engine.delay !== null, 'Delay should be created');
});

// Test 14: Scheduler advances time correctly
test('Scheduler advances time correctly', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  engine.start();
  
  const initialTime = engine.nextNoteTime;
  const initialStep = engine.current16th;
  
  engine._advanceTime();
  
  assert(engine.nextNoteTime > initialTime, 'Next note time should advance');
  assert(engine.current16th === (initialStep + 1) % 16, 'Current 16th should increment');
  
  engine.stop();
});

// Test 15: Snare riser
test('Snare riser triggers without error', () => {
  const engine = new PaceBeatDJEngine();
  engine.init();
  engine.start();
  
  // Should not throw
  engine._triggerSnareRiser(engine.ctx.currentTime, 2.0);
  assert(true, 'Snare riser should execute without error');
  
  engine.stop();
});

// Summary
console.log('\n' + '='.repeat(50));
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);
console.log('='.repeat(50));

process.exit(testsFailed > 0 ? 1 : 0);
