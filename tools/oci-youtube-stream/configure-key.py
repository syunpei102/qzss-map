#!/usr/bin/env python3
"""Read the key privately on the Mac and send it through SSH stdin．"""
import getpass
import json
import pathlib
import shlex
import subprocess
import sys

REMOTE = r'''
import json,os,pathlib,re,subprocess,sys,tempfile,time
key=json.load(sys.stdin)['key']
if not re.fullmatch(r'[A-Za-z0-9_-]{10,}',key):
    raise SystemExit('キーの形式を確認してください．設定は変更していません．')
path=pathlib.Path('/etc/qzss-stream.env')
fd,name=tempfile.mkstemp(prefix='.qzss-stream-',dir='/etc')
try:
    with os.fdopen(fd,'w') as file:
        file.write('QZSS_YT_SERVER="rtmps://a.rtmps.youtube.com:443/live2"\nQZSS_YT_KEY='+json.dumps(key)+'\n')
    os.replace(name,path)
finally:
    pathlib.Path(name).unlink(missing_ok=True)
subprocess.run(['systemctl','enable','qzss-stream'],check=True)
started=time.time()
subprocess.run(['systemctl','restart','qzss-stream'],check=True)
print('キーを保存し，送信を開始しています．確認まで最大約60秒待ちます．',flush=True)
progress=pathlib.Path('/home/ubuntu/qzss-stream/ffmpeg.progress')
deadline=time.monotonic()+60
while time.monotonic()<deadline:
    try:
        fresh=progress.stat().st_mtime>=started
        lines=progress.read_text().splitlines()
        fields=dict(line.split('=',1) for line in lines if '=' in line)
        if fresh and fields.get('progress')=='continue' and int(fields.get('frame','0'))>0:
            print('映像の送信進行を確認しました．SSHを閉じても送信と自動復旧は続きます．')
            print('YouTube Studioで映像と配信状態を確認してください．')
            raise SystemExit(0)
    except (OSError,ValueError):
        pass
    time.sleep(2)
raise SystemExit('送信進行を確認できませんでした．サービスは起動済みです．キーを伏せた状態で調査を依頼してください．')
'''

def main():
    if not sys.stdin.isatty():
        raise SystemExit('Macのターミナルから直接実行してください．')
    print('新しい配信枠のYouTube Studioから，ストリームキーの値をコピーしてください．')
    print('キーが同じ場合も再接続します．既存の送信は一度途切れます．')
    key=getpass.getpass('ストリームキーを貼り付けてEnter（非表示）: ').strip()
    if not key:
        raise SystemExit('未入力のため中止しました．')
    identity=pathlib.Path.home()/'Downloads'/'ssh-key-2026-11-11 (2).key'
    command=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','-i',str(identity),
             'ubuntu@129.203.128.122','sudo python3 -c '+shlex.quote(REMOTE)]
    result=subprocess.run(command,input=json.dumps({'key':key}),text=True)
    raise SystemExit(result.returncode)

if __name__=='__main__':
    main()
