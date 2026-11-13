import base64,json,os,pathlib,subprocess,sys,time,urllib.request,urllib.parse,uuid

def encode(value):return base64.urlsafe_b64encode(value).rstrip(b'=')
def upload(source,destination):
 cred=json.loads(pathlib.Path(os.environ['GOOGLE_APPLICATION_CREDENTIALS']).read_text());now=int(time.time())
 header=encode(b'{"alg":"RS256","typ":"JWT"}')
 payload=encode(json.dumps({'iss':cred['client_email'],'scope':'https://www.googleapis.com/auth/devstorage.read_write','aud':'https://oauth2.googleapis.com/token','iat':now,'exp':now+3600}).encode())
 unsigned=header+b'.'+payload
 import tempfile
 with tempfile.TemporaryDirectory() as d:
  key=pathlib.Path(d)/'key.pem';key.write_text(cred['private_key']);key.chmod(0o600)
  signature=subprocess.run(['openssl','dgst','-sha256','-sign',str(key)],input=unsigned,capture_output=True,check=True).stdout
 body=urllib.parse.urlencode({'grant_type':'urn:ietf:params:oauth:grant-type:jwt-bearer','assertion':(unsigned+b'.'+encode(signature)).decode()}).encode()
 with urllib.request.urlopen(urllib.request.Request('https://oauth2.googleapis.com/token',data=body),timeout=30) as r:token=json.load(r)['access_token']
 bucket,*prefix=destination.removeprefix('gs://').split('/')
 name='/'.join(prefix+[time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+str(uuid.uuid4())+'.cms'])
 url='https://storage.googleapis.com/upload/storage/v1/b/'+bucket+'/o?'+urllib.parse.urlencode({'uploadType':'media','name':name,'ifGenerationMatch':0})
 req=urllib.request.Request(url,data=pathlib.Path(source).read_bytes(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/pkcs7-mime'},method='POST')
 with urllib.request.urlopen(req,timeout=120) as r:
  if r.status not in (200,201):raise OSError('backup upload failed')
 print('Encrypted backup uploaded')
if __name__=='__main__':upload(*sys.argv[1:])
