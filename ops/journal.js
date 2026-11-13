'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const OMIT=new Set(['timestamp','client_timestamps','replay_age_ms','sentence','nmea','message','satellite_id','satellite_prn','preamble']);
function normalize(value){if(Array.isArray(value))return value.map(normalize);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!OMIT.has(k)&&!k.startsWith('display_')).map(k=>[k,normalize(value[k])]));return value;}
function fingerprint(report){return crypto.createHash('sha256').update(JSON.stringify(normalize(report))).digest('hex');}
function day(at){return new Date(at+9*3600000).toISOString().slice(0,10);}
class Journal{
 constructor(root,now=Date.now){this.root=root;this.now=now;fs.mkdirSync(root,{recursive:true,mode:0o700});this.pending=Promise.resolve();this.depth=0;}
 append(source,report){if(!['gcp','oracle'].includes(source))throw Error('source');if(!report||typeof report!=='object'||Array.isArray(report))return false;if(Number(report.replay_age_ms)>0||report.type==='ReceiverStatus')return false;const at=this.now();const row={at,source,key:fingerprint(report),report};if(this.depth>=1000)return false;this.depth++;const file=path.join(this.root,day(at)+'.jsonl');this.pending=this.pending.then(()=>fs.promises.appendFile(file,JSON.stringify(row)+'\n',{mode:0o600})).finally(()=>this.depth--);this.pending=this.pending.catch(e=>console.error('journal-write-failed',e.code));return true;}
 files(){return fs.readdirSync(this.root).filter(n=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();}
 async rows(name){if(!this.files().includes(name))throw Error('unknown recording');const text=await fs.promises.readFile(path.join(this.root,name),'utf8');return text.split('\n').filter(Boolean).map(s=>{try{return JSON.parse(s)}catch{return null}}).filter(Boolean);}
 async prune(days=30){const cutoff=day(this.now()-days*86400000);for(const n of this.files())if(n.slice(0,10)<cutoff)await fs.promises.unlink(path.join(this.root,n));}
}
function compare(rows,now=Date.now(),grace=120000){
 const groups=new Map();
 for(const r of rows){if(['Heartbeat','DecodeError'].includes(r.report?.type))continue;const g=groups.get(r.key)||{key:r.key,type:r.report.type,gcp:[],oracle:[]};g[r.source]?.push(r.at);groups.set(r.key,g);}
 const result=[];
 for(const g of groups.values()){
  g.gcp.sort((a,b)=>a-b);g.oracle.sort((a,b)=>a-b);
  for(const at of g.oracle){let candidate=-1,distance=Infinity;g.gcp.forEach((t,i)=>{if(Math.abs(t-at)<distance&&Math.abs(t-at)<=grace){candidate=i;distance=Math.abs(t-at)}});const peer=candidate<0?null:g.gcp.splice(candidate,1)[0];result.push({key:g.key,type:g.type,gcp:peer,oracle:at,state:peer!==null?'matched':now-at<grace?'pending':'missing',arrivalDifferenceMs:peer!==null?at-peer:null});}
  for(const at of g.gcp)result.push({key:g.key,type:g.type,gcp:at,oracle:null,state:now-at<grace?'pending':'missing',arrivalDifferenceMs:null});
 }
 return result;
}
module.exports={Journal,fingerprint,compare,day};
