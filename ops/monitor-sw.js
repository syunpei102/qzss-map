'use strict';
// No cache storage is used．Authentication responses and monitoring data stay network-only．
const ENABLED=['status.shum10.com','127.0.0.1','localhost'].includes(self.location.hostname);
if(ENABLED){
 self.addEventListener('install',()=>self.skipWaiting());
 self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
 self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||event.request.mode!=='navigate'||url.origin!==self.location.origin)return;
  event.respondWith(fetch(event.request,{cache:'no-store'}).catch(()=>new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#171a1f"><title>接続できません | QZSS 運用監視</title><style>body{margin:0;background:#171a1f;color:#f1f3f5;font:18px/1.8 system-ui}main{max-width:640px;margin:15vh auto;padding:24px}h1{font-size:28px}a{color:#9dbdff}a:focus-visible{outline:4px solid #ffbe00;outline-offset:4px}.state{color:#f8da84}</style><main><p>QZSS 運用監視</p><h1>監視サイトへ接続できません</h1><p class="state">現在の稼働状況は未確認です．</p><p>ネットワークまたは監視サーバーへの接続を確認してください．この画面には過去の監視データを保存していません．</p><a href="/">再接続する</a></main></html>`,{status:200,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}})));
 });
}
