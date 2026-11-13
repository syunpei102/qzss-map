import importlib.util
import pathlib
import sys
import unittest
from unittest import mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
import version_watch as watch

class VersionTests(unittest.TestCase):
    def test_only_changed_version_with_idle_ready_map_reloads(self):
        b={'version':'1.14.3','active':0,'ready':True}
        self.assertEqual(watch.decision(b,'1.14.3',0,1000),'current')
        self.assertEqual(watch.decision(b,'1.14.4',0,1000),'reload')
        self.assertEqual(watch.decision({**b,'active':1},'1.14.4',0,1000),'waiting-for-alerts-to-clear')
        self.assertEqual(watch.decision({**b,'active':None},'1.14.4',0,1000),'waiting-for-page')
        self.assertEqual(watch.decision({**b,'ready':False},'1.14.4',0,1000),'waiting-for-page')
        self.assertEqual(watch.decision(b,'1.14.4',900,1000),'reload-cooldown')

    def test_check_reads_actual_page_and_reloads_without_touching_encoder(self):
        page=mock.MagicMock()
        page.call.return_value={'result':{'value':'{"version":"1.14.3","active":0,"ready":true}'}}
        response=mock.MagicMock()
        response.__enter__.return_value=response
        response.read.return_value=b'[{"type":"page","url":"https://oracle-review.eq.shum10.com/","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/page/one"}]'
        with mock.patch.object(watch,'published_version',return_value='1.14.4'),mock.patch.object(watch.urllib.request,'urlopen',return_value=response),mock.patch.object(watch,'Debugger',return_value=page),mock.patch.object(watch.time,'time',return_value=1000):
            state=watch.check()
        self.assertEqual(state['action'],'reload')
        page.call.assert_any_call('Page.reload',{'ignoreCache':True})
        page.close.assert_called_once()
