#!/usr/bin/env python3
"""Continuously audit saved Oracle input，without accessing notification endpoints．"""
import collections
import datetime as dt
import hashlib
import json
import os
import pathlib
import statistics
import time

EXCLUDED = {'timestamp', 'sentence', 'nmea', 'raw', 'message', 'camf', 'a6a7_hazard_onset_datetime'}

def plain(value):
    if isinstance(value, dt.datetime): return value.isoformat()
    if isinstance(value, bytes): return value.hex()
    if isinstance(value, list): return [plain(v) for v in value]
    if isinstance(value, dict): return {k: plain(v) for k, v in value.items()}
    if value is None or isinstance(value, (str, int, float, bool)): return value
    return str(value)

def decode(sentence, reference):
    from azarashi.qzss_dcr_lib.decoder.nmea_qzss_dcr_decoder import NmeaQzssDcrDecoder
    report = NmeaQzssDcrDecoder(sentence, timestamp=reference).decode()
    return {**{k: plain(v) for k, v in report.get_params().items() if k not in EXCLUDED}, 'type': type(report).__name__}

def network_summary(heartbeats, now, connected, interruptions=()):
    times = sorted(set(t for t in heartbeats if now - 1800000 <= t <= now))
    gaps, excluded = [], 0
    for a, b in zip(times, times[1:]):
        if any(i.get('source') == 'oracle' and i.get('kind') == 'transport' and i.get('startedAt', now) < b and (i.get('endedAt') or now) > a for i in interruptions):
            excluded += 1
        elif b > a: gaps.append((b-a)/1000)
    ordered = sorted(gaps)
    return {'count': len(times), 'intervalCount': len(gaps), 'lastHeartbeatAt': times[-1] if times else None,
            'expectedSeconds': 30, 'medianSeconds': statistics.median(gaps) if gaps else None,
            'p95Seconds': ordered[min(len(ordered)-1, int(len(ordered)*.95))] if ordered else None,
            'jitterSeconds': round(statistics.mean(abs(g-30) for g in gaps), 3) if gaps else None,
            'lateIntervals': sum(g > 45 for g in gaps),
            'estimatedMissing': sum(max(0, int((g+5)//30)-1) for g in gaps),
            'excludedIntervals': excluded, 'observerConnected': connected}

class Analyzer:
    def __init__(self, root, decoder=decode):
        self.root = pathlib.Path(root); self.directory = self.root/'analysis'
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.decoder = decoder; self.cache = collections.OrderedDict()
        self.state = self.read('state.json', {'cursors': {}, 'heartbeats': [], 'results': [], 'seen': [], 'counts': {}, 'startedAt': round(time.time()*1000)})

    def read(self, name, fallback):
        try:
            p = self.directory/name
            if p.stat().st_size > 2000000: return fallback
            return json.loads(p.read_text())
        except (OSError, ValueError): return fallback

    def write(self, name, value):
        tmp = self.directory/(name+'.tmp')
        with tmp.open('w') as f: json.dump(value, f, ensure_ascii=False)
        tmp.replace(self.directory/name)

    def observe(self, row):
        report = row.get('report', {}); at = row.get('at')
        if row.get('source') != 'oracle' or not isinstance(at, (int, float)) or not isinstance(report, dict): return
        if report.get('type') == 'Heartbeat':
            self.state['heartbeats'].append(at); return
        if report.get('type') == 'ReceiverStatus' or report.get('replay_age_ms', 0) > 0: return
        if report.get('is_test_data') is True: return
        sentence = report.get('sentence') or report.get('nmea')
        semantic = {k: v for k, v in report.items() if k not in EXCLUDED and k != 'description' and k != 'client_timestamps' and k != 'replay_age_ms' and not k.startswith('display_')}
        receipt_day = dt.datetime.fromtimestamp(at/1000, dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d')
        key = hashlib.sha256(json.dumps([receipt_day, sentence, semantic], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if key in self.state['seen']: return
        self.state['seen'] = (self.state['seen']+[key])[-1000:]
        outcome, differences, error = 'missing-raw', [], None
        if isinstance(sentence, str) and len(sentence) <= 256:
            try:
                reference = dt.datetime.fromisoformat(report['timestamp']) if isinstance(report.get('timestamp'), str) else dt.datetime.fromtimestamp(at/1000, dt.timezone.utc).replace(tzinfo=None)
                cache_key = (sentence, reference.year, reference.month)
                if cache_key not in self.cache:
                    self.cache[cache_key] = self.decoder(sentence, reference)
                    if len(self.cache) > 256: self.cache.popitem(last=False)
                decoded = self.cache[cache_key]
                differences = [k for k, v in decoded.items() if k not in report or plain(report[k]) != v]
                outcome = 'mismatch' if differences else 'matched'
            except Exception as e:
                outcome, error = 'decode-error', type(e).__name__
        day = dt.datetime.fromtimestamp(at/1000, dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d')
        counts = self.state['counts'].setdefault(day, {})
        counts[outcome] = counts.get(outcome, 0)+1
        self.state['results'] = (self.state['results']+[{'at': at, 'key': key[:12], 'type': str(report.get('type', '不明'))[:80], 'outcome': outcome, 'differences': differences[:30], 'error': error}])[-100:]

    def poll(self, now=None):
        now = now or round(time.time()*1000)
        files = sorted((self.root/'reports').glob('????-??-??.jsonl'))[-2:]
        for p in files:
            stat = p.stat(); cursor = self.state['cursors'].get(p.name)
            offset = cursor['offset'] if cursor and cursor['inode'] == stat.st_ino and cursor['offset'] <= stat.st_size else max(0, stat.st_size-2*1024*1024)
            with p.open('rb') as f:
                f.seek(offset)
                if not cursor and offset: f.readline(262145)
                read = 0
                while read < 100:
                    mark = f.tell(); raw = f.readline(262145)
                    if not raw: break
                    if len(raw) > 262144:
                        read += 1; continue
                    if not raw.endswith(b'\n'):
                        f.seek(mark); break
                    read += 1
                    try: self.observe(json.loads(raw))
                    except (ValueError, TypeError): pass
                self.state['cursors'][p.name] = {'inode': stat.st_ino, 'offset': f.tell()}
        self.state['cursors'] = {p.name: self.state['cursors'][p.name] for p in files if p.name in self.state['cursors']}
        self.state['heartbeats'] = [t for t in self.state['heartbeats'] if now-86400000 <= t <= now][-10000:]
        cutoff = dt.datetime.fromtimestamp((now-7*86400000)/1000, dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d')
        self.state['counts'] = {k: v for k, v in self.state['counts'].items() if k >= cutoff}
        self.state['results'] = [r for r in self.state['results'] if r['at'] >= now-7*86400000]
        try: capture = json.loads((self.root/'capture-status.json').read_text())
        except (OSError, ValueError): capture = {}
        try: monitor = json.loads((self.root/'monitor.json').read_text())
        except (OSError, ValueError): monitor = {}
        connected = capture.get('sources', {}).get('oracle', {}).get('connected') is True and 0 <= now-capture.get('at', 0) <= 90000
        network = network_summary(self.state['heartbeats'], now, connected, monitor.get('incidents', []))
        backlog = sum(max(0, p.stat().st_size-self.state['cursors'].get(p.name, {}).get('offset', 0)) for p in files)
        today = dt.datetime.fromtimestamp(now/1000, dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d')
        view = {'at': now, 'startedAt': self.state['startedAt'], 'day': today, 'decoderVersion': 'azarashi 0.16.4', 'counts': self.state['counts'].get(today, {}), 'recent': self.state['results'][-20:], 'network': network, 'backlogBytes': backlog}
        self.write('state.json', self.state); self.write('public.json', view)
        return view

if __name__ == '__main__':
    import argparse
    os.umask(0o077)
    parser = argparse.ArgumentParser(); parser.add_argument('--data', default='/var/lib/qzss-ops'); parser.add_argument('--once', action='store_true'); args = parser.parse_args()
    analyzer = Analyzer(args.data)
    while True:
        analyzer.poll()
        if args.once: break
        time.sleep(5)
