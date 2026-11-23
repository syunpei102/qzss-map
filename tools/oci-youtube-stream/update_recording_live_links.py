#!/usr/bin/env python3
"""Update uploaded recording descriptions to the stable current-live redirect."""
import argparse
import json
import pathlib
import re
import time
import urllib.parse
import urllib.error
import urllib.request

import event_clips as clips

API = 'https://www.googleapis.com/youtube/v3/videos'
HEADING = 'ライブ配信はこちら'
LINK = re.compile(r'(?m)^(ライブ配信はこちら\r?\n)(https://www\.youtube\.com/(?:live/|watch\?v=)[A-Za-z0-9_-]{11}|https://status\.shum10\.com/live)(\r?$)')


def replace_link(description):
    if description.count(HEADING) != 1:
        raise ValueError('Recording live-link heading is missing or ambiguous')
    changed, count = LINK.subn(lambda match: match.group(1) + clips.CURRENT_LIVE_URL + match.group(3), description)
    if count != 1 or len(changed.encode('utf-8')) > 5000:
        raise ValueError('Recording link is missing, ambiguous, or description is too long')
    return changed


def api(headers, method, params, body=None):
    url = API + '?' + urllib.parse.urlencode(params)
    _, _, raw = clips.request(url, json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
                              {**headers, **({'Content-Type': 'application/json; charset=UTF-8'} if body is not None else {})}, method)
    return json.loads(raw)


def redirected_live_id():
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, headers, url):
            return None

    try:
        urllib.request.build_opener(NoRedirect).open(clips.CURRENT_LIVE_URL, timeout=20)
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            raise
        location = error.headers.get('Location', '')
        return urllib.parse.parse_qs(urllib.parse.urlsplit(location).query).get('v', [''])[0]
    raise RuntimeError('Stable live URL did not redirect')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=pathlib.Path, default=clips.ROOT)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    jobs = [clips.read(path) for path in (args.root / 'clips').glob('*/job.json')]
    ids = sorted({job['video_id'] for job in jobs if job.get('state') == 'uploaded' and re.fullmatch(r'[A-Za-z0-9_-]{11}', job.get('video_id', ''))})
    if not ids:
        raise SystemExit('No uploaded recordings found')
    headers = clips.access_headers(args.root / 'youtube-oauth.json')
    result = api(headers, 'GET', {'part': 'snippet,status', 'id': ','.join(ids)})
    items = {item['id']: item for item in result['items']}
    if set(items) != set(ids):
        raise RuntimeError('YouTube recordings do not match uploaded jobs')
    updates = []
    for video_id in ids:
        item = items[video_id]
        old = item['snippet']['description']
        new = replace_link(old)
        if new != old:
            updates.append((video_id, item, new))
    print(f'Recordings: {len(ids)}, updates: {len(updates)}, target: {clips.CURRENT_LIVE_URL}', flush=True)
    if not args.apply:
        return
    # Confirm the redirect reaches the broadcast that YouTube currently marks live.
    broadcasts = clips.request('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=status&broadcastStatus=active&mine=true',
                               None, headers, 'GET')
    active_ids = {item['id'] for item in json.loads(broadcasts[2]).get('items', [])}
    target_id = redirected_live_id()
    if target_id not in active_ids:
        raise RuntimeError('Stable URL does not point to the active live broadcast')
    for video_id, item, new in updates:
        backup = args.root / 'recording-description-backups' / (video_id + '.json')
        if not backup.exists():
            clips.save(backup, {'saved_at': time.time(), 'item': item})
        snippet = item['snippet']
        mutable = {key: snippet[key] for key in ('title', 'categoryId', 'tags', 'defaultLanguage', 'defaultAudioLanguage') if key in snippet}
        mutable['description'] = new
        api({**headers, **({'If-Match': item['etag']} if item.get('etag') else {})}, 'PUT',
            {'part': 'snippet'}, {'id': video_id, 'snippet': mutable})
        checked = api(headers, 'GET', {'part': 'snippet,status', 'id': video_id})['items'][0]
        if checked['snippet']['description'] != new or checked['status']['privacyStatus'] != item['status']['privacyStatus']:
            raise RuntimeError('Post-update verification failed for ' + video_id)
        print('Updated and verified: ' + video_id, flush=True)


if __name__ == '__main__':
    main()
