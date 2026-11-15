import importlib.util
import pathlib
import tempfile
import json
import datetime as dt
import unittest
spec=importlib.util.spec_from_file_location('analysis',pathlib.Path(__file__).parents[1]/'ops/analysis_worker.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
from test_qzss_decode import SAMPLES
AT=int(dt.datetime(2026,11,15,12,tzinfo=dt.timezone(dt.timedelta(hours=9))).timestamp()*1000)
class AnalysisTests(unittest.TestCase):
 def test_redecode_covers_eew_intensity_hypocenter_tsunami_weather_and_jalert(self):
  with tempfile.TemporaryDirectory() as root:
   a=m.Analyzer(root)
   for label,sentence,_,_,_ in SAMPLES:
    ref=dt.datetime(2026,11,15,12)
    report={**m.decode(sentence,ref),'sentence':sentence,'timestamp':ref.isoformat(),'display_event_id':'ignored'}
    a.observe({'at':AT,'source':'oracle','report':report})
   self.assertEqual([r['outcome'] for r in a.state['results']],['matched']*6)
 def test_mismatch_missing_raw_and_corrupt_input_are_distinguished(self):
  with tempfile.TemporaryDirectory() as root:
   a=m.Analyzer(root);sentence=SAMPLES[0][1];r={**m.decode(sentence,dt.datetime(2026,11,15)),'sentence':sentence,'timestamp':'2026-11-15T00:00:00','magnitude_raw':999}
   a.observe({'at':AT,'source':'oracle','report':r});self.assertIn('magnitude_raw',a.state['results'][-1]['differences'])
   a.observe({'at':AT,'source':'oracle','report':{'type':'Unknown'}});self.assertEqual(a.state['results'][-1]['outcome'],'missing-raw')
   a.observe({'at':AT,'source':'oracle','report':{'type':'Unknown','sentence':'bad'}});self.assertEqual(a.state['results'][-1]['outcome'],'decode-error')
   self.assertNotIn(sentence,json.dumps(a.state['results']))
 def test_journal_cursor_handles_partial_lines_restart_and_only_oracle(self):
  with tempfile.TemporaryDirectory() as root:
   folder=pathlib.Path(root)/'reports';folder.mkdir();file=folder/'2026-11-15.jsonl';line=json.dumps({'at':AT,'source':'oracle','report':{'type':'Heartbeat'}})+'\n';file.write_text(line+line[:-1]);a=m.Analyzer(root);a.poll(AT);self.assertEqual(len(a.state['heartbeats']),1)
   with file.open('a') as f:f.write('\n')
   a=m.Analyzer(root);a.poll(AT);self.assertEqual(len(a.state['heartbeats']),2)
   view=json.loads((pathlib.Path(root)/'analysis/public.json').read_text());self.assertNotIn('cursors',view);self.assertEqual(view['network']['count'],1)
 def test_network_estimates_exclude_observer_outages_and_cached_reports(self):
  times=[AT-120000,AT-90000,AT-30000,AT]
  out=m.network_summary(times,AT,True);self.assertEqual(out['estimatedMissing'],1);self.assertEqual(out['medianSeconds'],30)
  out=m.network_summary(times,AT,True,[{'source':'oracle','kind':'transport','startedAt':AT-85000,'endedAt':AT-35000}]);self.assertEqual(out['estimatedMissing'],0);self.assertEqual(out['excludedIntervals'],1)
  with tempfile.TemporaryDirectory() as root:
   a=m.Analyzer(root);a.observe({'at':AT,'source':'oracle','report':{'type':'ReceiverStatus','ageMs':1}});self.assertEqual(a.state['heartbeats'],[])
