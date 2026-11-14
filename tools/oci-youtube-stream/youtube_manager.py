#!/usr/bin/env python3
"""Cache YouTube live metadata and apply explicitly queued description edits．"""
import datetime as dt
import hashlib
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
from event_clips import ROOT, ARCHIVE_START, ARCHIVE_END, access_headers, description_lock, read, save, request

API='https://www.googleapis.com/youtube/v3/'
POLL_SECONDS=300

def base_text(description):
    starts,ends=description.count(ARCHIVE_START),description.count(ARCHIVE_END)
    if starts!=ends or starts>1:raise ValueError('ambiguous archive markers')
    if not starts:return description.rstrip()
    a,b=description.index(ARCHIVE_START),description.index(ARCHIVE_END)
    if b<a:raise ValueError('reversed archive markers')
    return (description[:a]+description[b+len(ARCHIVE_END):]).rstrip()

def compose_description(template,current):
    base_text(current)
    if ARCHIVE_START in template or ARCHIVE_END in template or '<' in template or '>' in template:raise ValueError('invalid template')
    block=current[current.index(ARCHIVE_START):current.index(ARCHIVE_END)+len(ARCHIVE_END)] if ARCHIVE_START in current else ''
    result=template.rstrip()+ ('\n\n'+block if block and template.rstrip() else block)
    if len(result.encode('utf-8'))>5000:raise OverflowError('description too long')
    return result

def get_json(resource,params,headers):
    _,_,raw=request(API+resource+'?'+urllib.parse.urlencode(params),headers=headers,method='GET')
    return json.loads(raw)

def metadata(headers):
    rows=get_json('liveBroadcasts',{'part':'id,snippet,status','broadcastStatus':'active','broadcastType':'all','maxResults':5},headers).get('items',[])
    ids=','.join(r['id'] for r in rows)
    details={}
    if ids:
        details={r['id']:r for r in get_json('videos',{'part':'liveStreamingDetails','id':ids},headers).get('items',[])}
    broadcasts=[]
    for row in rows:
        snippet=row.get('snippet',{});status=row.get('status',{});live=details.get(row['id'],{}).get('liveStreamingDetails',{})
        broadcasts.append({'id':row['id'],'title':snippet.get('title',''),'description':snippet.get('description',''),'actualStartTime':snippet.get('actualStartTime') or live.get('actualStartTime'),'actualEndTime':snippet.get('actualEndTime') or live.get('actualEndTime'),'concurrentViewers':int(live['concurrentViewers']) if str(live.get('concurrentViewers','')).isdigit() else None,'privacyStatus':status.get('privacyStatus'),'lifeCycleStatus':status.get('lifeCycleStatus')})
    return {'broadcasts':broadcasts}

def apply_command(root,command,headers,now=None):
    now=time.time() if now is None else now
    result={'id':command['id'],'status':'failed','reason':'api-error'}
    if command.get('expiresAt',0)<now*1000:return {**result,'status':'expired','reason':'expired'}
    with description_lock(root):
        active=get_json('liveBroadcasts',{'part':'id,status','broadcastStatus':'active','broadcastType':'all','maxResults':5},headers).get('items',[])
        if len(active)!=1 or active[0]['id']!=command['liveId'] or active[0].get('status',{}).get('lifeCycleStatus') not in ('live','liveStarting'):
            return {**result,'status':'conflict','reason':'not-active'}
        video=get_json('videos',{'part':'snippet','id':command['liveId']},headers)['items'][0];snippet=video['snippet'];current=snippet.get('description','')
        try:updated=compose_description(command['text'],current)
        except OverflowError:return {**result,'reason':'too-long'}
        # If a successful response was lost，retrying the same command is harmless．
        if updated==current:return {**result,'status':'applied','reason':None}
        revision=hashlib.sha256(base_text(current).encode()).hexdigest()
        if revision!=command['baseRevision']:return {**result,'status':'conflict','reason':'base-changed'}
        save(root/'live-description-backups'/('edit-'+command['id']+'.json'),{'at':now,'live_id':command['liveId'],'snippet':snippet})
        mutable={k:snippet[k] for k in ('title','categoryId','tags','defaultLanguage','defaultAudioLanguage') if k in snippet};mutable['description']=updated
        write_headers={**headers,'Content-Type':'application/json'}
        if video.get('etag'):write_headers['If-Match']=video['etag']
        try:
            _,_,raw=request(API+'videos?part=snippet',json.dumps({'id':command['liveId'],'snippet':mutable}).encode(),write_headers,'PUT')
        except urllib.error.HTTPError as error:
            if error.code==412:return {**result,'status':'conflict','reason':'base-changed'}
            raise
        if json.loads(raw).get('snippet',{}).get('description')!=updated:raise ValueError('update not verified')
        return {**result,'status':'applied','reason':None}

def control(url,token,body):
    req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token},method='POST')
    with urllib.request.urlopen(req,timeout=10) as response:return json.load(response)

def classify(error):
    if isinstance(error,urllib.error.HTTPError):
        if error.code==401:return 'authorization'
        if error.code==403:
            try:
                reasons=[e.get('reason') for e in json.loads(error.read(8192)).get('error',{}).get('errors',[])]
                if any(x in ('quotaExceeded','dailyLimitExceeded') for x in reasons):return 'quota'
            except (ValueError,AttributeError):pass
            return 'authorization'
        return 'api'
    return 'network' if isinstance(error,(OSError,urllib.error.URLError)) else 'api'

def load_state(path):
    try:
        state=read(path)
        return state if isinstance(state,dict) else {}
    except (FileNotFoundError,ValueError):return {}

def main():
    os.umask(0o077);root=ROOT;url=os.environ['QZSS_METRICS_URL'].rsplit('/api/telemetry/',1)[0]+'/api/youtube/agent';token=os.environ['QZSS_METRICS_TOKEN']
    if not url.startswith('https://'):raise ValueError('HTTPS control URL required')
    statefile=root/'youtube-manager-state.json';state=load_state(statefile);next_poll=0;headers=None;token_at=0
    while True:
        body={'agentVersion':'1.18.1'}
        if state.get('ack'):body['ack']=state['ack']
        if time.monotonic()>=next_poll:
            try:
                headers=access_headers(root/'youtube-oauth.json');token_at=time.monotonic();body['metadata']=metadata(headers)
            except Exception as error:body['error']=classify(error);print('YouTube metadata check: '+body['error'],flush=True)
            next_poll=time.monotonic()+POLL_SECONDS
        try:
            response=control(url,token,body)
            if body.get('ack'):state.pop('ack',None);save(statefile,state)
            command=response.get('command')
            if command:
                if state.get('lastResult',{}).get('id')==command['id']:ack=state['lastResult']
                else:
                    try:
                        if not headers or time.monotonic()-token_at>2400:headers=access_headers(root/'youtube-oauth.json');token_at=time.monotonic()
                        ack=apply_command(root,command,headers)
                    except TimeoutError:ack={'id':command['id'],'status':'failed','reason':'lock-busy'}
                    except Exception as error:ack={'id':command['id'],'status':'failed','reason':'permission' if classify(error)=='authorization' else 'api-error'}
                    state['lastResult']=ack
                state['ack']=ack;save(statefile,state);next_poll=0
        except Exception as error:print('YouTube control temporarily unavailable: '+type(error).__name__,flush=True)
        time.sleep(15)
if __name__=='__main__':main()
