#!/usr/bin/env python3
"""Verify the private OCI/source archive，or explicitly restore selected artifacts．"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import urllib.parse
import urllib.request


def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''): result.update(chunk)
    return result.hexdigest()


def verify(root):
    images = json.loads((root/'image-map.json').read_text())
    inventory = json.loads((root/'registry-inventory.json').read_text())
    expected = {(r['package'], r['version']) for r in inventory}
    if len(images) != len(inventory) or {(r['package'], r['version']) for r in images} != expected:
        raise ValueError('Incomplete image inventory')
    for row in images:
        if row['descriptor']['digest'] != row['version']: raise ValueError('Original image digest mismatch')
    blobs = root/'images/blobs/sha256'
    for file in blobs.iterdir():
        if digest(file) != file.name: raise ValueError('Image checksum mismatch: '+file.name)
    visited = set()
    def walk(desc):
        value = desc['digest']; algorithm, name = value.split(':', 1)
        if algorithm != 'sha256': raise ValueError('Unsupported digest')
        file = blobs/name
        if not file.is_file() or file.stat().st_size != desc['size']: raise ValueError('Missing or truncated descriptor: '+value)
        if value in visited: return
        visited.add(value)
        if 'json' not in desc.get('mediaType', ''): return
        data = json.loads(file.read_text())
        children = data.get('manifests', [])+data.get('layers', [])+data.get('blobs', [])
        for key in ['config', 'subject']:
            if isinstance(data.get(key), dict) and 'digest' in data[key]: children.append(data[key])
        for child in children: walk(child)
    for row in images: walk(row['descriptor'])
    sources = json.loads((root/'sources/inventory.json').read_text())
    for row in sources:
        file = root/row['local']
        if not file.is_file() or file.stat().st_size != row['size'] or digest(file) != row['sha256']: raise ValueError('Source checksum mismatch')
    print('Verified images:', len(images), 'referenced blobs:', len(visited), 'source objects:', len(sources))
    return images, sources


def image_restore(root, images, reference, destination):
    row = next(r for r in images if r['localRef'] == reference)
    target = destination or row['package']+':restored-'+row['version'].split(':')[1][:12]
    registry = target.split('/', 1)[0]
    token = subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True).strip()
    with tempfile.TemporaryDirectory(prefix='qzss-registry-auth-') as folder:
        auth = pathlib.Path(folder)/'auth.json'
        subprocess.run(['skopeo', 'login', '--authfile', str(auth), '--username', 'oauth2accesstoken', '--password-stdin', registry], input=token, text=True, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['skopeo', 'copy', '--all', '--preserve-digests', '--authfile', str(auth), 'oci:'+str(root/'images')+':'+reference, 'docker://'+target], check=True)
    print('Restored:', target, 'original digest:', row['version'])


def source_restore(root, sources, bucket, name, generation):
    candidates = [r for r in sources if r['bucket'] == bucket and r['name'] == name and (generation is None or r['generation'] == generation)]
    if len(candidates) != 1: raise ValueError('Select exactly one source generation from sources/inventory.json')
    row = candidates[0]
    # Never overwrite a current cloud object．Restored files receive a new generation．
    token = subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True).strip()
    params = {'uploadType':'media', 'name':name, 'ifGenerationMatch':'0'}
    url = 'https://storage.googleapis.com/upload/storage/v1/b/'+urllib.parse.quote(bucket, safe='')+'/o?'+urllib.parse.urlencode(params)
    headers = {'Authorization':'Bearer '+token, 'Content-Type':row.get('metadata', {}).get('contentType', 'application/octet-stream')}
    request = urllib.request.Request(url, data=(root/row['local']).read_bytes(), headers=headers, method='POST')
    with urllib.request.urlopen(request, timeout=180) as response: print('Source restored:', json.load(response)['name'])


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', type=pathlib.Path)
    parser.add_argument('--restore-image', help='image-0000 etc．No push unless explicitly specified')
    parser.add_argument('--destination', help='Registry/package:tag，defaults to restored-<original digest>')
    parser.add_argument('--restore-source', nargs=2, metavar=('BUCKET', 'NAME'))
    parser.add_argument('--generation')
    args = parser.parse_args();root = args.backup.expanduser().resolve()
    images, sources = verify(root)
    if args.restore_image: image_restore(root, images, args.restore_image, args.destination)
    if args.restore_source: source_restore(root, sources, *args.restore_source, args.generation)

if __name__ == '__main__': main()
