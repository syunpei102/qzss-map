#!/usr/bin/env python3
"""Check the already-running notification server without sending notifications．"""
import json
import pathlib
import subprocess
import time
import urllib.request

ROOT = pathlib.Path('/var/lib/qzss-standby')
CONTAINER = 'qzss-server-review'

def recovery_due(failures, last_restart, now):
    return failures >= 3 and now - last_restart >= 300

def check():
    state_file = ROOT / 'state.json'
    try:
        previous = json.loads(state_file.read_text())
    except (OSError, ValueError):
        previous = {}
    now = time.time()
    status = {'at': now, 'failures': 0, 'lastRestart': previous.get('lastRestart', 0)}
    info = json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER], timeout=5))[0]
    if not info['State']['Running']:
        # Respect an explicit maintenance stop．Docker handles ordinary crashes．
        status['status'] = 'stopped'
    else:
        try:
            for route in ['/config', '/push/vapid-public-key']:
                with urllib.request.urlopen('http://127.0.0.1:8080' + route, timeout=5) as response:
                    data = json.load(response)
                if route == '/push/vapid-public-key':
                    status['notificationEnabled'] = data.get('enabled') is True
            status['status'] = 'ready' if status['notificationEnabled'] else 'configuration-error'
        except (OSError, ValueError):
            status['failures'] = min(100, previous.get('failures', 0) + 1)
            status['status'] = 'unresponsive'
            if recovery_due(status['failures'], status['lastRestart'], now):
                subprocess.run(['docker', 'restart', '--time', '20', CONTAINER], check=True, timeout=40)
                status.update(status='restarting', failures=0, lastRestart=now)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = ROOT / 'state.tmp'
    tmp.write_text(json.dumps(status))
    tmp.replace(state_file)
    print(json.dumps(status), flush=True)

if __name__ == '__main__':
    check()
