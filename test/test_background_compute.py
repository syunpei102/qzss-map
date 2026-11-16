import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('background_compute', pathlib.Path(__file__).parents[1] / 'tools/oci-background-compute/worker.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class BackgroundComputeTests(unittest.TestCase):
    def test_own_cpu_is_not_mistaken_for_foreground_work(self):
        # Two CPUs over one second: 50 ticks worker + 2 ticks application．
        foreground, steal = w.cpu_usage((0, 0, 0, 0), (200, 52, 0, 0.5), 100, 2)
        self.assertAlmostEqual(foreground, 1)
        self.assertEqual(steal, 0)

    def test_busy_low_memory_unhealthy_and_manual_stop_immediately(self):
        ready = {'at': 100, 'status': 'ready', 'notificationEnabled': True}
        gate = w.Gate()
        gate.update(None, 0)
        self.assertTrue(gate.update(None, 60)[0])
        cases = [(20, 0, 300*1024**2, ready, False, 'foreground-cpu'),
                 (1, 40, 300*1024**2, ready, False, 'host-contention'),
                 (1, 0, 100*1024**2, ready, False, 'low-memory'),
                 (1, 0, 300*1024**2, {}, False, 'server-not-ready'),
                 (1, 0, 300*1024**2, ready, True, 'manual-pause')]
        for cpu, steal, memory, status, manual, expected in cases:
            reason = w.pause_reason(cpu, steal, memory, status, 100, manual)
            self.assertEqual(reason, expected)
            self.assertFalse(gate.update(reason, 61)[0])
        self.assertFalse(gate.update(None, 62)[0])
        self.assertFalse(gate.update(None, 62+w.RESUME_SECONDS-1)[0])
        self.assertTrue(gate.update(None, 62+w.RESUME_SECONDS)[0])

    def test_stale_or_disabled_notifications_prevent_work(self):
        for status in [{'at': 1, 'status': 'ready', 'notificationEnabled': True},
                       {'at': 100, 'status': 'ready', 'notificationEnabled': False}]:
            self.assertEqual(w.pause_reason(0, 0, 300*1024**2, status, 100), 'server-not-ready')

    def test_numerical_result_is_correct_across_resumable_blocks(self):
        import math
        calculation = w.Integration(100000)
        for _ in range(26):
            calculation.block()
        self.assertEqual(calculation.rounds, 1)
        self.assertAlmostEqual(calculation.last_result, math.pi, places=9)
