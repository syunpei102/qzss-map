#!/usr/bin/env python3
"""Keep the visible capture browser healthy without restarting the encoder．"""
import base64
import hashlib
import json
import os
import pathlib
import signal
import socket
import struct
import subprocess
import time
import urllib.request

ROOT = pathlib.Path('/home/ubuntu/qzss-stream')
PORT = 9222
CLOCK_CHECK = '''JSON.stringify({clock:document.getElementById('now_time')?.textContent,
 now:Date.now(), zone:Intl.DateTimeFormat().resolvedOptions().timeZone,
 ready:document.readyState, url:location.href})'''


def exact(sock, count):
    result = bytearray()
    while len(result) < count:
        part = sock.recv(count - len(result))
        if not part:
            raise ConnectionError('Debugger closed')
        result.extend(part)
    return bytes(result)


class Debugger:
    """A bounded loopback-only CDP connection; never exposes a remote control port．"""
    def __init__(self, url):
        from urllib.parse import urlsplit
        parsed = urlsplit(url)
        if parsed.scheme != 'ws' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.port != PORT:
            raise ValueError('Unexpected debugger address')
        self.sock = socket.create_connection(('127.0.0.1', PORT), timeout=8)
        self.seq = 0
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f'GET {parsed.path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n'
                           'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                           f'Sec-WebSocket-Key: {key}\r\n\r\n').encode())
        headers = bytearray()
        while not headers.endswith(b'\r\n\r\n'):
            headers.extend(exact(self.sock, 1))
            if len(headers) > 16384:
                raise ValueError('Oversized handshake')
        expected = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        if b' 101 ' not in headers.split(b'\r\n')[0] or expected not in headers:
            self.close()
            raise ConnectionError('Debugger handshake failed')

    def close(self):
        self.sock.close()

    def send(self, payload, opcode=1):
        mask = os.urandom(4)
        length = len(payload)
        header = bytes([0x80 | opcode])
        header += bytes([0x80 | length]) if length < 126 else bytes([0xfe])+struct.pack('!H', length)
        self.sock.sendall(header+mask+bytes(x ^ mask[i % 4] for i,x in enumerate(payload)))

    def call(self, method, params=None):
        self.seq += 1
        self.send(json.dumps({'id':self.seq,'method':method,'params':params or {}}).encode())
        deadline = time.monotonic()+10
        message = bytearray()
        while time.monotonic() < deadline:
            self.sock.settimeout(max(.1, deadline-time.monotonic()))
            a,b = exact(self.sock,2)
            size = b & 127
            if size == 126:
                size = struct.unpack('!H', exact(self.sock,2))[0]
            elif size == 127:
                size = struct.unpack('!Q', exact(self.sock,8))[0]
            if size > 1024*1024 or b & 128:
                raise ValueError('Unexpected debugger frame')
            payload = exact(self.sock,size)
            if a & 15 == 8:
                raise ConnectionError('Debugger closed')
            if a & 15 == 9:
                self.send(payload,10)
                continue
            if a & 15 not in (0,1):
                continue
            message.extend(payload)
            if len(message) > 1024*1024:
                raise ValueError('Oversized debugger response')
            if a & 128:
                result = json.loads(message)
                message.clear()
                if result.get('id') == self.seq:
                    if 'error' in result:
                        raise RuntimeError('Debugger command rejected')
                    return result.get('result',{})
        raise TimeoutError('Debugger command timeout')


def clock_healthy(state, now):
    try:
        h,m,s = map(int,state['clock'].split(':'))
        if not (0 <= h < 24 and 0 <= m < 60 and 0 <= s < 60):
            return False
        expected = int(now+9*3600) % 86400
        delta = abs(h*3600+m*60+s-expected)
        return (state['zone'] == 'Asia/Tokyo' and min(delta,86400-delta) <= 5
                and abs(state['now']/1000-now) <= 5)
    except (ValueError,KeyError,TypeError,AttributeError):
        return False


def white_frame(pixels):
    return len(pixels) == 256 and sum(x >= 245 for x in pixels) >= 250


def health():
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=5) as response:
        pages = json.load(response)
    pages = [p for p in pages if p.get('type') == 'page' and p.get('url','').startswith('https://oracle-review.eq.shum10.com/')]
    if len(pages) != 1:
        return False, 'map-page-missing'
    debugger = Debugger(pages[0]['webSocketDebuggerUrl'])
    try:
        debugger.call('Emulation.setTimezoneOverride', {'timezoneId':'Asia/Tokyo'})
        result = debugger.call('Runtime.evaluate', {'expression':CLOCK_CHECK,'returnByValue':True,'timeout':5000})
        state = json.loads(result['result']['value'])
    finally:
        debugger.close()
    if not clock_healthy(state,time.time()):
        return False, 'clock-stale-or-wrong'
    # Inspect the actual X11 pixels, catching a blank compositor even if DOM is alive．
    frame = subprocess.run(['ffmpeg','-hide_banner','-nostdin','-loglevel','error','-f','x11grab',
                            '-video_size','1280x720','-i',':99.0','-frames:v','1','-vf',
                            'crop=1200:640:40:40,scale=16:16,format=gray','-f','rawvideo','pipe:1'],
                           capture_output=True,timeout=10,check=True).stdout
    if white_frame(frame):
        return False, 'white-screen'
    return True, 'healthy'


def stop_browser(process):
    try:
        os.killpg(process.pid,signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


def main():
    os.environ.update(DISPLAY=':99',TZ='Asia/Tokyo')
    process = None
    stopping = False
    def stop(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    try:
        while not stopping:
            process = subprocess.Popen(['google-chrome','--user-data-dir='+str(ROOT/'chrome-profile'),
                '--no-first-run','--no-default-browser-check','--disable-dev-shm-usage',
                '--disable-gpu','--disable-sync','--force-device-scale-factor=1','--lang=ja-JP',
                '--disable-background-timer-throttling','--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows','--remote-debugging-address=127.0.0.1',
                '--remote-debugging-port='+str(PORT),'--window-size=1280,720','--kiosk',
                'https://oracle-review.eq.shum10.com/?renderer=native'],start_new_session=True)
            started = time.monotonic()
            failures = 0
            while not stopping and process.poll() is None:
                time.sleep(1)
                elapsed = time.monotonic()-started
                if elapsed < 60 or int(elapsed) % 15:
                    continue
                try:
                    healthy, reason = health()
                except Exception as error:
                    healthy, reason = False, type(error).__name__
                failures = 0 if healthy else failures+1
                state = {'checked_at':time.time(),'healthy':healthy,'reason':reason,'failures':failures}
                temp = ROOT/'browser-health.json.tmp'
                temp.write_text(json.dumps(state));temp.replace(ROOT/'browser-health.json')
                if failures:
                    print('Browser health:',reason,'consecutive',failures,flush=True)
                if failures >= 3:
                    print('Recovering browser; encoder remains running',flush=True)
                    break
            stop_browser(process)
            if not stopping:
                time.sleep(5)
    finally:
        if process:
            stop_browser(process)


if __name__ == '__main__':
    main()
