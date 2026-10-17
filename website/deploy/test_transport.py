import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from transport import make, apply

class TransportTests(unittest.TestCase):
    def test_exact_complete_roundtrip_after_insertions_and_changed_blocks(self):
        test_root = Path.cwd() / 'tmp/website-tests'
        test_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=test_root) as folder:
            root = Path(folder)
            old = [b'A'*16, b'B'*16, b'C'*16]
            new = [b'A'*16, b'inserted', b'C'*16, b'B'*16, b'new tail']
            for name, parts in [('old', old), ('new', new)]:
                (root/name).write_bytes(b''.join(parts))
                (root/(name+'.map')).write_bytes(gzip.compress(json.dumps({'version': '2', 'files': [{
                    'name': 'file', 'offset': 0, 'sizes': list(map(len, parts)),
                    'checksums': [hashlib.sha256(part).hexdigest() for part in parts]}]}).encode()))
            report = make(root/'old', root/'new', root/'old.map', root/'new.map', root/'delta.zip')
            self.assertEqual(report['literalBytes'], len(b'insertednew tail'))
            self.assertTrue(apply(root/'old', root/'delta.zip', root/'out')['verified'])
            self.assertEqual((root/'out').read_bytes(), b''.join(new))
            with self.assertRaises(AssertionError): apply(root/'old', root/'delta.zip', root/'out')
            with zipfile.ZipFile(root/'delta.zip') as archive:
                manifest = json.loads(archive.read('manifest.json'))
                manifest['targetSha256'] = '0'*64
                with zipfile.ZipFile(root/'corrupt.zip', 'w') as broken:
                    broken.writestr('manifest.json', json.dumps(manifest))
                    broken.writestr('payload.bin', archive.read('payload.bin'))
            with self.assertRaisesRegex(AssertionError, 'Complete installer SHA256'):
                apply(root/'old', root/'corrupt.zip', root/'corrupt-out')
            self.assertFalse((root/'corrupt-out').exists())
            self.assertFalse((root/'corrupt-out.partial').exists())
            (root/'old').write_bytes(b'corrupted')
            with self.assertRaisesRegex(AssertionError, 'Base SHA256'): apply(root/'old', root/'delta.zip', root/'bad')
            self.assertFalse((root/'bad').exists())

if __name__ == '__main__': unittest.main()
