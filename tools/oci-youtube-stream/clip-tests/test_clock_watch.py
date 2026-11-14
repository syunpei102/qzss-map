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
if __name__=='__main__':unittest.main()
