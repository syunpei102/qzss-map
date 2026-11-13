#!/usr/bin/env node
// ローカルの純粋モデルだけで再生する．ネットワーク接続・本番送信なし．
const assert=require('node:assert/strict');
const {EventStore,ViewCycle}=require('../public/display-events');
const fixtures=require('../public/state-replay-cases');
function replay(test){
 let now=1000000;const timers=new Map();let serial=0;
 const store=new EventStore({now:()=>now,setTimer:(fn,ms)=>{const id=++serial;timers.set(id,{fn,due:now+ms});return id;},clearTimer:id=>timers.delete(id)});
 const cycle=new ViewCycle();
 const records=()=>[...store.events.values()].map(e=>({id:e.id,displayKind:e.kind,disasterCategoryNo:e.report.disaster_category_no,jalertKey:e.kind==='jalert'?e.id:null,expiresAt:e.expiresAt,firstReceivedAt:e.firstReceivedAt}));
 const frames=[];
 for(const step of test.steps){now=1000000+step.at;store.receive(step.report);const selected=cycle.select(records(),now);
  frames.push({at:step.at,stored:[...store.events.values()].map(e=>e.kind+':'+e.phase),visible:selected.map(r=>r.displayKind+':'+(r.disasterCategoryNo || 'jalert'))});}
 const final=[...store.events.values()];
 const earthquakes=final.filter(e=>e.kind==='earthquake');
 if(['case2','case3','case4','case5','case6'].includes(test.id))assert.equal(earthquakes.length,2);
 if(['case2','case4','case5'].includes(test.id))assert.equal(cycle.select(records(),now).filter(r=>r.displayKind==='earthquake').length,1);
 if(test.id==='case3'){const first=cycle.select(records(),now).find(r=>r.displayKind==='earthquake').id;now+=10000;assert.notEqual(cycle.select(records(),now).find(r=>r.displayKind==='earthquake').id,first);}
 if(test.id==='case6')assert.equal(final.filter(e=>e.kind==='tsunami').length,2);
 if(test.id==='case1')assert.deepEqual(earthquakes.map(e=>e.phase),['intensity']);
 return frames;
}
if(require.main===module){for(const test of fixtures.cases.filter(c=>!process.argv[2]||c.id===process.argv[2]))console.log(test.name,JSON.stringify(replay(test),null,2));}
module.exports={replay};
