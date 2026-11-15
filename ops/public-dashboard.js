'use strict';
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
function publicDashboard(data){
 const clean=structuredClone(data),youtube=data.youtube||{};
 clean.youtube=pick(youtube,['at','agentAt','agentVersion']);clean.youtube.error=youtube.error?pick(youtube.error,['at','code']):null;
 clean.youtube.metadata=youtube.metadata?{checkedAt:youtube.metadata.checkedAt,broadcasts:(youtube.metadata.broadcasts||[]).map(b=>pick(b,['id','title','actualStartTime','actualEndTime','concurrentViewers','privacyStatus','lifeCycleStatus']))}:null;
 clean.youtube.command=youtube.command?pick(youtube.command,['status','createdAt','finishedAt','reason']):null;
 for(const host of Object.values(clean.hosts||{})){for(const sample of [host.latest,...(host.history||[])])if(sample){delete sample.bootId;delete sample.decoderEvents;}for(const event of host.events||[])delete event.id;}
 return clean;
}
const PUBLIC_STATUS_PATHS=new Set(['/dashboard','/api/dashboard','/dashboard-releases.json','/monitor-pwa.js','/dashboard-health.js','/youtube-view.js','/infrastructure-view.js','/display-view.js','/dashboard-clock.js','/analysis-view.js','/frame-quality.js','/uptime.js','/dashboard.js','/dashboard.css']);
function isPublicStatus(req){return String(req.hostname).toLowerCase().replace(/\.$/,'')==='status.shum10.com'&&['GET','HEAD'].includes(req.method)&&PUBLIC_STATUS_PATHS.has(req.path);}
module.exports={publicDashboard,isPublicStatus};
