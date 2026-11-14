(()=>{'use strict';let deferred=null;const button=document.getElementById('install-app'),message=document.getElementById('app-install-state');const standalone=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
function state(){if(standalone()){button.textContent='アプリで利用中';button.disabled=true;}else{button.textContent='アプリとして追加';button.disabled=false;}}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferred=event;state();});
window.addEventListener('appinstalled',()=>{deferred=null;button.textContent='追加済み';button.disabled=true;message.textContent='アプリを追加しました．ホーム画面やアプリ一覧から開けます．';});
button.onclick=async()=>{if(deferred){const prompt=deferred;deferred=null;try{await prompt.prompt();const result=await prompt.userChoice;message.textContent=result.outcome==='accepted'?'アプリを追加しています．':'アプリの追加をキャンセルしました．';}catch{document.querySelector('button[data-detail="install-help"]')?.click();}}else document.querySelector('button[data-detail="install-help"]')?.click();};
state();const allowed=['status.shum10.com','127.0.0.1','localhost'].includes(location.hostname);
if(!allowed)button.hidden=true;
if(allowed&&'serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/monitor-sw.js',{scope:'/',updateViaCache:'none'}).catch(()=>{message.textContent='アプリ機能を初期化できませんでした．通常のブラウザ画面は利用できます．';}));}
})();
