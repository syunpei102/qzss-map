'use strict';
const fs=require('node:fs'),path=require('node:path');
const number=v=>Number.isFinite(v)&&v>=0?v:null;
function view(root,now=Date.now()){
 try{
  const file=path.join(root,'analysis/public.json');if(fs.statSync(file).size>131072)throw Error('large');const d=JSON.parse(fs.readFileSync(file));
  const counts={};for(const key of ['matched','mismatch','decode-error','missing-raw'])counts[key]=number(d.counts?.[key])??0;
  const network={};for(const key of ['count','intervalCount','lastHeartbeatAt','expectedSeconds','medianSeconds','p95Seconds','jitterSeconds','lateIntervals','estimatedMissing','excludedIntervals'])network[key]=number(d.network?.[key]);network.observerConnected=d.network?.observerConnected===true;
  const recent=Array.isArray(d.recent)?d.recent.slice(-20).map(r=>({at:number(r.at),type:typeof r.type==='string'&&/^Qzss[A-Za-z0-9]+$/.test(r.type)?r.type:'不明',outcome:['matched','mismatch','decode-error','missing-raw'].includes(r.outcome)?r.outcome:'unknown',differences:Array.isArray(r.differences)?r.differences.filter(k=>typeof k==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(k)).slice(0,30):[]})):[];
  return {at:number(d.at),stale:!number(d.at)||now-d.at>30000||d.at>now+5000,startedAt:number(d.startedAt),counts,network,recent,backlogBytes:number(d.backlogBytes),decoderVersion:'azarashi 0.16.4'};
 }catch{return {at:null,stale:true,counts:{},network:{},recent:[]};}
}
module.exports={view};
