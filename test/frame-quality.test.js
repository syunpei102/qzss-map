const {test}=require('node:test'),a=require('node:assert/strict'),{summarize}=require('../ops/frame-quality');
const at=2000000000000;
function rows(){return Array.from({length:5},(_,i)=>({at:at+i*60000,encoder:{frames:i*900,dropped:[0,30,50,60,65][i],duplicated:i*20}}));}
test('recent windows show improvement despite increasing lifetime totals',()=>{const r=rows(),q=summarize(r.slice(0,-1),r.at(-1),r.at(-1).at);a.equal(q.current.dropped,5);a.equal(q.current.duplicated,20);a.equal(q.previous.dropped,10);a.match(q.trend,/減少/);});
test('encoder reset，missing samples and stale monitoring are not reported as improvement',()=>{const r=rows();r.at(-1).encoder.dropped=1;a.equal(summarize(r, r.at(-1),r.at(-1).at).current,null);a.equal(summarize(rows().slice(0,1),rows()[4],rows()[4].at).current,null);a.equal(summarize(rows(),rows()[4],at+999999).state,'stale');});
test('counter window uses actual interval rather than assuming exact collection rate',()=>{const r=[{at,encoder:{dropped:100,duplicated:50}},{at:at+75000,encoder:{dropped:115,duplicated:55}}],q=summarize(r,r[1],r[1].at);a.equal(q.current.seconds,75);a.equal(q.current.droppedPerMinute,12);});
