#!/usr/bin/env python3
"""Read-only host sampler．No process command lines or credentials enter telemetry．"""
import json, math, os, pathlib, re, shutil, subprocess, time, urllib.request

def read_json(path):
    try:return json.loads(path.read_text())
    except (OSError,ValueError):return {}

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
    try:result['temperatureC']=int(pathlib.Path('/sys/class/thermal/thermal_zone0/temp').read_text())/1000
    except (OSError,ValueError):pass
    units={'server':{'docker':'docker','backup':'qzss-private-backup'},'stream':{'stream':'qzss-stream','clips':'qzss-clips','clock':'qzss-clock-watch','versionWatch':'qzss-version-watch','backup':'qzss-private-backup'},'pi':{'decoder':'qzss-decoder@qzss01','receptionWatch':'qzss-reception-watch.timer'}}[role]
    for name,unit in units.items():
        try:
            r=subprocess.run(['systemctl','is-active',unit if unit.endswith('.timer') else unit+'.service'],capture_output=True,text=True,timeout=2)
            result['services'][name]=r.stdout.strip() or 'unknown'
        except (OSError,subprocess.TimeoutExpired):result['services'][name]='unknown'
    if role=='pi':
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
            reception.update(lastFrameAt=cached.get('lastFrameAt'),journalCheckedAt=round(wall*1000),journalAvailable=False)
            try:
                r=subprocess.run(['journalctl','-u','qzss-decoder@qzss01.service','--since','@'+str(max(wall-180,cached.get('journalCheckedAt',0)/1000-1)),'-n','1500','-o','json','--no-pager'],capture_output=True,text=True,timeout=4)
                if r.returncode==0:
                    reception['journalAvailable']=True
                    for line in r.stdout.splitlines():
                        try:
                            log=json.loads(line);message=log.get('MESSAGE','')
                            if isinstance(message,str) and message.startswith('$QZQSM,'):reception['lastFrameAt']=int(log['__REALTIME_TIMESTAMP'])/1000
                        except (ValueError,KeyError,TypeError):pass
            except (OSError,subprocess.TimeoutExpired):pass
        else:
            for key in ('lastFrameAt','journalCheckedAt','journalAvailable'):reception[key]=cached.get(key)
        result['reception']=reception;state['reception']=reception
    if role=='pi':
        try:
            r=subprocess.run(['vcgencmd','get_throttled'],capture_output=True,text=True,timeout=2)
            value=r.stdout.strip().split('=')[-1]
            if re.fullmatch(r'0x[0-9a-f]+',value):result['throttled']=value
        except (OSError,subprocess.TimeoutExpired):pass
    if role=='stream':
        progress=stream/'ffmpeg.progress'
        try:
            fields=dict(line.split('=',1) for line in progress.read_text().splitlines() if '=' in line)
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
        counts={'recording':0,'pending':0,'uploaded':0,'failed':0}
        for file in (stream/'clips').glob('*/job.json'):
            job=read_json(file);status=job.get('state')
            key=status if status in counts else 'pending' if status in ('ready','uploading') else None
            if key:counts[key]+=1
        result['recordings']=counts
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
        time.sleep(max(1,15-(time.monotonic()-started)))
if __name__=='__main__':main()
