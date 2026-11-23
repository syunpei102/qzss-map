import importlib.util
import pathlib
import sys
import unittest

root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('update_recording_live_links', root / 'update_recording_live_links.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RecordingLinkTests(unittest.TestCase):
    def test_replace_only_recording_link(self):
        old = '注意事項\n\nライブ配信はこちら\nhttps://www.youtube.com/live/J52ePbw92yQ\n\nその他の情報\n'
        self.assertEqual(module.replace_link(old), old.replace('https://www.youtube.com/live/J52ePbw92yQ', module.clips.CURRENT_LIVE_URL))
        self.assertEqual(module.replace_link(module.replace_link(old)), module.replace_link(old))

    def test_ambiguous_description_is_rejected(self):
        with self.assertRaises(ValueError):
            module.replace_link('ライブ配信はこちら\nhttps://example.com/unknown\n')
        with self.assertRaises(ValueError):
            module.replace_link('ライブ配信はこちら\nhttps://www.youtube.com/live/J52ePbw92yQ\nライブ配信はこちら\n')
