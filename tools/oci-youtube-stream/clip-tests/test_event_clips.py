import importlib.util
import json
import pathlib
import tempfile
import time
import unittest
from unittest import mock

source = pathlib.Path(__file__).resolve().parents[1] / 'event_clips.py'
spec = importlib.util.spec_from_file_location('event_clips', source)
clips = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clips)


class ClipTests(unittest.TestCase):
    def test_trigger_filters_and_replay_dedup(self):
        report = {'type': 'QzssDcReportJmaEarthquakeEarlyWarning', 'disaster_category_no': 1, 'raw': 'abc'}
        first = clips.trigger_for(report)
        self.assertIsNotNone(first)
        self.assertEqual(first['key'], clips.trigger_for({**report, 'satellite_id': 61, 'timestamp': 'different', 'replay_age_ms': 5})['key'])
        for extra in ({'is_test_data': True}, {'report_classification_no': 7}, {'information_type_no': 2}, {'replay_age_ms': 6000}):
            self.assertIsNone(clips.trigger_for({**report, **extra}))
        jalert = {'type': 'QzssDcxJAlert', 'a1_message_type': 'Alert', 'a4_hazard_type': 'Test alert'}
        self.assertIsNone(clips.trigger_for(jalert))
        self.assertIsNotNone(clips.trigger_for({**jalert, 'a4_hazard_type': 'Earthquake'}))

    def test_playlist_only_finalized_segments_and_wall_time(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'index.m3u8'
            path.write_text('#EXTM3U\n#EXTINF:10.0,\n#EXT-X-PROGRAM-DATE-TIME:2026-11-12T10:00:00+09:00\na.ts\n#EXTINF:10.0,\nb.ts\n#EXTINF:10.0,\n')
            segments = clips.playlist(path)
            self.assertEqual(len(segments), 2)
            self.assertEqual(segments[1]['start'], segments[0]['end'])
            self.assertEqual(segments[1]['end'] - segments[0]['start'], 20)

    def test_pre_post_overlap_test_scope_and_persistence(self):
        with tempfile.TemporaryDirectory() as folder:
            worker = clips.Recorder(folder)
            now = time.time()
            event = {'key': 'first', 'label': 'EEW', 'at': now, 'test': False}
            path = worker.trigger(event)
            first = clips.read(path)
            self.assertEqual(first['start'], now - 60)
            self.assertEqual(first['end'], now + 900)
            self.assertIsNone(clips.Recorder(folder).trigger(event))
            self.assertEqual(worker.trigger({**event, 'key': 'second', 'at': now + 30}), path)
            self.assertEqual(clips.read(path)['end'], now + 930)
            other = worker.trigger({**event, 'key': 'test', 'test': True})
            self.assertNotEqual(other, path)
            self.assertEqual(clips.read(other)['privacy'], 'unlisted')

    def test_backfill_and_only_relevant_segments(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            segment_dir = root / 'segments'
            segment_dir.mkdir()
            worker = clips.Recorder(root, pre=3, post=6)
            now = time.time()
            path = worker.trigger({'key': 'x', 'label': 'test', 'test': True, 'at': now})
            stamp = clips.dt.datetime.fromtimestamp(now - 4, clips.JST).isoformat()
            (segment_dir / 'index.m3u8').write_text(f'#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:{stamp}\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n')
            for name in ('a.ts', 'b.ts'):
                (segment_dir / name).write_bytes(b'test')
            worker.collect(now=now)
            job = clips.read(path)
            self.assertEqual([s['name'] for s in job['segments']], ['a.ts', 'b.ts'])
            self.assertTrue((path.parent / 'a.ts').exists())
            self.assertEqual(job['state'], 'recording')

    def test_resumable_upload_visibility_and_no_duplicate_after_lost_response(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            job_path = root / 'job.json'
            auth_path = root / 'auth.json'
            clips.save(auth_path, dict(client_id='test', client_secret='test', refresh_token='test'))
            at = time.time()
            clips.save(job_path, dict(state='ready', event_at=at, start=at-60, end=at+900, events=[{'label':'test','at':at}], test=True,
                                     privacy='unlisted', pre_missing_seconds=0, post_missing_seconds=0, gap_seconds=0))
            (root / 'clip.mp4').write_bytes(b'x' * 100)
            calls = []

            def request(url, data=None, headers=None, method='POST'):
                calls.append((url, data, headers, method))
                if 'oauth2.googleapis.com' in url:
                    return 200, {}, b'{"access_token":"test"}'
                if 'uploadType=resumable' in url:
                    self.assertEqual(json.loads(data)['status']['privacyStatus'], 'unlisted')
                    self.assertIn('検証用', json.loads(data)['snippet']['title'])
                    return 200, {'Location':'https://www.googleapis.com/upload/session'}, b''
                if data == b'':
                    return 308, {}, b''
                self.assertEqual(headers['Content-Range'], 'bytes 0-99/100')
                return 200, {}, b'{"id":"video-test"}'

            with mock.patch.object(clips, 'request', request):
                clips.upload(job_path, auth_path)
            self.assertEqual(clips.read(job_path)['state'], 'uploaded')
            self.assertNotIn('upload_session', clips.read(job_path))
            job = clips.read(job_path)
            job.update(state='uploading', upload_session='https://www.googleapis.com/upload/existing')
            clips.save(job_path, job)
            calls.clear()

            def resumed(url, data=None, headers=None, method='POST'):
                calls.append(url)
                if 'oauth2.googleapis.com' in url:
                    return 200, {}, b'{"access_token":"test"}'
                self.assertEqual(data, b'')
                return 200, {}, b'{"id":"already-uploaded"}'

            with mock.patch.object(clips, 'request', resumed):
                clips.upload(job_path, auth_path)
            self.assertEqual(clips.read(job_path)['video_id'], 'already-uploaded')
            self.assertFalse(any('uploadType=resumable' in url for url in calls))

    def test_titles_use_japan_date_weekday_category_and_location(self):
        at = clips.dt.datetime(2026, 11, 12, 10, 22, tzinfo=clips.JST).timestamp()
        event = clips.trigger_for({'type':'QzssDcReportJmaEarthquakeEarlyWarning', 'disaster_category_no':1,
                                   'seismic_epicenter':'千島列島'})
        job = {'event_at':at,'events':[event],'test':False}
        self.assertEqual(clips.video_title(job), '2026年11月12日（木）10:22｜緊急地震速報｜千島列島')
        tsunami = clips.trigger_for({'disaster_category_no':5,'tsunami_warning_code':'津波警報',
                                    'tsunami_forecast_regions':['岩手県','宮城県']})
        self.assertEqual(tsunami['place'],'岩手県・宮城県')
        self.assertIn('津波警報｜岩手県・宮城県', clips.video_title({**job,'events':[tsunami]}))
        self.assertIn('緊急地震速報＋津波警報', clips.video_title({**job,'events':[event,tsunami]}))
        self.assertTrue(clips.video_title({**job,'test':True}).startswith('【検証用】'))
        self.assertLessEqual(len(clips.video_title({**job,'events':[{**event,'place':'長い地域名'*100}]})),100)

    def test_archive_preserves_prose_deduplicates_and_obeys_byte_limit(self):
        at = time.time()
        def job(index):
            return dict(event_at=at+index, events=[{'category':'津波情報','place':'太平洋沿岸'}], test=False,
                        video_id=f'{index:011d}')
        description = '既存の説明と注意事項\n'
        result = clips.archive_description(description, [job(i) for i in range(100)])
        self.assertTrue(result.startswith(description))
        self.assertLessEqual(len(result.encode()), 5000)
        self.assertIn('https://youtu.be/00000000099', result)
        self.assertNotIn('https://youtu.be/00000000000', result)
        self.assertEqual(clips.archive_description(result, [job(99)]), result)
        with self.assertRaises(ValueError):
            clips.archive_description('説明'*1800, [job(99)])
        with self.assertRaises(ValueError):
            clips.archive_description(clips.ARCHIVE_START, [job(99)])

    def test_archive_updates_only_snippet_and_recovers_lost_response(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            clips.save(root/'youtube-oauth.json', {'scopes':[clips.EDIT_SCOPE]})
            path = root/'clips'/'one'/'job.json'
            clips.save(path, dict(state='uploaded', event_at=time.time(), events=[{'category':'緊急地震速報','place':'千島列島'}],
                                 test=False, video_id='12345678901'))
            snippet = dict(title='ライブ配信', categoryId='28', description='既存の注意事項', tags=['QZSS'], defaultLanguage='ja')
            updates = []
            def request(url, data=None, headers=None, method='POST'):
                if 'liveBroadcasts?' in url:
                    return 200, {}, json.dumps({'items':[{'id':'live1234567'}]}).encode()
                if method == 'GET':
                    return 200, {}, json.dumps({'items':[{'snippet':snippet}]}).encode()
                payload = json.loads(data)
                self.assertEqual(set(payload), {'id','snippet'})
                self.assertEqual(payload['snippet']['title'], 'ライブ配信')
                self.assertEqual(payload['snippet']['tags'], ['QZSS'])
                updates.append(payload)
                snippet.update(payload['snippet'])
                raise TimeoutError('Response lost after successful update')
            with mock.patch.object(clips, 'access_headers', return_value={}), mock.patch.object(clips,'request',request):
                with self.assertRaises(TimeoutError):
                    clips.sync_archive(root)
                self.assertNotIn('archive_live_id', clips.read(path))
                self.assertEqual(clips.read(path)['state'], 'uploaded')
                clips.sync_archive(root)
            self.assertEqual(len(updates), 1)
            self.assertEqual(clips.read(path)['archive_live_id'], 'live1234567')
            self.assertEqual(snippet['description'].count('https://youtu.be/12345678901'), 1)
            self.assertTrue((root/'live-description-backups'/'live1234567.json').exists())

    def test_archive_requires_edit_scope_and_single_live(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            clips.save(root/'youtube-oauth.json', {'scopes':[]})
            with mock.patch.object(clips, 'request') as request:
                clips.sync_archive(root)
                request.assert_not_called()
            clips.save(root/'youtube-oauth.json', {'scopes':[clips.EDIT_SCOPE]})
            path = root/'clips'/'one'/'job.json'
            clips.save(path, dict(state='uploaded', video_id='12345678901'))
            for items in ([], [{'id':'one'},{'id':'two'}]):
                with mock.patch.object(clips,'access_headers',return_value={}), mock.patch.object(clips,'request',return_value=(200,{},json.dumps({'items':items}).encode())) as request:
                    with self.assertRaises(ValueError):
                        clips.sync_archive(root)
                    self.assertEqual(request.call_count,1)
                    self.assertEqual(clips.read(path)['state'], 'uploaded')

    def test_display_age_metadata_does_not_retrigger_recording(self):
        report={'type':'QzssDcReportJmaEarthquakeEarlyWarning','disaster_category_no':1,'raw':'real-report'}
        first=clips.trigger_for(report)
        repeated=clips.trigger_for({**report,'display_phase_age_ms':300000,'display_first_received_age_ms':300000,
                                   'display_last_received_age_ms':0,'display_event_id':'live|earthquake|time:T1'})
        self.assertEqual(first['key'],repeated['key'])


if __name__ == '__main__':
    unittest.main()
