import importlib.util
import pathlib
import unittest
import datetime

source=pathlib.Path(__file__).resolve().parents[1]/'browser_guard.py'
spec=importlib.util.spec_from_file_location('browser_guard',source)
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)

class BrowserHealthTests(unittest.TestCase):
    def test_jst_clock_and_wrong_timezone_and_stopped_clock(self):
        now=datetime.datetime(2026,11,13,8,50,10,tzinfo=datetime.timezone(datetime.timedelta(hours=9))).timestamp()
        state={'clock':'08:50:10','now':now*1000,'zone':'Asia/Tokyo'}
        self.assertTrue(guard.clock_healthy(state,now))
        self.assertFalse(guard.clock_healthy({**state,'clock':'04:00:00'},now))
        self.assertFalse(guard.clock_healthy({**state,'zone':'UTC'},now))
        self.assertFalse(guard.clock_healthy(state,now+20))
        self.assertFalse(guard.clock_healthy({**state,'now':(now-30)*1000},now))
        self.assertFalse(guard.clock_healthy({**state,'clock':None},now))

    def test_midnight_tolerance_and_malformed_time(self):
        now=datetime.datetime(2026,11,14,0,0,1,tzinfo=datetime.timezone(datetime.timedelta(hours=9))).timestamp()
        state={'clock':'23:59:59','now':now*1000,'zone':'Asia/Tokyo'}
        self.assertTrue(guard.clock_healthy(state,now))
        self.assertFalse(guard.clock_healthy({**state,'clock':'24:00:01'},now))

    def test_white_screen_matches_actual_pixels(self):
        self.assertTrue(guard.white_frame(bytes([255])*256))
        self.assertFalse(guard.white_frame(bytes([100])*256))
        self.assertFalse(guard.white_frame(bytes([255])*249+bytes([30])*7))
        self.assertFalse(guard.white_frame(b''))

if __name__=='__main__':unittest.main()
