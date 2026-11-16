'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {features}=require('../ops/infrastructure-view');
const {sanitize}=require('../ops/telemetry');
const now=1794821000000;
function data(state='running',service='active'){return {at:now,hosts:{server:{stale:false,latest:{at:now,services:{backgroundCompute:service},backgroundCompute:{at:now,state,reason:state==='paused'?'foreground-cpu':null}}}}};}
test('background work reports actual running/paused/stopped and rejects stale status',()=>{
 const feature=d=>features(d,'server').find(f=>f.name==='回収防止処理');
 a.equal(feature(data()).label,'動作中');a.equal(feature(data('paused')).label,'停止中');a.equal(feature(data('running','inactive')).label,'停止中');
 const stale=data();stale.hosts.server.latest.backgroundCompute.at-=50000;a.equal(feature(stale).label,'要確認');
 const unknown=data();unknown.hosts.server.stale=true;a.equal(feature(unknown).label,'要確認');
 a.match(feature(data()).note,/保証するものではありません/);
});
test('telemetry keeps only safe background status fields',()=>{
 const s=sanitize('server',{backgroundCompute:{at:now,state:'running',reason:'secret path',rounds:1,workerCpuSeconds:2,lastPause:{at:now,reason:'foreground-cpu',foregroundCpuPct:26,secret:'credential'},limits:{targetCpuPct:30,secret:'credential'},secret:'credential'},services:{backgroundCompute:'active'}},now);
 a.equal(s.backgroundCompute.state,'running');a.equal(s.backgroundCompute.reason,null);a.equal(s.backgroundCompute.secret,undefined);a.equal(s.services.backgroundCompute,'active');a.equal(s.backgroundCompute.lastPause.foregroundCpuPct,26);a.equal(s.backgroundCompute.lastPause.secret,undefined);a.equal(s.backgroundCompute.limits.targetCpuPct,30);a.equal(s.backgroundCompute.limits.secret,undefined);
});
