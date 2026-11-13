#!/usr/bin/env python3
"""Reload only on a published version change, keeping live encoding untouched．"""
import json
import pathlib
import re
import time
import urllib.request
from browser_guard import Debugger, ROOT, PORT

STATE = ROOT / 'version-watch.json'
EXPRESSION = '''JSON.stringify({version:globalThis.QZSS_APP_VERSION || null,
 active:typeof activeEvents==='undefined' ? null : activeEvents.size,
 ready:document.readyState==='complete' && typeof isInitialLoad!=='undefined' && !isInitialLoad})'''


def published_version():
    req=urllib.request.Request('https://oracle-review.eq.shum10.com/app-version.js',headers={'Cache-Control':'no-cache'})
    with urllib.request.urlopen(req,timeout=10) as response:
        text=response.read(2049).decode()
    match=re.fullmatch(r'\s*self\.QZSS_APP_VERSION\s*=\s*["\'](\d+\.\d+\.\d+)["\'];?\s*',text)
    if not match:
        raise ValueError('Invalid published version')
    return match[1]


def decision(browser, published, last_reload, now):
    if not browser.get('version') or browser.get('active') is None or not browser.get('ready'):
        return 'waiting-for-page'
    if browser['version']==published:
        return 'current'
    if browser['active'] != 0:
        return 'waiting-for-alerts-to-clear'
    if now-last_reload < 300:
        return 'reload-cooldown'
    return 'reload'


def check(last_reload=0):
    published=published_version()
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=5) as response:
        pages=json.load(response)
    pages=[p for p in pages if p.get('type')=='page' and p.get('url','').startswith('https://oracle-review.eq.shum10.com/')]
    if len(pages)!=1:
        raise ValueError('Expected one map page')
    debugger=Debugger(pages[0]['webSocketDebuggerUrl'])
    try:
        result=debugger.call('Runtime.evaluate',{'expression':EXPRESSION,'returnByValue':True,'timeout':5000})
        browser=json.loads(result['result']['value'])
        now=time.time()
        action=decision(browser,published,last_reload,now)
        if action=='reload':
            debugger.call('Page.reload',{'ignoreCache':True})
            last_reload=now
            print('Browser reload for published version',published,flush=True)
    finally:
        debugger.close()
    return {'checked_at':now,'published':published,'loaded':browser.get('version'),
            'action':action,'last_reload':last_reload}


def main():
    last_reload=0
    if STATE.exists():
        try:last_reload=json.loads(STATE.read_text()).get('last_reload',0)
        except (ValueError,OSError):pass
    while True:
        try:
            state=check(last_reload)
            last_reload=state['last_reload']
        except Exception as error:
            state={'checked_at':time.time(),'action':'check-failed','error':type(error).__name__,'last_reload':last_reload}
            print('Version check deferred:',type(error).__name__,flush=True)
        temp=STATE.with_suffix('.tmp');temp.write_text(json.dumps(state));temp.replace(STATE)
        time.sleep(60)


if __name__=='__main__':main()
