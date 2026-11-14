#!/usr/bin/env python3
"""Read-only host sampler．No process command lines or credentials enter telemetry．"""
import hashlib, json, math, os, pathlib, re, shutil, subprocess, sys, time, urllib.request

def read_json(path):
    try:return json.loads(path.read_text())
    except (OSError,ValueError):return {}

def read_tail(path,limit=16384):
    with path.open('rb') as handle:
        handle.seek(0,2);length=handle.tell();offset=max(0,length-limit);handle.seek(offset);data=handle.read(limit)
    if offset:data=data.partition(b'\n')[2]
    return data.decode('utf-8',errors='replace')

def cpu_delta(current,previous):
    if not previous or len(previous)!=len(current):return None,None
    delta=[a-b for a,b in zip(current,previous)]
    total=sum(delta)
    if min(delta)<0 or total<=0:return None,None
    return round(100*(total-delta[3]-delta[4]-delta[7])/total,2),round(100*delta[7]/total,2)

def number(value):
    try:
        result=float(str(value).rstrip('x'))
        return result if math.isfinite(result) else None
    except (ValueError,TypeError):return None


def network_state(proc=pathlib.Path('/proc'),sysnet=pathlib.Path('/sys/class/net')):
    result={}
    try:
        for line in (proc/'net/route').read_text().splitlines()[1:]:
            fields=line.split()
            if len(fields)>3 and fields[1]=='00000000' and int(fields[3],16)&1:
                interface=fields[0]
                if re.fullmatch(r'[a-zA-Z0-9_.:-]{1,32}',interface):result['interface']=interface
                break
        interface=result.get('interface')
        if interface:
            base=sysnet/interface
            for key,file in [('operState','operstate'),('carrier','carrier'),('rxBytes','statistics/rx_bytes'),('txBytes','statistics/tx_bytes')]:
                try:
                    raw=(base/file).read_text().strip();result[key]=raw if key=='operState' else raw=='1' if key=='carrier' else int(raw)
                except (OSError,ValueError):pass
            try:
                for line in (proc/'net/wireless').read_text().splitlines():
                    if line.strip().startswith(interface+':'):result['wifiDbm']=number(line.split(':',1)[1].split()[2])
            except (OSError,IndexError):pass
    except (OSError,ValueError):pass
    return result

def decoder_event(log):
    message=log.get('MESSAGE','')
    if not isinstance(message,str) or log.get('SYSLOG_IDENTIFIER')!='systemd':return None
    text=message.lower();kind=None
    if 'oom-kill' in text:kind='oom'
    elif 'status=11/segv' in text or 'code=dumped' in text:kind='crash'
    elif 'failed with result' in text:kind='service-failed'
    elif 'main process exited' in text and 'status=0/success' not in text:kind='abnormal-exit'
    elif text.startswith('started '):kind='service-start'
    if not kind:return None
    try:at=int(log['__REALTIME_TIMESTAMP'])/1000
    except (KeyError,ValueError,TypeError):return None
    return {'id':hashlib.sha256((str(at)+kind).encode()).hexdigest()[:20],'kind':kind,'at':at}

def recording_state(stream):
    counts={'recording':0,'pending':0,'uploaded':0,'failed':0,'uploading':0,'archivePending':0,'archiveFailed':0}
    for file in (stream/'clips').glob('*/job.json'):
        job=read_json(file);status=job.get('state')
        key=status if status in ('recording','pending','uploaded','failed') else 'pending' if status in ('ready','uploading') else None
        if key:counts[key]+=1
        if status=='uploading':counts['uploading']+=1
        if status=='blocked':counts['failed']+=1
        if status=='uploaded' and not job.get('archive_live_id') and not job.get('archive_excluded'):counts['archivePending']+=1
    archive=read_json(stream/'live-description-state.json')
    if counts['archivePending'] and archive.get('last_error'):counts['archiveFailed']=1
    return counts

def browser_snapshot():
    """Read only the captured page，never another browser or a caller-supplied URL．"""
    if '/opt/qzss-stream' not in sys.path:sys.path.insert(0,'/opt/qzss-stream')
    from browser_guard import Debugger
    with urllib.request.urlopen('http://127.0.0.1:9222/json/list',timeout=2) as response:pages=json.load(response)
    page=next(p for p in pages if p.get('type')=='page' and p.get('url','').startswith('https://oracle-review.eq.shum10.com/'))
    debugger=Debugger(page['webSocketDebuggerUrl'])
    expression="JSON.stringify((globalThis.QZSS_RENDER_TIMINGS||[]).slice(-10).map(t=>({...Object.fromEntries(['schema_version','receiver_decode_ms','server_processing_ms','client_processing_ms','client_visual_ready_ms','client_version','display_result','isTestData','reportKey','recordedAt'].map(k=>[k,t[k]])),reportSummary:Object.fromEntries(['type','disaster_category','information_type','report_time','seismic_epicenter','magnitude','disaster_category_no','report_classification_no'].filter(k=>t.reportSummary?.[k]!=null).map(k=>[k,t.reportSummary[k]]))})))"
    source=pathlib.Path(__file__).with_name('display-snapshot.js').read_text()
    display="(()=>{const module={exports:{}};"+source+";const records=typeof activeEvents==='undefined'?[]:[...activeEvents.values()];const states=typeof displayStore==='undefined'?[]:[...displayStore.events.values()];let selected=[];if(typeof DisplayEvents!=='undefined'&&typeof displayViewCycle!=='undefined'){const cycle=Object.assign(new DisplayEvents.ViewCycle(),displayViewCycle);selected=cycle.select(records,Date.now()).map(r=>r.id);}return module.exports.snapshot(records,states,selected,Date.now(),typeof isInitialLoad!=='undefined'&&!isInitialLoad);})()"
    expression="JSON.stringify({youtubeTimings:JSON.parse("+expression+"),displaySnapshot:"+display+"})"
    try:
        value=debugger.call('Runtime.evaluate',{'expression':expression,'returnByValue':True,'timeout':2000})
        result=json.loads(value['result']['value'])
        return result if isinstance(result,dict) else {}
    finally:debugger.close()

def service_probe(unit):
    properties=['ActiveState','Result','ExecMainStatus','NRestarts','Restart','WatchdogUSec','ExecMainExitTimestampMonotonic']
    try:
        result=subprocess.run(['systemctl','show',unit]+[arg for key in properties for arg in ['-p',key]],capture_output=True,text=True,timeout=3)
        if result.returncode:return {}
        fields=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        exited=number(fields.get('ExecMainExitTimestampMonotonic'))
        return {'active':fields.get('ActiveState'),'result':fields.get('Result'),'exitCode':number(fields.get('ExecMainStatus')),'restarts':number(fields.get('NRestarts')),'restartPolicy':fields.get('Restart'),'watchdogConfigured':fields.get('WatchdogUSec') not in (None,'0','0us'),'lastFinishedAt':round((time.time()-time.monotonic()+exited/1000000)*1000) if exited else None}
    except (OSError,subprocess.TimeoutExpired):return {}

def watchdog_state(root=pathlib.Path('/sys/class/watchdog/watchdog0')):
    result={'active':None,'timeoutSeconds':None,'remainingSeconds':None}
    for key,name in [('active','state'),('timeoutSeconds','timeout'),('remainingSeconds','timeleft')]:
        try:
            value=(root/name).read_text().strip()
            result[key]=value=='active' if key=='active' else number(value)
        except OSError:pass
    return result

def runtime_watchdog():
    try:
        result=subprocess.run(['systemctl','show','-p','RuntimeWatchdogUSec'],capture_output=True,text=True,timeout=3)
        if result.returncode:return None
        fields=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        value=fields.get('RuntimeWatchdogUSec')
        if value in ('0','0us','0s','infinity'):return False
        if not isinstance(value,str) or not re.fullmatch(r'(?:\d+(?:\.\d+)?(?:us|ms|s|min|h|d)?\s*)+',value):return None
        return any(float(v)>0 for v in re.findall(r'\d+(?:\.\d+)?',value))
    except (OSError,subprocess.TimeoutExpired):return None

def infrastructure(role):
    result={'checkedAt':round(time.time()*1000)}
    if role=='server':
        try:
            with urllib.request.urlopen('http://127.0.0.1:8080/config',timeout=2) as response:config=json.load(response)
            result['mapApi']=isinstance(config.get('webVersion'),str)
        except (OSError,ValueError):result['mapApi']=False
        try:
            with urllib.request.urlopen('http://127.0.0.1:8080/push/vapid-public-key',timeout=2) as response:config=json.load(response)
            result['notificationEnabled']=config.get('enabled') is True
        except (OSError,ValueError):pass
        result['backup']=service_probe('qzss-private-backup.service')
        result['backupTimer']=service_probe('qzss-private-backup.timer')
        result['auditTimer']=service_probe('ops-schedule.timer')
        result['audit']=service_probe('ops-schedule.service')
        result['healthTimer']=service_probe('ops-health.timer')
        result['health']=service_probe('ops-health.service')
    elif role=='pi':
        result['supervisor']=service_probe('qzss-decoder@qzss01.service')
        result['receptionTimer']=service_probe('qzss-reception-watch.timer')
        result['receptionService']=service_probe('qzss-reception-watch.service')
        result['osWatchdogConfigured']=runtime_watchdog()
    elif role=='stream':
        result['supervisor']=service_probe('qzss-stream.service')
        result['backup']=service_probe('qzss-private-backup.service')
        result['backupTimer']=service_probe('qzss-private-backup.timer')
    return result

def collect(role,previous,proc=pathlib.Path('/proc'),stream=pathlib.Path('/home/ubuntu/qzss-stream')):
    mono=time.monotonic();wall=time.time();cpu=list(map(int,(proc/'stat').read_text().splitlines()[0].split()[1:9]));usage,steal=cpu_delta(cpu,previous.get('cpu'))
    mem={k:int(v.split()[0])*1024 for k,v in (line.split(':',1) for line in (proc/'meminfo').read_text().splitlines())}
    disk=shutil.disk_usage('/');result={'measuredAt':round(wall*1000),'cpuPct':usage,'stealPct':steal,'memoryTotal':mem.get('MemTotal'),'memoryAvailable':mem.get('MemAvailable'),'swapUsed':mem.get('SwapTotal',0)-mem.get('SwapFree',0),'diskFree':disk.free,'diskTotal':disk.total,'uptimeSeconds':float((proc/'uptime').read_text().split()[0]),'services':{}}
    result['versions']={'collector':os.environ.get('QZSS_METRICS_VERSION','unknown')}
    if role=='server':
        try:
            with urllib.request.urlopen('http://127.0.0.1:8080/app-version.js',timeout=3) as response:text=response.read(4096).decode()
            match=re.search(r'QZSS_APP_VERSION\s*=\s*["\']([0-9.]+)',text)
            if match:result['versions']['map']=match[1]
        except (OSError,ValueError):pass
    elif role=='stream':
        version=read_json(stream/'version-watch.json')
        if wall-version.get('checked_at',0)<120 and isinstance(version.get('loaded'),str):result['versions']['loadedMap']=version['loaded']
    elif role=='pi':
        base=pathlib.Path('/home/qzss01/qzss')
        for key,file in [('map',base/'qzss-map/VERSION'),('receiver',base/'qzss-pi-package/VERSION')]:
            try:
                value=file.read_text().strip()
                if re.fullmatch(r'[a-zA-Z0-9._-]{1,64}',value):result['versions'][key]=value
            except OSError:pass
        if 'receiver' not in result['versions']:
            try:
                r=subprocess.run(['git','-C',str(base/'qzss-pi-package'),'rev-parse','--short=12','HEAD'],capture_output=True,text=True,timeout=2)
                if r.returncode==0:result['versions']['receiver']=r.stdout.strip()
            except (OSError,subprocess.TimeoutExpired):pass
    state={'cpu':cpu,'mono':mono}
    if role in ('server','stream','pi'):
        cached=previous.get('infrastructure',{})
        result['infrastructure']=infrastructure(role) if wall*1000-cached.get('checkedAt',0)>=60000 else cached
        state['infrastructure']=result['infrastructure']
    try:result['temperatureC']=int(pathlib.Path('/sys/class/thermal/thermal_zone0/temp').read_text())/1000
    except (OSError,ValueError):pass
    units={'server':{'docker':'docker','backup':'qzss-private-backup'},'stream':{'stream':'qzss-stream','clips':'qzss-clips','clock':'qzss-clock-watch','versionWatch':'qzss-version-watch','youtubeManager':'qzss-youtube-manager','backup':'qzss-private-backup'},'pi':{'decoder':'qzss-decoder@qzss01','receptionWatch':'qzss-reception-watch.timer'}}[role]
    for name,unit in units.items():
        try:
            r=subprocess.run(['systemctl','is-active',unit if unit.endswith('.timer') else unit+'.service'],capture_output=True,text=True,timeout=2)
            result['services'][name]=r.stdout.strip() or 'unknown'
        except (OSError,subprocess.TimeoutExpired):result['services'][name]='unknown'
    if role=='pi':
        result['watchdog']=watchdog_state()
        result['network']=network_state(proc)
        try:result['bootId']=(proc/'sys/kernel/random/boot_id').read_text().strip()
        except OSError:pass
        try:
            service=subprocess.run(['systemctl','show','qzss-decoder@qzss01.service','-p','NRestarts','-p','Result','-p','ExecMainStatus'],capture_output=True,text=True,timeout=3)
            fields=dict(line.split('=',1) for line in service.stdout.splitlines() if '=' in line)
            result['decoder']={'restartCount':number(fields.get('NRestarts')),'result':fields.get('Result'),'exitStatus':number(fields.get('ExecMainStatus'))}
        except (OSError,subprocess.TimeoutExpired):pass
        watchfile=pathlib.Path('/home/qzss01/qzss/qzss-pi-package/update_state/reception_state.json');watch=read_json(watchfile)
        reception={'watchState':watch.get('state'),'lastResetAt':watch.get('last_reset',0)*1000 or None,'lastRestartAt':watch.get('last_restart',0)*1000 or None,'resetCount':watch.get('reset_count'),'escalated':watch.get('escalated')}
        try:reception['watchAgeSeconds']=max(0,wall-watchfile.stat().st_mtime)
        except OSError:pass
        usb=pathlib.Path('/sys/bus/usb/devices');present=False
        try:
            for dev in usb.iterdir():
                try:
                    if (dev/'idVendor').read_text().strip()=='1a86' and (dev/'idProduct').read_text().strip()=='7523':present=True
                except OSError:pass
            reception['usbPresent']=present
        except OSError:pass
        cached=previous.get('reception',{})
        if wall-cached.get('journalCheckedAt',0)/1000>=60:
            reception.update(lastFrameAt=cached.get('lastFrameAt'),journalCheckedAt=round(wall*1000),journalAvailable=False);state['decoderEvents']=[]
            try:
                r=subprocess.run(['journalctl','-u','qzss-decoder@qzss01.service','--since','@'+str(max(wall-180,cached.get('journalCheckedAt',0)/1000-1)),'-n','1500','-o','json','--no-pager'],capture_output=True,text=True,timeout=4)
                if r.returncode==0:
                    reception['journalAvailable']=True
                    for line in r.stdout.splitlines():
                        try:
                            log=json.loads(line);message=log.get('MESSAGE','');event=decoder_event(log)
                            if event:state['decoderEvents'].append(event)
                            if isinstance(message,str) and message.startswith('$QZQSM,'):reception['lastFrameAt']=int(log['__REALTIME_TIMESTAMP'])/1000
                        except (ValueError,KeyError,TypeError):pass
            except (OSError,subprocess.TimeoutExpired):pass
        else:
            for key in ('lastFrameAt','journalCheckedAt','journalAvailable'):reception[key]=cached.get(key)
        result['decoderEvents']=state.get('decoderEvents',previous.get('decoderEvents',[]))[-20:]
        state['decoderEvents']=result['decoderEvents']
        result['reception']=reception;state['reception']=reception
    if role=='pi':
        try:
            r=subprocess.run(['vcgencmd','get_throttled'],capture_output=True,text=True,timeout=2)
            value=r.stdout.strip().split('=')[-1]
            if re.fullmatch(r'0x[0-9a-f]+',value):result['throttled']=value
        except (OSError,subprocess.TimeoutExpired):pass
    if role=='stream':
        try:result.update(browser_snapshot())
        except Exception:pass
        progress=stream/'ffmpeg.progress'
        try:
            fields=dict(line.split('=',1) for line in read_tail(progress).splitlines() if '=' in line)
            frame=int(fields.get('frame',0));out=number(fields.get('out_time_us'));elapsed=mono-previous.get('mono',mono)
            # Recent frame production，not the lifetime-average fps reported by FFmpeg．
            fps=(frame-previous['frame'])/elapsed if elapsed>0 and 'frame' in previous and frame>=previous['frame'] else None
            configured=None
            match=re.search(r'-framerate\s+(\d+)',pathlib.Path('/opt/qzss-stream/run.sh').read_text())
            if match:configured=int(match[1])
            result['encoder']={'fps':fps,'speed':number(fields.get('speed')),'dropped':number(fields.get('drop_frames')),'duplicated':number(fields.get('dup_frames')),'ageSeconds':max(0,wall-progress.stat().st_mtime),'configuredFps':configured}
            state.update(frame=frame,out=out)
        except (OSError,ValueError):pass
        health=read_json(stream/'browser-health.json');result['browser']={'healthy':health.get('healthy'),'reason':health.get('reason'),'ageSeconds':max(0,wall-health['checked_at']) if isinstance(health.get('checked_at'),(int,float)) else None}
        clocks=sorted((stream/'clock-observations').glob('*.jsonl'))
        if clocks:
            try:
                with clocks[-1].open('rb') as f:
                    f.seek(0,2);length=f.tell();f.seek(max(0,length-32768));lines=f.read().splitlines()
                clock=json.loads(lines[-1]);result['clockDifferenceSeconds']=clock.get('clockDifferenceSeconds');result['clockAgeSeconds']=max(0,wall-clock['at'])
            except (OSError,ValueError,KeyError,IndexError):pass
        result['recordings']=recording_state(stream)
    return result,state

def main():
    os.umask(0o077);role=os.environ['QZSS_METRICS_ROLE'];url=os.environ['QZSS_METRICS_URL'];token=os.environ['QZSS_METRICS_TOKEN'];previous={}
    if role not in ('server','stream','pi') or not (url.startswith('https://') or url.startswith('http://127.0.0.1:')):raise ValueError('invalid metrics configuration')
    while True:
        started=time.monotonic()
        try:
            data,previous=collect(role,previous)
            req=urllib.request.Request(url,data=json.dumps(data,allow_nan=False).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token},method='POST')
            with urllib.request.urlopen(req,timeout=5) as response:response.read(1024)
        except Exception as error:print('Metrics sample not delivered: '+type(error).__name__,flush=True)
        time.sleep(max(10,15-(time.monotonic()-started)))
if __name__=='__main__':main()
