(function(){'use strict';
// Advance from the server sample using a monotonic clock，not the device wall clock．
function createClock(monotonic=()=>performance.now(),wall=()=>Date.now()){
 let sample=null,mark=0;
 return {sync(at){if(Number.isFinite(at)){sample=at;mark=monotonic();}},read(online=true){const age=sample===null?null:Math.max(0,monotonic()-mark);return {at:sample===null?wall():sample+age,source:sample===null?'端末時刻（日本時間）':!online||age>90000?'サーバー時刻（再同期待ち）':'サーバー時刻（日本時間）'};}};
}
if(typeof module!=='undefined'&&module.exports){module.exports={createClock};return;}
const clock=createClock(),format=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}),date=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'long',day:'numeric',weekday:'short'});
function update(){const node=document.getElementById('current-clock'),label=document.getElementById('clock-source');if(!node||!label||document.hidden)return;const value=clock.read(navigator.onLine);node.textContent=format.format(value.at);node.dateTime=new Date(value.at).toISOString();label.textContent=date.format(value.at)+' ／ '+value.source;}
globalThis.QzssDashboardClock={sync(at){clock.sync(at);update();}};setInterval(update,250);document.addEventListener('visibilitychange',update);window.addEventListener('offline',update);window.addEventListener('online',update);update();
})();
