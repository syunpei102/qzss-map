(function(){'use strict';
// Counters are lifetime totals．Compare bounded windows and never count a reset as recovery．
const valid=v=>Number.isFinite(v)&&v>=0;
function windowAt(rows,index){
 const end=rows[index];if(!end)return null;
 let start=index-1;while(start>=0&&end.at-rows[start].at<60000)start--;
 if(start<0||end.at-rows[start].at>100000)return null;
 for(let i=start+1;i<=index;i++){
  const a=rows[i-1],b=rows[i];
  if(b.at-a.at>90000||!['dropped','duplicated'].every(k=>valid(a.encoder?.[k])&&valid(b.encoder?.[k])&&b.encoder[k]>=a.encoder[k])||valid(a.encoder?.frames)&&valid(b.encoder?.frames)&&b.encoder.frames<a.encoder.frames)return null;
 }
 const seconds=(end.at-rows[start].at)/1000,dropped=end.encoder.dropped-rows[start].encoder.dropped,duplicated=end.encoder.duplicated-rows[start].encoder.duplicated;
 return {start,seconds,dropped,duplicated,droppedPerMinute:dropped*60/seconds,duplicatedPerMinute:duplicated*60/seconds};
}
function summarize(history,latest,now=Date.now()){
 const rows=[...history,latest].filter(r=>r&&valid(r.at)&&r.encoder).sort((a,b)=>a.at-b.at).filter((r,i,a)=>!i||r.at!==a[i-1].at);
 if(!rows.length||now-rows.at(-1).at>90000)return {state:'stale',current:null,previous:null,trend:'未取得',points:[]};
 const current=windowAt(rows,rows.length-1),previous=current?windowAt(rows,current.start):null;
 const delta=previous&&current?current.droppedPerMinute-previous.droppedPerMinute:null;
 return {state:current?'ready':'collecting',current,previous,trend:delta===null?'比較データ収集中':Math.abs(delta)<0.5?'前の約1分と同程度':delta>0?'前の約1分より増加':'前の約1分より減少',points:rows.map((row,i)=>{const value=windowAt(rows,i);return value?{at:row.at,droppedPerMinute:value.droppedPerMinute,duplicatedPerMinute:value.duplicatedPerMinute}:null;}).filter(Boolean)};
}
if(typeof module!=='undefined'&&module.exports)module.exports={summarize};else globalThis.QzssFrameQuality={summarize};
})();
