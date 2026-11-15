import importlib.util,pathlib,sys,unittest,datetime
root=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(root))
import clock_watch as m
class ClockObservationTests(unittest.TestCase):
 def test_ahead_clock_is_observed_without_modifying_browser(self):
  wall=datetime.datetime(2026,11,14,8,tzinfo=datetime.timezone.utc).timestamp()
  state={'clock':'20:00:00','now':wall*1000,'zone':'Pacific/Fiji'}
  row=m.observation(state,wall,100)
  self.assertEqual(row['clockDifferenceSeconds'],10800);self.assertEqual(row['expectedJst'],'17:00:00');self.assertEqual(state['zone'],'Pacific/Fiji')
 def test_host_clock_jump_is_separated_from_elapsed_time(self):
  row=m.observation({'clock':'17:00:00','now':1000*1000},1000,115,{'at':100,'monotonic':100})
  self.assertEqual(row['hostClockJumpSeconds'],885)
class ProgressReadTests(unittest.TestCase):
 def test_large_log_is_bounded_and_incomplete_record_is_ignored(self):
  import tempfile,pathlib
  with tempfile.TemporaryDirectory() as root:
   p=pathlib.Path(root)/'progress'
   p.write_bytes(b'old=1\n'*100000+b'frame=100\ndrop_frames=3\nprogress=continue\nframe=999')
   self.assertEqual(m.read_progress(p,256)['frame'],'100')
   self.assertEqual(m.read_progress(p,256)['drop_frames'],'3')
   p.write_text('frame=123')
   self.assertEqual(m.read_progress(p),{})
if __name__=='__main__' :unittest.main()
