const { HRVTracker, ResonanceBreath, RecoveryEngine, RecoveryMusic } = require('./PaceBeatRecovery.js');

class MockParam { constructor(){ this.value=0; } setValueAtTime(v){ this.value=v; } setTargetAtTime(v){ this.value=v; } exponentialRampToValueAtTime(v){ this.value=v; } linearRampToValueAtTime(v){ this.value=v; } }
class MockNode { constructor(){ ['frequency','gain','Q','pan','detune'].forEach(k=>this[k]=new MockParam()); this.type='sine'; this.buffer=null; this.connect=()=>this; this.start=()=>{}; this.stop=()=>{}; } }
class MockCtx { constructor(){ this.currentTime=0; this.sampleRate=44100; this.destination={}; } createGain(){ return new MockNode(); } createOscillator(){ return new MockNode(); } createBiquadFilter(){ return new MockNode(); } createBuffer(ch,len){ return { getChannelData:()=>new Float32Array(len) }; } createBufferSource(){ return new MockNode(); } }

let P=0, F=0;
function t(n,c){ try{ c(); console.log('  PASS',n); P++; }catch(e){ console.log('  FAIL',n,'—',e.message); F++; } }
function a(c,m){ if(!c) throw new Error(m||'assert'); }

console.log('=== Recovery Engine Tests ===\n');

t('HRVTracker parses BLE R-R from heart_rate_measurement', ()=>{
  const h=new HRVTracker();
  // flags: bit0=0 (8bit HR), bit4=1 (RR present) → 0x10
  const dv={ getUint8:o=> o===0? 0x10 : 150, getUint16:(o,l)=> o===1? 150 : 989 }; // flags@0, HR150@1, RR@2
  const r=h.feedHRM(dv);
  a(r.hr===150); a(r.rr!==null); a(Math.abs(r.rr-965.8)<1.5);
});

t('HRVTracker rejects out-of-range R-R (artefact rejection)', ()=>{
  const h=new HRVTracker();
  h.push(150, 25000); // 25s — artefact
  a(h.rr.length===0, 'should reject');
  h.push(150, 900);
  a(h.rr.length===1);
});

t('RMSSD computation correct on known sequence', ()=>{
  const h=new HRVTracker();
  // synthetic: RR diffs all 30ms → RMSSD=30
  const base=Date.now();
  [900,930,900,930,900,930,900].forEach((v,i)=> h.rr.push({t:base+i*900, v}));
  h._compute();
  a(Math.abs(h.rmssd-30)<0.5, 'got '+h.rmssd);
});

t('HR decay rate calculation', ()=>{
  const h=new HRVTracker();
  const now=Date.now();
  for(let i=0;i<30;i++) h.hr.push({t:now-(30-i)*2000, v: 150 - i*0.5}); // -0.5bpm/2s = 15bpm/min
  a(Math.abs(h.hrDecayPerMin()-15)<0.5, 'got '+h.hrDecayPerMin());
});

t('Readiness scores 0 without data, bounded 0-100 with data', ()=>{
  const h=new HRVTracker();
  a(h.readiness()===0);
  const now=Date.now();
  for(let i=0;i<30;i++) h.hr.push({t:now-(30-i)*2000, v:55});
  for(let i=0;i<20;i++) h.rr.push({t:now-i*900, v: i%2? 930:900});
  h._compute();
  const r=h.readiness();
  a(r>50&&r<=100, 'got '+r);
});

t('ResonanceBreath: 6 breaths/min curve', ()=>{
  const b=new ResonanceBreath();
  a(b.value(0)===0);
  a(Math.abs(b.value(5500)-1)<0.01, 'peak at 5.5s (inhale end)');
  a(Math.abs(b.value(10000)-0)<0.01, 'returns to 0 at cycle end');
  a(b.inhaling(2000)===true && b.inhaling(8000)===false);
});

t('RecoveryEngine state machine: ACTIVE → COOLDOWN → DEEP_RECOVERY → READY', ()=>{
  const e=new RecoveryEngine();
  a(e.state==='ACTIVE');
  e.update(165, true, 3.5);
  a(e.state==='ACTIVE');
  e.update(140, false, 0.5);
  a(e.state==='COOLDOWN', 'got '+e.state);
  e.update(90, false, 0.2);
  a(e.state==='DEEP_RECOVERY', 'got '+e.state);
  e.update(60, false, 0.1);
  a(e.state==='READY', 'got '+e.state);
});

t('Recovery speed metric tracks HR fall', ()=>{
  const e=new RecoveryEngine();
  e.update(130,false,0);        // COOLDOWN, baseline set
  e.stateSince=Date.now()-60000; // pretend 1 min passed
  e.hrv.hr=[];
  for(let i=0;i<10;i++) e.hrv.hr.push({t:Date.now()-(10-i)*6000, v:110});
  e.update(110,false,0);
  const s=e.recoverySpeed();
  a(s!==null && s>0, 'got '+s);
});

t('Sauna protocol: start/progress/auto-end', ()=>{
  const e=new RecoveryEngine();
  e.startSauna(15);
  a(e.state==='SAUNA' || e.state==='DEEP_RECOVERY'); // endSauna may have fired if hr high
  e.startSauna(15);
  a(e.sauna!==null);
  a(e.saunaRemaining()<=15 && e.saunaRemaining()>14.9);
  e.sauna.startedAt=Date.now()-16*60000; // force expiry
  e.update(95,false,0);
  a(e.sauna===null, 'auto-ended');
});

t('HR safety: sauna auto-ends at HR>130', ()=>{
  const e=new RecoveryEngine();
  e.startSauna(15);
  e.update(135,false,0);
  a(e.sauna===null, 'safety end');
});

t('RecoveryMusic schedules at 62 BPM without errors', ()=>{
  const ctx=new MockCtx();
  const dest=new MockNode();
  const m=new RecoveryMusic(ctx, dest);
  m.start();
  for(let i=0;i<12;i++){ ctx.currentTime+=0.05; m._schedule(); }
  a(m.playing===true);
  m.stop();
  a(m.playing===false);
});

t('Baseline RMSSD learns upward (EMA)', ()=>{
  const h=new HRVTracker();
  const now=Date.now();
  let t0=now-40000;
  [900,930,900,930,900,930,900].forEach(v=>{ h.rr.push({t:t0,v}); t0+=900; });
  h._compute();
  const b0=h.baselineRmssd;
  [960,990,960,990,960,990,960].forEach(v=>{ h.rr.push({t:t0,v}); t0+=900; });
  h._compute();
  a(h.baselineRmssd>b0, 'baseline should rise toward better RMSSD: '+b0+'→'+h.baselineRmssd);
});

console.log(`\n${P} passed, ${F} failed`);
process.exit(F?1:0);
