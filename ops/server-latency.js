'use strict';
// Same-device monotonic durations only．No subtraction between host wall clocks．
const fs=require('node:fs'),path=require('node:path');
const {identity}=require('../public/latency-dedup');
const {fingerprint}=require('./journal');
const valid=v=>Number.isFinite(v)&&v>=0&&v<=600000;
function normalize(report,now=Date.now()){
 const t=report?.client_timestamps;
 if(t?.schema_version!==2||!valid(t.receiver_decode_ms)||!valid(t.server_processing_ms)||Number(report.replay_age_ms)>0)return null;
 const reportSummary={};
 for(const key of ['type','disaster_category','information_type','report_time','seismic_epicenter','magnitude','a1_message_type','a4_hazard_type','a11_japanese_library','a11_japanese_library_ja'])if(typeof report[key]==='string')reportSummary[key]=report[key].slice(0,200);
 for(const key of ['disaster_category_no','report_classification_no'])if(Number.isInteger(report[key]))reportSummary[key]=report[key];
 if(!reportSummary.type||['Heartbeat','ReceiverStatus','DecodeError'].includes(reportSummary.type))return null;
 return {schemaVersion:2,measurementSource:'oracle-server',recordedAt:now,receiverDecodeMs:t.receiver_decode_ms,serverProcessingMs:t.server_processing_ms,measuredMs:t.receiver_decode_ms+t.server_processing_ms,isTestData:report.is_test_data===true,reportKey:fingerprint(report),reportSummary};
}
class ServerLatency{
 constructor(root,legacy=[]){this.file=path.join(root,'server-latency.json');this.rows=[];try{this.rows=JSON.parse(fs.readFileSync(this.file)).filter(r=>r.measurementSource==='oracle-server').slice(-1000);}catch{}
 // Historical numeric intervals remain useful，but are explicitly labelled as browser-collected．
 if(!this.rows.length)for(const r of legacy)if(valid(r.receiverDecodeMs)&&valid(r.serverProcessingMs))this.rows.push({...r,measurementSource:'oracle-server',collectionSource:'historical-browser',measuredMs:r.receiverDecodeMs+r.serverProcessingMs});
 }
 add(report,now=Date.now()){const row=normalize(report,now);if(!row)return false;const key=identity(row);if(this.rows.some(r=>identity(r)===key&&(row.reportSummary.report_time||Math.abs(now-r.recordedAt)<1800000)))return false;this.rows.push(row);this.rows=this.rows.slice(-1000);fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.rows),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);return true;}
}
module.exports={ServerLatency,normalize};
