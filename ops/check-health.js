'use strict';
const fs=require('node:fs'),path=require('node:path');const {Journal,compare}=require('./journal');
(async()=>{const root=process.env.OPS_DATA||'/ops-data',j=new Journal(root+'/reports'),now=Date.now();const issues=[];try{const s=JSON.parse(fs.readFileSync(root+'/capture-status.json'));for(const [source,state] of Object.entries(s.sources))if(!state.disabled&&(!state.lastHeartbeat||now-state.lastHeartbeat>180000))issues.push('受信監視の応答なし：'+source);}catch{}try{const disk=fs.statfsSync(root);if(disk.bavail*disk.bsize<2*1024**3)issues.push('サーバーVMの空き容量が2GiB未満');}catch{}for(const f of (process.env.OPS_CAPTURE_GCP==='true'?j.files().slice(-2):[])){for(const r of compare((await j.rows(f)).filter(r=>now-r.at<1800000),now))if(r.state==='missing')issues.push('片系統のみ受信：'+r.type+' '+r.key.slice(0,10));}for(const name of ['model-latest.json','browser-latest.json']){
  try{
    const audit=JSON.parse(fs.readFileSync(path.join(root,'audits',name)));
    if(audit.passed===false) issues.push('検証失敗：'+name);
    else if(!Number.isFinite(audit.at) || audit.at>now+60000 || now-audit.at>27*3600000)
      issues.push('検証結果が更新されていません：'+name);
  }catch{
    issues.push('検証結果を読み込めません：'+name);
  }
}const key=JSON.stringify(issues);const state=root+'/alert-state.json';let previous={};try{previous=JSON.parse(fs.readFileSync(state))}catch{}if(issues.length&&(key!==previous.key||now-previous.at>6*3600000)){const webhook=process.env.DISCORD_ALERT_WEBHOOK_URL;if(webhook){const r=await fetch(webhook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'QZSS運用検証\n'+issues.slice(0,10).join('\n')}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Discord failed');}else console.error('Alert pending: Discord webhook missing');fs.writeFileSync(state,JSON.stringify({key,at:now}));}else if(!issues.length)fs.writeFileSync(state,JSON.stringify({key:'[]',at:now}));})().catch(()=>{console.error('health-check-failed');process.exitCode=1});
