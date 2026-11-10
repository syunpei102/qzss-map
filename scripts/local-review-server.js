// ローカル専用の合成データ再生器．本番URLや任意の宛先には送信しない．
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.REVIEW_PORT || 18086);
const appPort = Number(process.env.REVIEW_APP_PORT || 18085);
const stateDir = process.env.REVIEW_STATE_DIR || '/tmp/qzss-review-1.13.0';
const base = `http://127.0.0.1:${appPort}`;
const origin = `http://127.0.0.1:${port}`;
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/review/cases.json')));
const token = require('node:crypto').randomBytes(24).toString('hex');
let child, busy = false, lastCase = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function reset(clear = true, replay = null) {
  if (clear && child && child.exitCode === null) {
    const r = await fetch(base+'/local-sync/reset-reports', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    if (!r.ok) throw Error('表示をリセットできません．');
    await settings({weatherEnabled:false,volcanoEnabled:false});
    lastCase = null;
    return;
  }
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  fs.mkdirSync(stateDir, { recursive: true });
  if (clear) {
    for (const file of ['active_reports.json', 'latency_history.json']) fs.writeFileSync(path.join(stateDir,file),'[]');
    fs.writeFileSync(path.join(stateDir,'information_category_settings.json'),JSON.stringify({weatherEnabled:false,volcanoEnabled:false}));
    fs.writeFileSync(path.join(stateDir,'training_broadcast_settings.json'),JSON.stringify({global:false,perDevice:{}}));
  } else if (replay) {
    const file=path.join(stateDir,'active_reports.json');
    const entries=JSON.parse(fs.readFileSync(file));
    for(const entry of entries)if(String(entry.report.raw).startsWith('local-review:'+replay.id+':'))entry.receivedAt-=replay.age;
    fs.writeFileSync(file,JSON.stringify(entries));
  }
  child = spawn(process.execPath, ['server.js'], {cwd:root, env:{...process.env, HOST:'127.0.0.1', PORT:String(appPort), LOCAL_STATE_ONLY:'true', QZSS_REVIEW_MODE:'true', QZSS_LOCAL_STATE_DIR:stateDir, INGEST_TOKEN:token, VAPID_PUBLIC_KEY:'', VAPID_PRIVATE_KEY:'', CLOUD_LATENCY_REPORT_URL:''}, stdio:['ignore','ignore','pipe']});
  child.stderr.on('data', data => { if (!String(data).includes('VAPID')) process.stderr.write(data); });
  let exited = null; child.on('error', e => { exited = e; });
  for(let i=0;i<100;i++) { if(exited||child.exitCode!==null)throw Error('確認用サーバーを起動できません．ポートを確認してください．'); try {if((await fetch(base+'/config')).ok){lastCase=null;return;}}catch{} await sleep(50); }
  throw Error('確認用サーバーの起動がタイムアウトしました．');
}
async function settings(value) {
  for(const key of ['weatherEnabled','volcanoEnabled']) {
    if(typeof value[key] !== 'boolean')continue;
    const r=await fetch(base+'/local-sync/'+key,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:value[key]})});
    if(!r.ok)throw Error(`設定を変更できません：${key}`);
  }
}
async function send(id, options) {
  const entry=fixtures.cases.find(c=>c.id===id); if(!entry)throw Error('テストデータがありません．');
  if(options.reset !== false)await reset();
  if(options.caseSettings !== false)await settings(entry.settings);
  const now=Date.now(), time=new Date(now).toISOString();
  for(let i=0;i<entry.reports.length;i++){
    const report={...entry.reports[i],timestamp:time,report_time:time,occurrence_time_of_earthquake:time,raw:entry.reports[i].raw+':'+now,client_timestamps:{schema_version:2,receiver_decode_ms:0}};
    const r=await fetch(base+'/ingest',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':token},body:JSON.stringify(report)});
    if(r.status!==204)throw Error(`データ送信失敗：${r.status}`);
    if(i<entry.reports.length-1)await sleep(1000);
  }
  const age=Math.max(...entry.reports.map(r=>r.replay_age_ms||0));
  // 保存通報の経過時間はサーバーが受信時刻から計算する．期限切れケースは
  // ローカル保存の受信時刻を進めて再起動し，実際の復元・期限切れ経路を通す．
  if(age)await reset(false,{id:entry.id,age});
  lastCase={id:entry.id,name:entry.name,expected:entry.expected};return lastCase;
}
const server=http.createServer(async(req,res)=>{
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.host!==`127.0.0.1:${port}`)return json(403,{error:'loopback only'});
  try{
    if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(fs.readFileSync(path.join(root,'test/review/index.html'),'utf8').replaceAll('__APP_URL__',base));}
    if(req.method==='GET'&&req.url==='/api/cases')return json(200,fixtures);
    if(req.method==='GET'&&req.url==='/api/state')return json(200,{config:await(await fetch(base+'/config')).json(),lastCase});
    if(req.method!=='POST'||req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json'))return json(403,{error:'same-origin JSON required'});
    if(busy)return json(409,{error:'処理中です．少し待ってください．'});
    busy=true;
    try{let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw Error('リクエストが大きすぎます．');}const value=JSON.parse(body||'{}');
      if(req.url==='/api/reset'){await reset();return json(200,{ok:true});}
      if(req.url==='/api/settings'){await settings(value);return json(200,{ok:true});}
      if(req.url==='/api/send')return json(200,await send(value.id,value));
      return json(404,{error:'not found'});
    }finally{busy=false;}
  }catch(e){json(500,{error:e.message});}
});
reset().then(()=>server.listen(port,'127.0.0.1',()=>console.log(`確認画面 ${origin}/\n地図 ${base}/?web-preview=1&renderer=native&preview=1.13.0`))).catch(e=>{console.error(e.message);process.exitCode=1;});
function shutdown(){child?.kill('SIGTERM');server.close();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
