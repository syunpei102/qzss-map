import importlib.util,pathlib,tempfile,json,time,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('maintenance',pathlib.Path(__file__).resolve().parents[1]/'ops/maintenance.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class MaintenanceTests(unittest.TestCase):
 def test_only_uploaded_older_than_seven_days_is_removed(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);now=time.time()
   for name,state in [('done','uploaded'),('failed','ready')]:
    p=root/'clips'/name;p.mkdir(parents=True);(p/'job.json').write_text(json.dumps({'state':state,'uploaded_at':now-8*86400}));(p/'audit.json').write_text('{}')
   m.clips(root,now)
   self.assertFalse((root/'clips/done').exists());self.assertTrue((root/'clips/failed').exists());self.assertTrue((root/'recording-index/done.json').exists())
 def test_failed_inspection_is_recorded_and_video_is_retained(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);p=root/'clips/job';p.mkdir(parents=True);(p/'job.json').write_text('{"state":"ready"}');(p/'clip.mp4').write_bytes(b'bad')
   with patch.object(m,'inspect_video',side_effect=ValueError('bad')),patch.object(m,'alert') as alert:
    m.clips(root);self.assertTrue((p/'clip.mp4').exists());self.assertEqual(json.loads((p/'audit.json').read_text())['error'],'ValueError');alert.assert_called_once()
if __name__=='__main__':unittest.main()
