"""Reuse byte-identical blocks of a public old installer; verify complete SHA256 at both ends.

This is deployment transport, not an application update format. The published output is
the original complete signed installer, byte for byte. No user needs the old package.
"""
import gzip
import hashlib
import json
from pathlib import Path
import sys
import zipfile

def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def blocks(filename, size):
    value = json.loads(gzip.decompress(Path(filename).read_bytes()))
    assert value['version'] == '2' and len(value['files']) == 1
    file = value['files'][0]
    assert file['offset'] == 0 and len(file['sizes']) == len(file['checksums'])
    offset = 0
    for checksum, length in zip(file['checksums'], file['sizes']):
        assert isinstance(length, int) and 0 < length <= 1024 * 1024
        yield checksum, offset, length
        offset += length
    assert offset == size

def append(operations, kind, offset, length):
    if operations and operations[-1][0] == kind and operations[-1][1] + operations[-1][2] == offset:
        operations[-1][2] += length
    else:
        operations.append([kind, offset, length])

def make(base, target, base_map, target_map, output):
    base, target, output = Path(base), Path(target), Path(output)
    index = {}
    for checksum, offset, length in blocks(base_map, base.stat().st_size):
        index.setdefault((checksum, length), offset)
    operations, payload_size = [], 0
    payload = output.with_suffix('.payload.tmp')
    try:
        with base.open('rb') as previous, target.open('rb') as current, payload.open('xb') as literal:
            for checksum, offset, length in blocks(target_map, target.stat().st_size):
                current.seek(offset); data = current.read(length)
                assert len(data) == length
                match = index.get((checksum, length))
                if match is not None:
                    previous.seek(match)
                    if previous.read(length) == data:
                        append(operations, 'b', match, length)
                        continue
                literal.write(data)
                append(operations, 'd', payload_size, length)
                payload_size += length
        manifest = {'schema': 1, 'baseSha256': digest(base), 'targetSha256': digest(target),
                    'bytes': target.stat().st_size, 'operations': operations, 'literalBytes': payload_size}
        with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
            archive.writestr('manifest.json', json.dumps(manifest, separators=(',', ':')))
            archive.write(payload, 'payload.bin')
        return {'target': target.name, 'sha256': manifest['targetSha256'], 'bytes': manifest['bytes'],
                'transportBytes': output.stat().st_size, 'literalBytes': payload_size, 'operations': len(operations)}
    finally:
        payload.unlink(missing_ok=True)

def apply(base, delta, output):
    base, output = Path(base), Path(output)
    temporary = output.with_suffix(output.suffix + '.partial')
    assert not output.exists() and not temporary.exists()
    with zipfile.ZipFile(delta) as archive:
        assert archive.getinfo('manifest.json').file_size < 16 * 1024 * 1024
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['schema'] == 1 and digest(base) == manifest['baseSha256'], 'Base SHA256 mismatch'
        assert 0 < manifest['bytes'] < 4 * 1024**3 and len(manifest['operations']) <= 1_000_000
        assert archive.getinfo('payload.bin').file_size == manifest['literalBytes']
        total, literal_position, hash = 0, 0, hashlib.sha256()
        try:
            with base.open('rb') as previous, archive.open('payload.bin') as literal, temporary.open('xb') as destination:
                for kind, offset, length in manifest['operations']:
                    assert isinstance(offset, int) and isinstance(length, int) and offset >= 0 and length > 0
                    assert total + length <= manifest['bytes']
                    if kind == 'b':
                        assert offset + length <= base.stat().st_size
                        previous.seek(offset); source = previous
                    else:
                        assert kind == 'd' and offset == literal_position
                        assert offset + length <= manifest['literalBytes']
                        literal_position += length; source = literal
                    remaining = length
                    while remaining:
                        data = source.read(min(remaining, 1024 * 1024))
                        assert data, 'Truncated transport input'
                        hash.update(data); destination.write(data)
                        total += len(data); remaining -= len(data)
            assert total == manifest['bytes'] and literal_position == manifest['literalBytes']
            assert hash.hexdigest() == manifest['targetSha256'], 'Complete installer SHA256 mismatch'
            temporary.rename(output)
            return {'file': output.name, 'bytes': total, 'sha256': hash.hexdigest(), 'verified': True}
        finally:
            temporary.unlink(missing_ok=True)

if __name__ == '__main__':
    command, *arguments = sys.argv[1:]
    result = make(*arguments) if command == 'make' else apply(*arguments) if command == 'apply' else None
    assert result is not None, 'Expected make or apply'
    print(json.dumps(result))
