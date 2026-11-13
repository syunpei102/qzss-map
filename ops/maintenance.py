#!/usr/bin/env python3
"""録画検査・保持期限・暗号化バックアップ．動画本体を外部へ送らない．"""
import argparse, datetime, json, os, pathlib, shutil, subprocess, tempfile, time, urllib.request


def atomic(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def alert(message, state):
    url = os.environ.get('DISCORD_ALERT_WEBHOOK_URL', '')
    if not url:
        print('ALERT: ' + message, flush=True)
        return
    try:
        req = urllib.request.Request(url, data=json.dumps({'content': message}).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status >= 300: raise OSError('webhook failed')
    except Exception:
        print('Discord alert failed; inspect maintenance state', flush=True)


def inspect_video(video, output):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(video)], capture_output=True, text=True, timeout=30, check=True)
    duration = float(json.loads(result.stdout)['format']['duration'])
    if duration <= 0: raise ValueError('empty video')
    sample_at = min(60, duration / 2)
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', str(sample_at), '-i', str(video), '-frames:v', '1', '-vf', 'scale=640:-2', str(output)], capture_output=True, timeout=90, check=True)
    suspicious = []
    for fraction in (0.1, 0.5, 0.9):
        frame = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(duration*fraction), '-i', str(video), '-frames:v', '1', '-vf', 'scale=16:16,format=gray', '-f', 'rawvideo', 'pipe:1'], capture_output=True, timeout=60, check=True).stdout
        if len(frame) != 256 or sum(v >= 245 for v in frame) >= 250: suspicious.append(fraction)
    return {'duration': duration, 'white_frame_samples': suspicious, 'checked_at': time.time()}


def clips(root, now=None):
    now = time.time() if now is None else now
    index = root / 'recording-index'; index.mkdir(exist_ok=True)
    for path in sorted((root/'clips').glob('*/job.json')):
        job = json.loads(path.read_text())
        if job.get('state') not in ('uploaded','ready'): continue
        audit = path.parent/'audit.json'
        if not audit.exists():
            videos = list(path.parent.glob('*.mp4'))
            if not videos: continue
            try:
                check = inspect_video(videos[0], path.parent/'thumbnail.jpg')
                segments = sorted(job.get('segments',[]), key=lambda s:s['start'])
                check['gaps'] = [b['start']-(a['start']+a.get('duration',10)) for a,b in zip(segments,segments[1:]) if b['start']-(a['start']+a.get('duration',10)) > 2]
                atomic(audit, check)
                if check['white_frame_samples'] or check['gaps']: alert('録画に白画面または欠落の疑いがあります：'+path.parent.name, root)
            except Exception as error:
                atomic(audit, {'error': type(error).__name__, 'checked_at': now})
                alert('録画検査に失敗しました：'+path.parent.name,root)
        # 投稿済みだけを7日後に削除する．未投稿・投稿失敗は残す．
        if job.get('state') == 'uploaded' and now-job.get('uploaded_at',now) > 7*86400:
            atomic(index/(path.parent.name+'.json'), job)
            shutil.rmtree(path.parent)
    for p in index.glob('*.json'):
        if now-p.stat().st_mtime>30*86400:p.unlink()
    if shutil.disk_usage(root).free < 2*1024**3:
        alert('配信用VMの空き容量が2GiB未満です．未投稿動画は自動削除しません．',root)


def backup(cert, destination, paths):
    # 秘密鍵はMacだけに保持し，VMには暗号化用の公開証明書だけを配置する．
    available=[str(pathlib.Path(p)).lstrip('/') for p in paths if pathlib.Path(p).exists()]
    if not available: raise ValueError('no backup input')
    with tempfile.TemporaryDirectory(prefix='qzss-backup-') as directory:
        os.chmod(directory,0o700)
        archive=pathlib.Path(directory)/'state.tar.gz'; encrypted=pathlib.Path(directory)/'state.cms'
        subprocess.run(['tar','-czf',str(archive),'-C','/',*available],check=True,capture_output=True,timeout=120)
        subprocess.run(['openssl','cms','-encrypt','-aes-256-cbc','-binary','-in',str(archive),'-outform','DER','-out',str(encrypted),cert],check=True,capture_output=True,timeout=120)
        os.chmod(encrypted,0o600)
        subprocess.run(['python3',str(pathlib.Path(__file__).with_name('upload_backup.py')),str(encrypted),destination],check=True,timeout=180)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['clips','backup']);parser.add_argument('--root',default='/home/ubuntu/qzss-stream');parser.add_argument('--cert');parser.add_argument('--destination');parser.add_argument('paths',nargs='*');args=parser.parse_args()
    if args.mode=='clips':clips(pathlib.Path(args.root))
    else:backup(args.cert,args.destination,args.paths)
