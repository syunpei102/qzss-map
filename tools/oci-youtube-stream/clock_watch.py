#!/usr/bin/env python3
"""時計を変更せず，VM・ブラウザ・エンコーダの観測値を保存する．"""
import datetime as dt
import json
import os
import pathlib
import time
import urllib.request
from browser_guard import Debugger, ROOT, PORT, CLOCK_CHECK


def observation(state, wall, monotonic, previous=None):
    expected=dt.datetime.fromtimestamp(wall,dt.timezone(dt.timedelta(hours=9))).strftime('%H:%M:%S')
    try:
        h,m,s=map(int,state['clock'].split(':'))
        e=dt.datetime.fromtimestamp(wall,dt.timezone(dt.timedelta(hours=9)))
        delta=(h*3600+m*60+s-(e.hour*3600+e.minute*60+e.second)+43200)%86400-43200
    except (KeyError,TypeError,ValueError):delta=None
    return {'at':wall,'monotonic':monotonic,'expectedJst':expected,'browser':state,
            'clockDifferenceSeconds':delta,
            'browserEpochDifferenceSeconds':state.get('now',wall*1000)/1000-wall,
            'hostClockJumpSeconds':None if not previous else (wall-previous['at'])-(monotonic-previous['monotonic'])}


def sample():
    pages=json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=5))
    page=next(p for p in pages if p.get('type')=='page' and p.get('url','').startswith('https://oracle-review.eq.shum10.com/'))
    debugger=Debugger(page['webSocketDebuggerUrl'])
    try:
        value=debugger.call('Runtime.evaluate',{'expression':CLOCK_CHECK,'returnByValue':True,'timeout':5000})
        return json.loads(value['result']['value'])
    finally:debugger.close()


def main():
    os.umask(0o077)
    root=ROOT/'clock-observations';root.mkdir(mode=0o700,exist_ok=True)
    previous=None;last_write=0
    while True:
        wall,mono=time.time(),time.monotonic()
        try:
            row=observation(sample(),wall,mono,previous)
            try:
                progress=dict(line.split('=',1) for line in (ROOT/'ffmpeg.progress').read_text().splitlines() if '=' in line)
                row['encoder']={k:progress.get(k) for k in ('out_time','speed','dup_frames','drop_frames','progress')}
                row['encoderProgressAgeSeconds']=wall-(ROOT/'ffmpeg.progress').stat().st_mtime
            except OSError:pass
            abnormal=(row['clockDifferenceSeconds'] is None or abs(row['clockDifferenceSeconds'])>5 or abs(row['hostClockJumpSeconds'] or 0)>5 or abs(row['browserEpochDifferenceSeconds'])>5)
            previous=row
        except Exception as error:
            row={'at':wall,'error':type(error).__name__};abnormal=True
        if abnormal or wall-last_write>=60:
            name=dt.datetime.fromtimestamp(wall,dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d')+'.jsonl'
            with (root/name).open('a') as output:output.write(json.dumps(row,ensure_ascii=False)+'\n')
            last_write=wall
            if abnormal:print('Clock observation anomaly recorded',flush=True)
        for p in root.glob('*.jsonl'):
            if wall-p.stat().st_mtime>7*86400:p.unlink()
        time.sleep(15)

if __name__=='__main__':main()
