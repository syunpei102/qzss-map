'use strict';
const fs=require('node:fs'),path=require('node:path');
const text=(v,max=200)=>typeof v==='string'?v.slice(0,max):'';
const date=v=>Number.isFinite(v)&&v>0&&v<8640000000000000?v:null;
const colors=new Set(['sev-emergency','sev-warning','sev-caution','sev-info','sev-training','sev-error','sev-keihou','sev-tokubetsu','sev-flood-caution','sev-flood-keihou']);
function normalize(snapshot,now=Date.now()){
 if(!snapshot||!date(snapshot.at)||snapshot.ready!==true||!Array.isArray(snapshot.events))return null;
 const events=snapshot.events.slice(0,20).filter(r=>r&&typeof r.id==='string').map(r=>({id:text(r.id,180),kind:['earthquake','tsunami','jalert','other'].includes(r.kind)?r.kind:'other',phase:['eew','hypocenter','intensity'].includes(r.phase)?r.phase:null,title:text(r.title),message:text(r.message,800),badge:text(r.badge,80),severity:colors.has(r.severity)?r.severity:'sev-info',selected:r.selected===true,rows:Array.isArray(r.rows)?r.rows.slice(0,8).filter(a=>Array.isArray(a)&&a.length>=2).map(a=>[text(a[0],80),text(a[1],500)]):[],receivedAt:date(r.receivedAt),firstReceivedAt:date(r.firstReceivedAt),lastReceivedAt:date(r.lastReceivedAt),expiresAt:date(r.expiresAt),deadline:date(r.expiresAt)?now+r.expiresAt-snapshot.at:null,reportKey:typeof r.reportKey==='string'&&/^dcr:[0-9a-f]{1,160}:(?:[0-9]{1,2})?$/.test(r.reportKey)?r.reportKey:null,isTraining:r.isTraining===true,isTestData:r.isTestData===true}));
 return {at:now,browserAt:snapshot.at,total:Number.isSafeInteger(snapshot.total)?Math.max(events.length,Math.min(10000,snapshot.total)):events.length,events};
}
class DisplayState{
 constructor(root){this.file=path.join(root,'display-state.json');this.latest=null;try{this.latest=JSON.parse(fs.readFileSync(this.file));}catch{}}
 add(snapshot,now=Date.now()){const clean=normalize(snapshot,now);if(!clean)return;fs.writeFileSync(this.file+'.tmp',JSON.stringify(clean),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);this.latest=clean;}
 view(latency,now=Date.now()){if(!this.latest)return {at:null,stale:true,events:[]};return {...this.latest,stale:now-this.latest.at>60000,events:this.latest.events.map(event=>({...event,latency:event.reportKey?latency.findLast(row=>row.reportKey===event.reportKey&&row.isTestData===event.isTestData&&Math.abs((row.browserMeasuredAt||row.recordedAt)-(event.lastReceivedAt||this.latest.browserAt))<1800000)||null:null}))};}
}
module.exports={normalize,DisplayState};
