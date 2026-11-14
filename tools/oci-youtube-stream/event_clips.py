#!/usr/bin/env python3
"""Bounded HLS ring → event clips → resumable YouTube uploads．Stdlib only．"""
import argparse
import contextlib
import fcntl
import base64
import datetime as dt
import hashlib
import json
import os
import pathlib
import queue
import re
import secrets
import shutil
import socket
import ssl
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(os.environ.get('QZSS_CLIP_ROOT', '/home/ubuntu/qzss-stream'))
JST = dt.timezone(dt.timedelta(hours=9))
PRE, POST, MAX_SPAN = 60, 900, 1800


def save(path, data):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as file:
        json.dump(data, file, ensure_ascii=False)
    temporary.chmod(0o600)
    temporary.replace(path)


def read(path):
    return json.loads(pathlib.Path(path).read_text())


def playlist(path):
    """Only completed HLS fragments are listed; never copy an open fragment．"""
    lines = pathlib.Path(path).read_text().splitlines()
    result, start, duration = [], None, None
    for line in lines:
        if line.startswith('#EXT-X-PROGRAM-DATE-TIME:'):
            start = dt.datetime.fromisoformat(line.split(':', 1)[1].replace('Z', '+00:00')).timestamp()
        elif line.startswith('#EXTINF:'):
            duration = float(line.split(':', 1)[1].split(',')[0])
        elif line and not line.startswith('#') and start is not None and duration is not None:
            # This playlist is local; do not follow a remote or parent path．
            name = pathlib.Path(line).name
            result.append({'name': name, 'start': start, 'end': start + duration})
            start += duration
            duration = None
    return result


def report_names(report):
    number = report.get('disaster_category_no')
    category = {1: '緊急地震速報', 2: '震源情報', 3: '震度情報', 5: '津波情報'}.get(number, 'Jアラート')
    place = report.get('seismic_epicenter') if number in (1, 2, 3) else None
    if number == 5:
        category = report.get('tsunami_warning_code') or category
        areas = report.get('tsunami_forecast_regions', [])
    elif report.get('type') == 'QzssDcxJAlert':
        areas = report.get('ex9_target_area_list_ja', [])
    else:
        areas = []
    areas = list(dict.fromkeys(a for a in areas if isinstance(a, str) and a.strip())) if isinstance(areas, list) else []
    if report.get('type') == 'QzssDcxJAlert' and report.get('ex8_target_area_list_type') == 'Prefecture code' and len(areas) == 47:
        place = '全国'
    if not place and areas:
        place = '・'.join(areas[:3]) + ('ほか' if len(areas) > 3 else '')
    return str(category), str(place or '場所不明')


def video_title(job):
    date = dt.datetime.fromtimestamp(job['event_at'], JST)
    stamp = date.strftime('%Y年%m月%d日') + '（' + '月火水木金土日'[date.weekday()] + '）' + date.strftime('%H:%M')
    categories, places = [], []
    for event in job['events']:
        category = event.get('category') or ('動作検証' if job['test'] else event.get('label', 'QZSS通報'))
        place = event.get('place') or ('場所指定なし' if job['test'] else '場所不明')
        if category not in categories:
            categories.append(category)
        if place not in places:
            places.append(place)
    types = '＋'.join(categories[:3]) + ('ほか' if len(categories) > 3 else '')
    areas = '・'.join(places[:3]) + ('ほか' if len(places) > 3 else '')
    prefix = '【検証用】' if job['test'] else ''
    title = f'{prefix}{stamp}｜{types}｜{areas}'
    return ' '.join(title.replace('<', ' ').replace('>', ' ').split())[:100]


def trigger_for(report):
    if report.get('is_test_data') or report.get('report_classification_no') == 7:
        return None
    if report.get('a1_message_type') == 'Test' or report.get('a4_hazard_type') == 'Test alert':
        return None
    if report.get('information_type_no') == 2 or report.get('replay_age_ms', 0) > 5000:
        return None
    if report.get('disaster_category_no') not in (1, 2, 3, 5) and report.get('type') != 'QzssDcxJAlert':
        return None
    # Ignore RF identity, delivery latency and replay age when deduplicating．
    body = {k: v for k, v in report.items() if k not in (
        'satellite_id', 'satellite_prn', 'sentence', 'nmea', 'preamble',
        'message', 'timestamp', 'client_timestamps', 'replay_age_ms') and not k.startswith('display_')}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    category, place = report_names(report)
    return {'key': digest, 'label': f'{category} {place}', 'category': category,
            'place': place, 'test': False, 'at': time.time()}


def ws_reports():
    """Receive the public feed without sending any reports or credentials．"""
    with socket.create_connection(('oracle-review.eq.shum10.com', 443), timeout=30) as tcp:
        with ssl.create_default_context().wrap_socket(tcp, server_hostname='oracle-review.eq.shum10.com') as sock:
            sock.settimeout(60)
            key = base64.b64encode(secrets.token_bytes(16)).decode()
            sock.sendall(('GET / HTTP/1.1\r\nHost: oracle-review.eq.shum10.com\r\nUpgrade: websocket\r\n'
                          'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                          f'Sec-WebSocket-Key: {key}\r\n\r\n').encode())
            stream = sock.makefile('rb')
            status = stream.readline(4096)
            if b' 101 ' not in status:
                raise ConnectionError('WebSocket handshake failed')
            headers = {}
            for _ in range(100):
                line = stream.readline(4096)
                if line == b'\r\n':
                    break
                k, v = line.decode().split(':', 1)
                headers[k.lower()] = v.strip()
            expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            if headers.get('sec-websocket-accept') != expected:
                raise ConnectionError('WebSocket accept mismatch')

            def exact(count):
                data = stream.read(count)
                if len(data) != count:
                    raise ConnectionError('WebSocket closed')
                return data

            message = bytearray()
            while True:
                a, b = exact(2)
                size = b & 127
                if b & 128:
                    raise ConnectionError('Unexpected masked server frame')
                if size == 126:
                    size = struct.unpack('!H', exact(2))[0]
                elif size == 127:
                    size = struct.unpack('!Q', exact(8))[0]
                if size > 262144:
                    raise ConnectionError('WebSocket frame too large')
                payload = exact(size)
                opcode = a & 15
                if opcode == 8:
                    return
                if opcode == 9:
                    if size > 125:
                        raise ConnectionError('Invalid ping')
                    mask = secrets.token_bytes(4)
                    sock.sendall(bytes([0x8A, 0x80 | size]) + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(payload)))
                elif opcode in (0, 1):
                    if opcode == 1:
                        message.clear()
                    message.extend(payload)
                    if len(message) > 262144:
                        raise ConnectionError('WebSocket message too large')
                    if a & 128:
                        try:
                            yield json.loads(message)
                        except (ValueError, UnicodeError):
                            pass
                        message.clear()


class Recorder:
    def __init__(self, root=ROOT, pre=PRE, post=POST):
        self.root, self.pre, self.post = pathlib.Path(root), pre, post
        self.jobs = self.root / 'clips'
        self.jobs.mkdir(parents=True, exist_ok=True)
        self.seen_path = self.root / 'clip-seen.json'
        self.seen = read(self.seen_path) if self.seen_path.exists() else {}

    def manifests(self):
        return sorted(self.jobs.glob('*/job.json'))

    def trigger(self, event):
        now = event['at']
        self.seen = {k: v for k, v in self.seen.items() if time.time() - v < 172800}
        if event['key'] in self.seen:
            return None
        if shutil.disk_usage(self.root).free < 2 * 1024**3:
            print('Clip trigger skipped: less than 2GiB free disk space', flush=True)
            return None
        used = sum(p.stat().st_size for p in self.jobs.rglob('*') if p.is_file())
        if used > 3 * 1024**3:
            print('Clip trigger skipped: upload queue exceeds 3GiB', flush=True)
            return None
        active = [(p, read(p)) for p in self.manifests()]
        # Overlapping reports share a clip; never merge test and real reports．
        for path, job in active:
            if job['state'] == 'recording' and job['test'] == event['test'] and now <= job['end'] and now - job['event_at'] < MAX_SPAN - self.post:
                job['end'] = now + self.post
                job['events'].append(event)
                save(path, job)
                result = path
                break
        else:
            name = dt.datetime.fromtimestamp(now, JST).strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3)
            result = self.jobs / name / 'job.json'
            save(result, {'state': 'recording', 'event_at': now, 'start': now - self.pre,
                          'end': now + self.post, 'test': event['test'], 'events': [event],
                          'segments': [], 'created': time.time(), 'privacy': 'unlisted'})
        self.seen[event['key']] = time.time()
        save(self.seen_path, self.seen)
        return result

    def collect(self, now=None):
        now = time.time() if now is None else now
        # HLS only deletes fragments from its own current session．Remove old
        # fragments left by restarts; job fragments have already been copied．
        for fragment in (self.root / 'segments').glob('segment-*.ts'):
            try:
                if now - fragment.stat().st_mtime > 600:
                    fragment.unlink()
            except OSError:
                pass
        try:
            available = playlist(self.root / 'segments' / 'index.m3u8')
        except (OSError, ValueError):
            return
        for path in self.manifests():
            job = read(path)
            # 投稿済み7日・録画一覧30日の保持はmaintenance.pyが管理する．
            if job['state'] != 'recording':
                continue
            known = {s['name'] for s in job['segments']}
            for segment in available:
                if segment['end'] <= job['start'] or segment['start'] >= job['end'] or segment['name'] in known:
                    continue
                source = self.root / 'segments' / segment['name']
                try:
                    shutil.copyfile(source, path.parent / segment['name'])
                except OSError:
                    continue
                job['segments'].append(segment)
                known.add(segment['name'])
            job['segments'].sort(key=lambda s: s['start'])
            save(path, job)
            last_end = max((s['end'] for s in available), default=0)
            if now >= job['end'] and (last_end >= job['end'] or now > job['end'] + 45):
                self.finalize(path, job)

    def finalize(self, path, job):
        segments = job['segments']
        if not segments:
            job.update(state='failed', error='No recorded segments')
            save(path, job)
            return
        listing = path.parent / 'concat.txt'
        listing.write_text(''.join("file '" + s['name'] + "'\n" for s in segments))
        output = path.parent / 'clip.mp4'
        result = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                                 '-f', 'concat', '-safe', '1', '-i', str(listing), '-map', '0:v:0',
                                 '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', str(output)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
        if result.returncode:
            job.update(state='failed', error='FFmpeg remux failed')
        else:
            gap = sum(max(0, b['start'] - a['end']) for a, b in zip(segments, segments[1:]))
            job.update(state='ready', recorded_start=segments[0]['start'], recorded_end=segments[-1]['end'],
                       gap_seconds=round(gap, 3), pre_missing_seconds=round(max(0, segments[0]['start'] - job['start']), 3),
                       post_missing_seconds=round(max(0, job['end'] - segments[-1]['end']), 3))
            for segment in segments:
                (path.parent / segment['name']).unlink(missing_ok=True)
        save(path, job)


def request(url, data=None, headers=None, method='POST'):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        if error.code == 308:
            return error.code, dict(error.headers.items()), error.read()
        raise


ARCHIVE_START = '[過去の情報はこちら]'
ARCHIVE_END = '[録画一覧ここまで]'
EDIT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'


def archive_description(description, jobs):
    """Replace only our marked block; retain surrounding prose and deduplicate by video ID．"""
    if description.count(ARCHIVE_START) != description.count(ARCHIVE_END) or description.count(ARCHIVE_START) > 1:
        raise ValueError('Archive markers are ambiguous')
    entries = []
    if ARCHIVE_START in description:
        start, end = description.index(ARCHIVE_START), description.index(ARCHIVE_END)
        if end < start:
            raise ValueError('Archive markers are reversed')
        entries = [entry.strip() for entry in description[start + len(ARCHIVE_START):end].strip().split('\n\n') if entry.strip()]
        base = (description[:start] + description[end + len(ARCHIVE_END):]).rstrip()
    else:
        base = description.rstrip()
    for job in sorted(jobs, key=lambda item: item['event_at']):
        video_id = job['video_id']
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            raise ValueError('Invalid video ID')
        # An update may have succeeded even when its response was lost．
        entries = [entry for entry in entries if not re.search(r'https://youtu\.be/' + re.escape(video_id) + r'(?![A-Za-z0-9_-])', entry)]
        entries.insert(0, video_title(job) + '\nhttps://youtu.be/' + video_id)
    def compose():
        return (base + '\n\n' if base else '') + ARCHIVE_START + '\n' + '\n\n'.join(entries) + '\n' + ARCHIVE_END
    # YouTube API enforces a UTF-8 byte limit, not a Python character count．
    while entries and len(compose().encode('utf-8')) > 5000:
        entries.pop()
    result = compose()
    if not entries or len(result.encode('utf-8')) > 5000:
        raise ValueError('Description has no space for recording links')
    return result


def access_headers(auth_path):
    credentials = read(auth_path)
    form = urllib.parse.urlencode({**{k: credentials[k] for k in ('client_id', 'client_secret', 'refresh_token')},
                                   'grant_type': 'refresh_token'}).encode()
    _, _, raw = request('https://oauth2.googleapis.com/token', form, {'Content-Type': 'application/x-www-form-urlencoded'})
    return {'Authorization': 'Bearer ' + json.loads(raw)['access_token']}


@contextlib.contextmanager
def description_lock(root, timeout=20):
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.live-description.lock').open('a') as lock:
        started=time.monotonic()
        while True:
            try:
                fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic()-started>=timeout:raise TimeoutError('description lock busy')
                time.sleep(0.1)
        try:yield
        finally:fcntl.flock(lock.fileno(),fcntl.LOCK_UN)


def sync_archive(root):
    with description_lock(root):
        return _sync_archive(root)


def _sync_archive(root):
    """Independent from upload: errors never cause a completed clip to be uploaded again．"""
    auth_path = root / 'youtube-oauth.json'
    if EDIT_SCOPE not in read(auth_path).get('scopes', []):
        return
    jobs = [(path, read(path)) for path in sorted((root / 'clips').glob('*/job.json'))]
    pending = [(path, job) for path, job in jobs if job.get('state') == 'uploaded' and not job.get('archive_live_id') and not job.get('archive_excluded')]
    if not pending:
        return
    headers = access_headers(auth_path)
    _, _, raw = request('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id&broadcastStatus=active&broadcastType=all&maxResults=50',
                        headers=headers, method='GET')
    broadcasts = json.loads(raw).get('items', [])
    if len(broadcasts) != 1:
        raise ValueError('Expected exactly one active live broadcast')
    live_id = broadcasts[0]['id']
    _, _, raw = request('https://www.googleapis.com/youtube/v3/videos?' + urllib.parse.urlencode({'part': 'snippet', 'id': live_id}),
                        headers=headers, method='GET')
    snippet = json.loads(raw)['items'][0]['snippet']
    description = snippet.get('description', '')
    updated = archive_description(description, [job for _, job in pending])
    # Persist the original before any remote mutation．Never send status/privacy fields．
    backup = root / 'live-description-backups' / (live_id + '.json')
    if not backup.exists():
        save(backup, {'live_id': live_id, 'snippet': snippet})
    if updated != description:
        mutable = {key: snippet[key] for key in ('title', 'categoryId', 'tags', 'defaultLanguage', 'defaultAudioLanguage') if key in snippet}
        mutable['description'] = updated
        _, _, raw = request('https://www.googleapis.com/youtube/v3/videos?part=snippet',
                            json.dumps({'id': live_id, 'snippet': mutable}).encode(),
                            {**headers, 'Content-Type': 'application/json'}, 'PUT')
        if json.loads(raw).get('snippet', {}).get('description') != updated:
            raise ValueError('Description update could not be verified')
    for path, job in pending:
        job.update(archive_live_id=live_id, archive_linked_at=time.time())
        save(path, job)
    print('Recording links synchronized to live: ' + live_id, flush=True)


def upload(path, auth_path):
    job = read(path)
    headers = access_headers(auth_path)
    video = path.parent / 'clip.mp4'
    total = video.stat().st_size
    if not job.get('upload_session'):
        title = video_title(job)
        job['title'] = title
        before = round(job['event_at'] - job['start'])
        after = round(job['end'] - job['events'][-1]['at'])
        description = ('受信画面の動作検証用録画です．現在の警報ではありません．\n'
                       f'設定した録画区間：トリガーの約{before}秒前から，最後のトリガーの約{after}秒後まで．短い動画片の単位で保存しています．'
                       '続報が重なった場合は録画を延長しています．\n'
                       '通信・描画・録画の遅延や欠落があり得ます．防災判断には公式情報をご確認ください．\n'
                       f"録画欠落の記録：開始側 {job['pre_missing_seconds']}秒，終了側 {job['post_missing_seconds']}秒，区間内 {job['gap_seconds']}秒．\n")
        if job['test']:
            description = '手動トリガーまたはテストデータによる動作検証用の映像です．実際の災害発生を示すものではありません．\n' + description
        description += '\nライブ配信はこちら\nhttps://www.youtube.com/live/J52ePbw92yQ\n'
        metadata = {'snippet': {'title': title[:100], 'description': description, 'categoryId': '28'},
                    'status': {'privacyStatus': job['privacy'], 'selfDeclaredMadeForKids': False}}
        _, response_headers, _ = request('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
                                        json.dumps(metadata).encode(), {**headers, 'Content-Type': 'application/json',
                                        'X-Upload-Content-Length': str(total), 'X-Upload-Content-Type': 'video/mp4'})
        session = next(v for k, v in response_headers.items() if k.lower() == 'location')
        parsed = urllib.parse.urlsplit(session)
        if parsed.scheme != 'https' or not (parsed.hostname or '').endswith('.googleapis.com'):
            raise ValueError('Unexpected upload server')
        job['upload_session'] = session
        job['state'] = 'uploading'
        save(path, job)
    session = job['upload_session']
    # Query before resuming: a lost final response must not create a duplicate video．
    status, response_headers, raw = request(session, b'', {**headers, 'Content-Range': f'bytes */{total}'}, 'PUT')
    with video.open('rb') as file:
        while status == 308:
            accepted = next((v for k, v in response_headers.items() if k.lower() == 'range'), '')
            offset = int(accepted.rsplit('-', 1)[1]) + 1 if accepted else 0
            if offset >= total:
                raise ValueError('Invalid resumable offset')
            file.seek(offset)
            chunk = file.read(1024 * 1024)
            status, response_headers, raw = request(session, chunk, {**headers, 'Content-Type': 'video/mp4',
                           'Content-Range': f'bytes {offset}-{offset + len(chunk) - 1}/{total}'}, 'PUT')
    result = json.loads(raw)
    job.update(state='uploaded', video_id=result['id'], uploaded_at=time.time(),
               youtube_privacy=result.get('status', {}).get('privacyStatus'),
               youtube_title=result.get('snippet', {}).get('title', job.get('title')))
    job.pop('upload_session', None)
    save(path, job)
    print('Uploaded: https://youtu.be/' + result['id'], flush=True)


def daemon(root=ROOT):
    recorder = Recorder(root)
    events = queue.Queue(maxsize=100)

    def listen():
        while True:
            try:
                for report in ws_reports():
                    event = trigger_for(report)
                    if event:
                        events.put(event, timeout=1)
            except Exception as error:
                print('Feed reconnect:', type(error).__name__, flush=True)
            time.sleep(5)

    threading.Thread(target=listen, daemon=True).start()
    upload_process = None
    archive_process = None
    print('Event clips active: 60s before / 900s after; uploads require OAuth credentials', flush=True)
    while True:
        try:
            while True:
                try:
                    event = events.get_nowait()
                except queue.Empty:
                    break
                recorder.trigger(event)
            for path in (root / 'clip-triggers').glob('*.json'):
                event = read(path)
                recorder.trigger(event)
                path.unlink()
            recorder.collect()
            auth_path = root / 'youtube-oauth.json'
            archive_state = root / 'live-description-state.json'
            next_archive = read(archive_state).get('next_attempt', 0) if archive_state.exists() else 0
            if auth_path.exists() and time.time() >= next_archive and (archive_process is None or archive_process.poll() is not None):
                archive_status = read(archive_state) if archive_state.exists() else {}
                save(archive_state, {**archive_status, 'next_attempt': time.time() + 60})
                archive_process = subprocess.Popen(['python3', __file__, '--root', str(root), 'archive'])
            if auth_path.exists() and (upload_process is None or upload_process.poll() is not None):
                for path in recorder.manifests():
                    job = read(path)
                    if job['state'] in ('ready', 'uploading') and time.time() >= job.get('next_attempt', 0):
                        upload_process = subprocess.Popen(['python3', __file__, '--root', str(root), 'upload', str(path)])
                        break
        except Exception as error:
            print('Clip worker error:', type(error).__name__, flush=True)
        time.sleep(2)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=pathlib.Path, default=ROOT)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('daemon')
    sub.add_parser('archive')
    trigger = sub.add_parser('trigger')
    trigger.add_argument('--label', default='手動検証')
    uploader = sub.add_parser('upload')
    uploader.add_argument('job', type=pathlib.Path)
    args = parser.parse_args()
    if args.command == 'daemon':
        daemon(args.root)
    elif args.command == 'archive':
        try:
            sync_archive(args.root)
            save(args.root / 'live-description-state.json', {'next_attempt': time.time() + 60})
        except Exception as error:
            state_path = args.root / 'live-description-state.json'
            old = read(state_path) if state_path.exists() else {}
            attempts = old.get('attempts', 0) + 1
            code = error.code if isinstance(error, urllib.error.HTTPError) else None
            save(state_path, {'attempts': attempts, 'next_attempt': time.time() + min(3600, 60 * 2**min(attempts, 6)),
                              'last_error': f'{type(error).__name__} HTTP {code}'})
            print('Live description update deferred:', type(error).__name__, flush=True)
    elif args.command == 'trigger':
        target = args.root / 'clip-triggers' / (secrets.token_hex(8) + '.json')
        save(target, {'key': secrets.token_hex(16), 'label': args.label, 'at': time.time(), 'test': True})
        print('Manual test trigger queued')
    else:
        try:
            upload(args.job, args.root / 'youtube-oauth.json')
        except Exception as error:
            job = read(args.job)
            attempts = job.get('attempts', 0) + 1
            code = error.code if isinstance(error, urllib.error.HTTPError) else None
            # An expired session is ambiguous: preserve it for manual inspection．
            job.update(attempts=attempts, next_attempt=time.time() + min(3600, 30 * 2**min(attempts, 7)),
                       last_error=f'{type(error).__name__} HTTP {code}')
            if code in (400, 404, 410):
                job['state'] = 'blocked'
            save(args.job, job)
            print('Upload deferred:', job['last_error'], flush=True)


if __name__ == '__main__':
    main()
