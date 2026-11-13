const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../public/display-events'),F=require('../public/state-replay-cases');
const {replay}=require('../scripts/replay-display-state');
function harness(){let now=1000000,id=0;const timers=new Map(),changes=[];
 const store=new D.EventStore({now:()=>now,setTimer:(fn,ms)=>{timers.set(++id,{fn,due:now+ms});return id},clearTimer:i=>timers.delete(i),onChange:c=>changes.push(c)});
 return {store,changes,get now(){return now},advance(ms){now+=ms;for(const [i,t] of [...timers])if(t.due<=now){timers.delete(i);t.fn();}},records(){return [...store.events.values()].map(e=>({id:e.id,displayKind:e.kind,disasterCategoryNo:e.report.disaster_category_no,jalertKey:e.kind==='jalert'?e.id:null,expiresAt:e.expiresAt,firstReceivedAt:e.firstReceivedAt}));}};}
for(const c of F.cases)test(c.name,()=>assert.ok(replay(c).length));
test('same phase correction changes area and epicenter but cannot extend first phase deadline',()=>{
 const h=harness();h.store.receive(F.quake('a',1));const first=[...h.store.events.values()][0];h.advance(300000);
 h.store.receive({...F.quake('a',1),raw:'corrected',seismic_epicenter_raw:351,eew_forecast_regions_raw:[28]});
 const next=[...h.store.events.values()][0];assert.equal(next.id,first.id);assert.equal(next.expiresAt,first.expiresAt);assert.equal(next.report.seismic_epicenter_raw,351);
 h.advance(300000);assert.equal(h.store.events.size,0);h.store.receive(F.quake('a',1));assert.equal(h.store.events.size,0);
});
test('each phase first reception starts ten minutes and cannot return to earlier phases',()=>{
 const h=harness();h.store.receive(F.quake('a',1));h.advance(120000);h.store.receive(F.quake('a',2));h.advance(120000);h.store.receive(F.quake('a',3));
 let e=[...h.store.events.values()][0];assert.equal(e.firstReceivedAt,1000000);assert.equal(e.phaseFirstReceivedAt,1240000);assert.equal(e.expiresAt,1840000);
 h.store.receive(F.quake('a',1));assert.equal([...h.store.events.values()][0].phase,'intensity');h.advance(600000);assert.equal(h.store.events.size,0);
});
test('multiple EEWs remain visible, and waiting intensity rotates only after all EEWs finish',()=>{
 const h=harness(),c=new D.ViewCycle();h.store.receive(F.quake('a',1));h.store.receive(F.quake('b',1));assert.equal(c.select(h.records(),h.now).length,2);
 h.store.receive(F.quake('a',3));let view=c.select(h.records(),h.now);assert.equal(view.length,1);assert.equal(view[0].disasterCategoryNo,1);
 h.store.receive(F.quake('b',3));const one=c.select(h.records(),h.now)[0].id;h.advance(10000);assert.notEqual(c.select(h.records(),h.now)[0].id,one);
});
test('three earthquakes rotate every ten seconds without an empty Japan pause',()=>{
 const h=harness(),c=new D.ViewCycle();for(const name of ['a','b','c'])h.store.receive({...F.quake('a',3),occurrence_time_of_earthquake:name});
 const seen=[];for(let i=0;i<4;i++){seen.push(c.select(h.records(),h.now)[0].id);h.advance(10000);}assert.equal(new Set(seen.slice(0,3)).size,3);assert.equal(seen[0],seen[3]);
});
test('warnings update their own last receipt and targeted cancellation keeps another coast',()=>{
 const h=harness();h.store.receive({...F.tsunami('a'),tsunami_forecast_regions_raw:[380,210],tsunami_forecast_regions:['静岡県','宮城県']});h.advance(300000);
 h.store.receive({...F.tsunami('a'),tsunami_warning_code_raw:4});h.store.receive(F.jalert);const before=[...h.store.events.values()];
 assert.equal(before.find(e=>e.report.tsunami_forecast_regions_raw?.[0]===380).expiresAt,2500000);
 assert.equal(before.find(e=>e.report.tsunami_forecast_regions_raw?.[0]===210).expiresAt,2200000);
 h.store.receive({...F.tsunami('a'),information_type_no:2});assert.equal(h.store.events.size,2);h.advance(900000);assert.equal(h.store.events.size,1);h.advance(300000);assert.equal(h.store.events.size,0);
});
test('cancel removes only matching earthquake; unknown cancellation is ignored',()=>{
 const h=harness();h.store.receive(F.quake('a',3));h.store.receive(F.quake('b',1));h.store.receive({disaster_category_no:1,information_type_no:2});assert.equal(h.store.events.size,2);
 h.store.receive({...F.quake('a',1),information_type_no:2});assert.equal(h.store.events.size,1);assert.equal([...h.store.events.values()][0].report.seismic_epicenter_raw,700);
});
test('ambiguous or missing identity never merges separate active candidates',()=>{
 const h=harness();h.store.receive(F.quake('a',1));h.store.receive({...F.quake('a',1),occurrence_time_of_earthquake:'other'});
 h.store.receive({...F.quake('a',2),occurrence_time_of_earthquake:null});assert.equal(h.store.events.size,3);
 const k=harness();k.store.receive(F.quake('a',1));k.store.receive({...F.quake('a',3),occurrence_time_of_earthquake:null});assert.equal(k.store.events.size,1);assert.equal([...k.store.events.values()][0].phase,'intensity');
});
test('replay restores only remaining lifetime; training/test cancels cannot clear live events',()=>{
 const h=harness();h.store.receive({...F.quake('a',3),replay_age_ms:599000});h.store.receive({...F.quake('a',1),is_test_data:true,information_type_no:2});assert.equal(h.store.events.size,1);h.advance(1000);assert.equal(h.store.events.size,0);
 const j=harness();j.store.receive({...F.jalert,replay_age_ms:1199000});j.advance(1000);assert.equal(j.store.events.size,0);
});
test('J-alert target update with same onset replaces its region and all-clear is immediate',()=>{
 const h=harness();h.store.receive(F.jalert);h.advance(300000);h.store.receive({...F.jalert,ex9_target_area_list_ja:['東京都']});assert.equal(h.store.events.size,1);assert.deepEqual([...h.store.events.values()][0].report.ex9_target_area_list_ja,['東京都']);h.store.receive({...F.jalert,a1_message_type:'All Clear'});assert.equal(h.store.events.size,0);
});


test('live display phase age does not label actual fresh reception as a replay',()=>{
 const h=harness();const report={...F.quake('a',1),replay_age_ms:0,display_phase_age_ms:590000,display_first_received_age_ms:590000,display_last_received_age_ms:0};
 h.store.receive(report);assert.equal([...h.store.events.values()][0].expiresAt,h.now+10000);
 assert.equal([...h.store.events.values()][0].lastReceivedAt,h.now);
 assert.equal(require('../public/report-ttl').remainingTtlMsForReport(report),10000);
});
test('all-clear without onset matches only one warning with the same hazard and region',()=>{
 const h=harness();h.store.receive(F.jalert);const cancel={...F.jalert,a1_message_type:'All Clear'};delete cancel.a6a7_hazard_onset_datetime;h.store.receive(cancel);assert.equal(h.store.events.size,0);
});
