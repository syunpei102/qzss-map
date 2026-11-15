import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('standby', pathlib.Path(__file__).parents[1] / 'ops/foundation-standby.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class StandbyTests(unittest.TestCase):
    def test_recovery_requires_three_failures_and_cooldown(self):
        self.assertFalse(mod.recovery_due(2, 0, 1000))
        self.assertFalse(mod.recovery_due(3, 900, 1000))
        self.assertTrue(mod.recovery_due(3, 700, 1000))

    def test_intentionally_stopped_container_is_not_restarted(self):
        with tempfile.TemporaryDirectory() as root, patch.object(mod, 'ROOT', pathlib.Path(root)), patch.object(mod.subprocess, 'check_output', return_value=b'[{"State":{"Running":false}}]'), patch.object(mod.subprocess, 'run') as run:
            mod.check()
            run.assert_not_called()

    def test_repeated_probe_timeout_restarts_once_then_waits(self):
        with tempfile.TemporaryDirectory() as root, patch.object(mod, 'ROOT', pathlib.Path(root)), patch.object(mod.subprocess, 'check_output', return_value=b'[{"State":{"Running":true}}]'), patch.object(mod.urllib.request, 'urlopen', side_effect=TimeoutError()), patch.object(mod.subprocess, 'run') as run:
            for _ in range(6):
                mod.check()
            run.assert_called_once_with(['docker', 'restart', '--time', '20', mod.CONTAINER], check=True, timeout=40)
