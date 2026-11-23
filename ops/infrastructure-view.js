(function(){'use strict';
function wifiQuality(dbm){return !Number.isFinite(dbm)?'未取得':dbm>=-60?'強い':dbm>=-70?'中程度':'弱い';}
function connectionMethod(name){return !name?'未取得':/^wl/.test(name)?'Wi-Fi':/^(eth|en)/.test(name)?'有線LAN':'その他';}
function ago(ms){if(!Number.isFinite(ms))return '未取得';const seconds=Math.max(0,Math.floor(ms/1000));return seconds<60?`${seconds}秒前`:seconds<3600?`${Math.floor(seconds/60)}分${seconds%60}秒前`:`${Math.floor(seconds/3600)}時間${Math.floor(seconds%3600/60)}分前`;}
function features(data,role){const host=data.hosts?.[role],s=host?.latest,i=s?.infrastructure,now=data.at,items=[];const fresh=s&&!host.stale&&now-s.at<=90000,infraFresh=fresh&&i?.checkedAt&&now-i.checkedAt<=180000;const add=(name,ok,note,waiting=false)=>items.push({name,label:waiting?'待機中':ok===true?'正常':ok===false?'要確認':'要確認',kind:ok===true||waiting?'ok':'unknown',note});
 if(role==='server'){
  const receiver=data.sources?.oracle;add('通報受信',receiver?.connected&&receiver.signal==='online'&&now-receiver.lastHeartbeat<=90000,'受信ハートビートの到着を確認');
  add('通知エンジン',infraFresh&&i.notificationEnabled===true,'通知設定とAPI応答を確認．端末への配送は未試験');
  const a=data.analysis,c=a?.counts||{},af=a&&!a.stale&&now-a.at<=30000;add('電文照合',af&&!(c.mismatch||c['decode-error']||c['missing-raw']),'受信した生電文を別プロセスで再解析',af&&(!c.matched||a.backlogBytes>0));
  add('通信品質分析',af&&a.network?.observerConnected===true,'受信間隔と遅れ・推定欠落を継続集計');
  add('地図の設定取得',infraFresh&&i.mapApi===true,'サイトの設定情報を取得できるか確認．地図データの取得や各端末の描画は未確認');
  add('定期検査',infraFresh&&i.auditTimer?.active==='active'&&i.audit?.result==='success'&&i.audit.exitCode===0&&Number.isFinite(i.audit.lastFinishedAt),'夜間検査の定期実行と最終成功結果を確認');
  add('障害監視',infraFresh&&i.healthTimer?.active==='active'&&i.health?.result==='success'&&i.health.exitCode===0&&now-i.health.lastFinishedAt<900000,'監視ジョブの定期実行と15分以内の最終成功結果を確認');
  const b=s?.backgroundCompute,active=s?.services?.backgroundCompute,known=fresh&&active==='inactive'||fresh&&active==='active'&&Number.isFinite(b?.at)&&now-b.at<=45000&&['running','paused'].includes(b.state);const running=known&&active==='active'&&b.state==='running';items.push({name:'回収防止処理',label:!known?'要確認':running?'動作中':'停止中',kind:!known?'unknown':running?'ok':'neutral',note:'Oracle Cloudのアイドル判定の回避を目的に実行しています．回収防止を保証するものではありません．'});
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
  const test=s?.recoveryTest,verified=test?.at>0&&test.at<=now&&test.browserRecovered&&test.encoderUnchanged&&test.streamUnchanged&&test.progressAdvanced&&test.supervisorRecovered;
  add('自動復旧',infraFresh&&i.supervisor?.active==='active'&&['always','on-failure'].includes(i.supervisor?.restartPolicy),verified?'画面プロセスの停止・自動復旧を実配信で確認．配信プロセスは維持し，systemd再起動は隔離した試験で確認':'自動再起動の設定を確認．復旧試験の記録は未取得');
 }
 if(role==='server'||role==='stream'){const b=i?.backup,t=i?.backupTimer;const ok=infraFresh&&t?.active==='active'&&b?.result==='success'&&b.exitCode===0&&Number.isFinite(b.lastFinishedAt);add('バックアップ',ok,'定期実行の有効状態と最終実行結果を確認',infraFresh&&t?.active==='active'&&b?.active==='inactive'&&!b.lastFinishedAt&&b.result==='success');}
 return items;}
if(typeof module!=='undefined'&&module.exports){module.exports={features,wifiQuality,connectionMethod,ago};return;}
globalThis.QzssInfrastructure={features,wifiQuality,connectionMethod,ago};
})();
