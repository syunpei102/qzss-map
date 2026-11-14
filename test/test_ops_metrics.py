import importlib.util,pathlib,unittest,tempfile
spec=importlib.util.spec_from_file_location('metrics_agent',pathlib.Path(__file__).parents[1]/'ops/metrics-agent.py')
agent=importlib.util.module_from_spec(spec);spec.loader.exec_module(agent)
class MetricsTests(unittest.TestCase):
 def test_cpu_excludes_idle_iowait_and_steal(self):
  cpu,steal=agent.cpu_delta([10,0,10,60,5,0,0,15],[0]*8)
  self.assertEqual(cpu,20);self.assertEqual(steal,15)
 def test_first_sample_and_counter_reset_are_unknown(self):
  self.assertEqual(agent.cpu_delta([0]*8,None),(None,None))
  self.assertEqual(agent.cpu_delta([0]*8,[1]*8),(None,None))
 def test_speed_parser(self):
  self.assertEqual(agent.number('1.02x'),1.02);self.assertIsNone(agent.number('N/A'))

 def test_tail_read_is_bounded_for_long_running_encoder(self):
  with tempfile.TemporaryDirectory() as directory:
   path=pathlib.Path(directory)/'progress'
   path.write_bytes(b'old=1\n'*100000+b'frame=12345\nfps=15.0\nspeed=1.0x\nprogress=continue\n')
   tail=agent.read_tail(path,256)
   self.assertLessEqual(len(tail.encode()),256)
   self.assertIn('frame=12345',tail)
   self.assertTrue(tail.endswith('progress=continue\n'))

 def test_network_snapshot_and_crash_classification(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);(root/'net').mkdir();(root/'interfaces/wlan0').mkdir(parents=True)
   (root/'net/route').write_text('Iface Destination Gateway Flags\nwlan0 00000000 0100000A 0003\n')
   (root/'net/wireless').write_text('wlan0: 0000 70. -40. -256. 0 0\n')
   (root/'interfaces/wlan0/operstate').write_text('up');(root/'interfaces/wlan0/carrier').write_text('1')
   network=agent.network_state(root,root/'interfaces')
   self.assertTrue(network['carrier']);self.assertEqual(network['interface'],'wlan0');self.assertEqual(network['wifiDbm'],-40)
  event=agent.decoder_event({'SYSLOG_IDENTIFIER':'systemd','MESSAGE':'unit: Main process exited, code=dumped, status=11/SEGV','__REALTIME_TIMESTAMP':'1234000'})
  self.assertEqual(event['kind'],'crash');self.assertEqual(event['at'],1234)
  self.assertIsNone(agent.decoder_event({'SYSLOG_IDENTIFIER':'python3','MESSAGE':'sensitive raw data'}))
