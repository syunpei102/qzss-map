(function(){'use strict';
function wifiQuality(dbm){return !Number.isFinite(dbm)?'未取得':dbm>=-60?'強い':dbm>=-70?'中程度':'弱い';}
function connectionMethod(name){return !name?'未取得':/^wl/.test(name)?'Wi-Fi':/^(eth|en)/.test(name)?'有線LAN':'その他';}
function ago(ms){if(!Number.isFinite(ms))return '未取得';const seconds=Math.max(0,Math.floor(ms/1000));return seconds<60?`${seconds}秒前`:seconds<3600?`${Math.floor(seconds/60)}分${seconds%60}秒前`:`${Math.floor(seconds/3600)}時間${Math.floor(seconds%3600/60)}分前`;}
function features(data,role){const host=data.hosts?.[role],s=host?.latest,i=s?.infrastructure,now=data.at,items=[];const fresh=s&&!host.stale&&now-s.at<=90000,infraFresh=fresh&&i?.checkedAt&&now-i.checkedAt<=180000;const add=(name,ok,note,waiting=false)=>items.push({name,label:waiting?'待機中':ok===true?'正常':ok===false?'要確認':'要確認',kind:ok===true||waiting?'ok':'unknown',note});
 if(role==='server'){
  const receiver=data.sources?.oracle;add('通報受信',receiver?.connected&&receiver.signal==='online'&&now-receiver.lastHeartbeat<=90000,'受信ハートビートの到着を確認');
  add('通知エンジン',infraFresh&&i.notificationEnabled===true,'通知設定とAPI応答を確認．端末への配送は未試験');
  add('地図配信',infraFresh&&i.mapApi===true,'地図の設定API応答を確認');
  const display=data.display,stream=data.hosts?.stream;add('描画エンジン',display&&!display.stale&&now-display.at<=60000&&!stream?.stale&&stream?.latest?.browser?.healthy===true&&stream.latest.browser.ageSeconds<=90,'配信画面の読み込みと画面監視を確認');
  add('定期検査',infraFresh&&i.auditTimer?.active==='active'&&i.audit?.result==='success'&&i.audit.exitCode===0&&Number.isFinite(i.audit.lastFinishedAt),'夜間検査の定期実行と最終成功結果を確認');
  add('障害監視',infraFresh&&i.healthTimer?.active==='active'&&i.health?.result==='success'&&i.health.exitCode===0&&now-i.health.lastFinishedAt<900000,'監視ジョブの定期実行と15分以内の最終成功結果を確認');
 }else if(role==='pi'){
  const receiver=data.sources?.oracle,r=s?.reception,w=s?.watchdog;
  add('受信プログラム',fresh&&s.services?.decoder==='active'&&s.decoder?.result==='success','受信プロセスの稼働と終了状態を確認');
  add('受信監視',infraFresh&&i.receptionTimer?.active==='active'&&i.receptionService?.result==='success'&&i.receptionService.exitCode===0&&now-i.receptionService.lastFinishedAt<=180000&&r?.watchAgeSeconds<=90&&r.watchState==='ok','監視タイマー・最終実行結果・受信監視ファイルの更新を確認');
  add('自動再起動',infraFresh&&i.supervisor?.active==='active'&&['always','on-failure'].includes(i.supervisor?.restartPolicy),'異常終了時の自動再起動設定を確認．強制終了試験は未実施');
  add('OSウォッチドッグ',infraFresh&&i.osWatchdogConfigured===true&&w?.active===true&&w.timeoutSeconds>0&&w.remainingSeconds>0&&w.remainingSeconds<=w.timeoutSeconds,'systemdの設定とハードウェア監視のカウントを確認．再起動試験は未実施');
  add('USB受信機',fresh&&r?.usbPresent===true,'USBシリアル変換器の認識を確認');
  add('サーバー接続',fresh&&receiver?.connected&&receiver.signal==='online'&&now-receiver.lastHeartbeat<=90000,'端末の状態報告と受信ハートビートの到着を確認');
 }else if(role==='stream'){
  add('ライブ配信',fresh&&s.services?.stream==='active'&&s.encoder?.ageSeconds<=90,'エンコーダの進捗を確認');
  add('録画・自動投稿',fresh&&s.services?.clips==='active'&&s.recordings?.failed===0&&s.recordings?.archiveFailed===0,'処理サービスと保存済み失敗件数を確認');
  add('画面監視',fresh&&s.browser?.healthy===true&&s.browser.ageSeconds<=90,'ウォッチドッグの最新の画面確認結果');
  add('自動復旧',infraFresh&&i.supervisor?.active==='active'&&['always','on-failure'].includes(i.supervisor?.restartPolicy),'自動再起動の設定を確認．障害を起こす試験は未実施');
 }
 if(role==='server'||role==='stream'){const b=i?.backup,t=i?.backupTimer;const ok=infraFresh&&t?.active==='active'&&b?.result==='success'&&b.exitCode===0&&Number.isFinite(b.lastFinishedAt);add('バックアップ',ok,'定期実行の有効状態と最終実行結果を確認',infraFresh&&t?.active==='active'&&b?.active==='inactive'&&!b.lastFinishedAt&&b.result==='success');}
 return items;}
if(typeof module!=='undefined'&&module.exports){module.exports={features,wifiQuality,connectionMethod,ago};return;}
globalThis.QzssInfrastructure={features,wifiQuality,connectionMethod,ago};
})();
