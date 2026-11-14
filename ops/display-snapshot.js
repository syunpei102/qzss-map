// Read-only projection of map records．Never call selection methods on the live view cycle．
(function(){'use strict';
function snapshot(records,states,selectedIds,at=Date.now(),ready=true){
 const stateById=new Map(states.map(s=>[String(s.id),s])),selected=new Set(selectedIds.map(String));
 return {at,ready,total:records.length,events:records.slice().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,20).map(r=>{const s=stateById.get(String(r.id)),report=s?.report||{},raw=report.raw;return {id:String(r.id),kind:s?.kind||r.displayKind||'other',phase:s?.phase||null,title:Array.isArray(r.headline)?r.headline.join(' ／ '):r.headline||r.title||r.badgeText||'災害情報',message:String(r.message||'').slice(0,500),badge:r.badgeText||report.disaster_category||'',severity:(r.badgeClass||'').match(/sev-[a-z-]+/)?.[0]||'sev-info',rows:(r.rows||[]).slice(0,8).map(row=>row.slice(0,2).map((value,i)=>String(value??'').slice(0,i===0?60:250))),selected:selected.has(String(r.id)),receivedAt:s?.receivedAt||r.receivedAt||r.updatedAt||null,firstReceivedAt:s?.phaseFirstReceivedAt||r.firstReceivedAt||r.updatedAt||null,lastReceivedAt:s?.lastReceivedAt||r.lastReceivedAt||r.updatedAt||null,expiresAt:s?.expiresAt||r.expiresAt||null,reportKey:typeof raw==='string'&&/^[0-9a-f]+$/i.test(raw)?`dcr:${raw.toLowerCase()}:${report.information_type_no??''}`:null,isTraining:!!r.isTraining,isTestData:!!r.isTestData};})};
}
if(typeof module!=='undefined'&&module.exports)module.exports={snapshot};
})();
