#!/usr/bin/env python3
"""Run on the Mac with an OAuth Desktop client JSON．No browser automation．"""
import base64
import hashlib
import http.server
import json
import pathlib
import secrets
import shlex
import subprocess
import sys
import urllib.parse
import urllib.request


def main():
    if len(sys.argv) != 2:
        raise SystemExit('使い方：python3 authorize-upload.py /絶対パス/client_secret.json')
    client = json.loads(pathlib.Path(sys.argv[1]).expanduser().read_text()).get('installed')
    if not client:
        raise SystemExit('デスクトップアプリ用のOAuthクライアントJSONを指定してください．')
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    result = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if query.get('state', [''])[0] != state:
                self.send_error(400)
                return
            result.update(query)
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write('認証結果を受け取りました．Macのターミナルに戻ってください．'.encode())

        def log_message(self, *args):
            pass

    with http.server.HTTPServer(('127.0.0.1', 0), Callback) as server:
        redirect = f'http://127.0.0.1:{server.server_port}/'
        params = {'client_id': client['client_id'], 'redirect_uri': redirect, 'response_type': 'code',
                  'scope': 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl', 'state': state,
                  'code_challenge': challenge, 'code_challenge_method': 'S256',
                  'access_type': 'offline', 'prompt': 'consent'}
        print('次のURLをMacのブラウザで開き，投稿先のYouTubeアカウントを選んで許可してください．', flush=True)
        print('https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(params), flush=True)
        server.timeout = 300
        while not result:
            server.handle_request()
            if not result:
                raise SystemExit('認証が完了しませんでした．再実行してください．')
    if 'code' not in result:
        raise SystemExit('認証が許可されませんでした．')
    body = urllib.parse.urlencode({'client_id': client['client_id'], 'client_secret': client['client_secret'],
                                  'code': result['code'][0], 'code_verifier': verifier,
                                  'grant_type': 'authorization_code', 'redirect_uri': redirect}).encode()
    request = urllib.request.Request('https://oauth2.googleapis.com/token', data=body)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            token = json.load(response)
    except Exception:
        raise SystemExit('認証情報の取得に失敗しました．再認証してください．') from None
    if not token.get('refresh_token'):
        raise SystemExit('継続投稿用の認証情報を取得できませんでした．')
    credentials = {k: client[k] for k in ('client_id', 'client_secret')}
    credentials['refresh_token'] = token['refresh_token']
    credentials['scopes'] = token.get('scope', '').split()
    if 'https://www.googleapis.com/auth/youtube.force-ssl' not in credentials['scopes']:
        raise SystemExit('概要欄を編集する権限が許可されませんでした．既存の認証情報は変更していません．')
    remote = '''import json,os,pathlib,sys,tempfile
p=pathlib.Path('/home/ubuntu/qzss-stream/youtube-oauth.json')
data=json.load(sys.stdin)
fd,name=tempfile.mkstemp(prefix='.oauth-',dir=p.parent)
with os.fdopen(fd,'w') as f: json.dump(data,f)
os.replace(name,p)
print('VMに投稿用の認証情報を保存しました．動画は限定公開で自動投稿され，配信中のライブ概要欄へ録画リンクを追記します．')
'''
    identity = pathlib.Path.home() / 'Downloads' / 'ssh-key-2026-11-11 (2).key'
    process = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', str(identity),
                              'ubuntu@129.203.128.122', 'python3 -c ' + shlex.quote(remote)],
                             input=json.dumps(credentials), text=True)
    raise SystemExit(process.returncode)


if __name__ == '__main__':
    main()
