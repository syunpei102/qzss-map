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
        cases = [
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

    def test_transient_cpu_wait_does_not_stop_but_sustained_pressure_does(self):
        gate = w.Gate()
        gate.update(None, 0)
        self.assertTrue(gate.update(None, w.RESUME_SECONDS)[0])
        self.assertTrue(gate.update('host-contention', 10)[0])
        self.assertTrue(gate.update('host-contention', 19)[0])
        self.assertFalse(gate.update('host-contention', 20)[0])
        self.assertFalse(gate.update(None, 21)[0])
        self.assertTrue(gate.update(None, 21+w.RESUME_SECONDS)[0])
        self.assertTrue(gate.update('foreground-cpu', 30)[0])
        self.assertFalse(gate.update('foreground-cpu', 33)[0])
        self.assertFalse(gate.update('foreground-cpu', 34, severe=True)[0])

    def test_controller_converges_and_reduces_work_when_application_load_rises(self):
        control = w.Controller(2)
        for _ in range(120):
            total = 5 + 40 * control.duty
            control.adjust(total, 5)
        self.assertAlmostEqual(total, 30, delta=2.1)
        previous = control.duty
        control.adjust(total+15, 20)
        self.assertLess(control.duty, previous)
        for _ in range(100):control.adjust(0, 0)
        self.assertLessEqual(control.duty, 0.95)
        for _ in range(100):control.adjust(100, 100)
        self.assertGreaterEqual(control.duty, 0)

    def test_parallel_controller_converges_with_shared_cpu_wait(self):
        control = w.Controller(2, workers=2)
        for _ in range(150):
            total = 2 + 2 * 25 * control.duty
            control.adjust(total, 2)
        self.assertAlmostEqual(total, 30, delta=2.1)
        self.assertLessEqual(control.duty, 0.95)

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
