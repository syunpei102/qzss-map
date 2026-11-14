import importlib.util,pathlib,sys,tempfile,unittest,json
from unittest.mock import patch
source=pathlib.Path(__file__).parents[1]/'tools/oci-youtube-stream'
sys.path.insert(0,str(source))
import youtube_manager as manager
import event_clips as clips
class YouTubeTests(unittest.TestCase):
 def test_preserves_archive_and_rejects_long_or_ambiguous_description(self):
  current='古い本文\n\n'+clips.ARCHIVE_START+'\n録画URL\n'+clips.ARCHIVE_END
  result=manager.compose_description('新しい本文',current)
  self.assertIn('録画URL',result);self.assertTrue(result.startswith('新しい本文'))
  with self.assertRaises(OverflowError):manager.compose_description('あ'*2000,current)
  with self.assertRaises(ValueError):manager.base_text(clips.ARCHIVE_START)
 def test_apply_keeps_snippet_properties_and_never_sends_privacy(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);snippet={'title':'Live','description':'old','categoryId':'28','tags':['qzss']};command={'id':'test-command','liveId':'abcdefghijk','text':'new','baseRevision':manager.hashlib.sha256(b'old').hexdigest(),'expiresAt':9999999999999}
   def get(resource,params,headers):return {'items':[{'id':'abcdefghijk','status':{'lifeCycleStatus':'live'}}]} if resource=='liveBroadcasts' else {'items':[{'id':'abcdefghijk','snippet':snippet,'etag':'etag'}]}
   calls=[]
   def put(url,body,headers,method):
    data=json.loads(body);calls.append(data);self.assertNotIn('status',data);self.assertEqual(data['snippet']['tags'],['qzss']);return 200,{},json.dumps(data).encode()
   with patch.object(manager,'get_json',get),patch.object(manager,'request',put):
    result=manager.apply_command(root,command,{})
   self.assertEqual(result['status'],'applied');self.assertEqual(len(calls),1)
 def test_conflicting_base_and_changed_live_are_rejected(self):
  with tempfile.TemporaryDirectory() as directory:
   command={'id':'test','liveId':'abcdefghijk','text':'new','baseRevision':'wrong','expiresAt':9999999999999}
   def get(resource,params,headers):return {'items':[{'id':'abcdefghijk','status':{'lifeCycleStatus':'live'}}]} if resource=='liveBroadcasts' else {'items':[{'snippet':{'description':'changed'}}]}
   with patch.object(manager,'get_json',get),patch.object(manager,'request') as put:
    result=manager.apply_command(pathlib.Path(directory),command,{})
    self.assertEqual(result['status'],'conflict');put.assert_not_called()
 def test_lost_response_retry_is_idempotent(self):
  with tempfile.TemporaryDirectory() as directory:
   command={'id':'test','liveId':'abcdefghijk','text':'already applied','baseRevision':'old','expiresAt':9999999999999}
   def get(resource,params,headers):return {'items':[{'id':'abcdefghijk','status':{'lifeCycleStatus':'live'}}]} if resource=='liveBroadcasts' else {'items':[{'snippet':{'description':'already applied'}}]}
   with patch.object(manager,'get_json',get),patch.object(manager,'request') as put:
    self.assertEqual(manager.apply_command(pathlib.Path(directory),command,{})['status'],'applied');put.assert_not_called()
