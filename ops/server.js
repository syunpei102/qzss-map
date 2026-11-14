'use strict';
const express=require('express'),WebSocket=require('ws'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {Journal,compare}=require('./journal');
const {Monitor,jstDay}=require('./monitor');
const {Telemetry,ROLES}=require('./telemetry');
const root=process.env.OPS_DATA||'/ops-data';const journal=new Journal(path.join(root,'reports'));
const monitor=new Monitor(root),telemetry=new Telemetry(root);
const app=express();app.disable('x-powered-by');
// Role-scoped ingestion accepts only numeric allowlisted metrics，never browser credentials．
app.post('/api/telemetry/:role',express.json({limit:'16kb'}),(req,res)=>{
 const role=req.params.role,token=process.env['OPS_METRICS_'+role.toUpperCase()+'_TOKEN'];
 const received=req.get('authorization')||'';
 if(!ROLES.includes(role)||!token||!crypto.timingSafeEqual(crypto.createHash('sha256').update(received).digest(),crypto.createHash('sha256').update('Bearer '+token).digest()))return res.sendStatus(401);
 try{telemetry.add(role,req.body);monitor.transition('host-'+role,'telemetry','online',Date.now(),'metrics-received');res.json({ok:true});}catch{res.sendStatus(400);}
});
const expected=process.env.OPS_PASSWORD_SHA256||'';if(!/^[a-f0-9]{64}$/.test(expected))throw Error('OPS_PASSWORD_SHA256 required');
app.use((req,res,next)=>{res.set('Cache-Control','no-store');const h=req.get('authorization')||'';let value='';try{value=Buffer.from(h.replace(/^Basic /,''),'base64').toString()}catch{}const i=value.indexOf(':');const ok=value.slice(0,i)===(process.env.OPS_USER||'qzss')&&crypto.timingSafeEqual(Buffer.from(crypto.createHash('sha256').update(value.slice(i+1)).digest('hex')),Buffer.from(expected));if(!ok)return res.status(401).set('WWW-Authenticate','Basic realm="QZSS review"').end();next();});
app.get('/api/files',(_req,res)=>res.json(journal.files()));
app.get('/api/recording',async(req,res)=>{try{const rows=await journal.rows(String(req.query.file));const reports=rows.filter(r=>r.source==='oracle'&&!['Heartbeat','DecodeError'].includes(r.report.type));const total=reports.length;res.json({reports:reports.slice(-500),total,comparison:compare(rows).slice(-500)});}catch{res.status(404).json({error:'recording not found'});}});
app.get('/dashboard',(_req,res)=>res.sendFile(path.join(__dirname,'dashboard.html')));
app.get('/dashboard-releases.json',(_req,res)=>res.sendFile(path.join(process.env.OPS_PUBLIC_DIR||'/app/public','releases.json')));
app.get('/dashboard.js',(_req,res)=>res.sendFile(path.join(__dirname,'dashboard.js')));
app.get('/dashboard.css',(_req,res)=>res.sendFile(path.join(__dirname,'dashboard.css')));
app.get('/api/dashboard',(req,res)=>{const day=String(req.query.day||jstDay(Date.now()));if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00+09:00'))||jstDay(Date.parse(day+'T00:00:00+09:00'))!==day)return res.sendStatus(400);res.json({...monitor.snapshot(day),hosts:telemetry.snapshot()});});
app.get('/api/status',(_req,res)=>res.json(status));
app.get('/',(_req,res)=>res.sendFile(path.join(__dirname,'review.html')));
app.get('/review.js',(_req,res)=>res.sendFile(path.join(__dirname,'review.js')));
app.get('/audit-results',(_req,res)=>res.sendFile(path.join(__dirname,'audit-results.html')));
app.get('/audit-results.js',(_req,res)=>res.sendFile(path.join(__dirname,'audit-results.js')));
app.get('/api/audit-results',async(_req,res)=>{
 const read=async name=>{try{return JSON.parse(await fs.promises.readFile(path.join(root,'audits',name),'utf8'));}catch{return null;}};
 const [model,browser]=await Promise.all([read('model-latest.json'),read('browser-latest.json')]);
 res.json({model,browser});
});
app.get('/audits/model-latest.json',(req,res,next)=>{if((req.get('Accept')||'').includes('text/html'))return res.redirect('/audit-results');next();});
app.use('/audits',express.static(path.join(root,'audits'),{index:false}));
app.use((req,res,next)=>{if(!['GET','HEAD'].includes(req.method))return res.sendStatus(405);if(req.path==='/index.html'&&req.query.sandbox!=='1')return res.sendStatus(403);next();});
app.use(express.static(process.env.OPS_PUBLIC_DIR||'/app/public',{index:false}));
const status={};let closing=false;
function connect(source,url){const ws=new WebSocket(url,{maxPayload:262144});status[source]={connected:false};ws.on('open',()=>{status[source]={...status[source],connected:true};if(source==='oracle')monitor.connection(source,true);});ws.on('message',data=>{try{const report=JSON.parse(data);if(source==='oracle')monitor.receive(source,report);status[source].lastReceived=Date.now();if(['Heartbeat','ReceiverStatus'].includes(report.type)){status[source].lastHeartbeat=Date.now()-(Number(report.ageMs)||0);status[source].serialConnected=report.serial_connected;}if(!journal.append(source,report))status[source].lastSkipped=Date.now();}catch{status[source].parseError=Date.now();}});ws.on('error',()=>{});ws.on('close',()=>{if(source==='oracle')monitor.connection(source,false);status[source].connected=false;if(!closing)setTimeout(()=>connect(source,url),5000).unref();});return ws;}
const sockets=process.env.OPS_CAPTURE==='false'?[]:[connect('gcp','wss://eq.shum10.com/'),connect('oracle','wss://oracle-review.eq.shum10.com/')];
setInterval(()=>{const tmp=path.join(root,'capture-status.tmp');fs.promises.writeFile(tmp,JSON.stringify({at:Date.now(),sources:status}),{mode:0o600}).then(()=>fs.promises.rename(tmp,path.join(root,'capture-status.json'))).catch(()=>console.error('capture status write failed'));},30000).unref();
setInterval(()=>{try{for(const [role,host] of Object.entries(telemetry.snapshot()))if(host.stale)monitor.transition('host-'+role,'telemetry','offline',Date.now(),'metrics-timeout');monitor.tick();void monitor.notify(process.env.DISCORD_ALERT_WEBHOOK_URL);}catch{console.error('monitor-persist-failed');}},15000).unref();
const maintenance=setInterval(()=>Promise.resolve().then(()=>telemetry.prune()).then(()=>journal.prune(30)).catch(e=>console.error('retention-failed',e.code)),3600000);maintenance.unref();
const server=app.listen(Number(process.env.OPS_PORT ?? 8090),'0.0.0.0',()=>{console.log('Authenticated review service listening');if(process.send)process.send({port:server.address().port});});
process.on('SIGTERM',()=>{closing=true;monitor.save();sockets.forEach(s=>s.close());journal.pending.finally(()=>process.exit(0));});
