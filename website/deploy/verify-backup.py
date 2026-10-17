"""Read and validate a backup without restoring over live website data."""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import tarfile
import tempfile

backup = Path(sys.argv[1]).resolve()
assert backup.parent == Path('/var/backups/readage') and re.fullmatch(r'readage-\d{8}T\d{6}Z\.tar', backup.name)
with tarfile.open(backup) as archive, tempfile.TemporaryDirectory(prefix='.verify-', dir=backup.parent) as temporary:
    directory = Path(temporary)
    for name in ('library.sqlite', 'guestbook.sqlite'):
        (directory / name).write_bytes(archive.extractfile(name).read())
    assert len(archive.extractfile('cookie.key').read()) == 32
    with sqlite3.connect(f'file:{directory / "guestbook.sqlite"}?mode=ro', uri=True) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        messages = db.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
    with sqlite3.connect(f'file:{directory / "library.sqlite"}?mode=ro', uri=True) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        versions = list(db.execute('SELECT sha256, bytes FROM versions'))
        counts = dict(db.execute('SELECT kind, COUNT(*) FROM resources GROUP BY kind'))
    expected = {'library.sqlite', 'guestbook.sqlite', 'cookie.key'}
    for sha, size in versions:
        assert re.fullmatch('[a-f0-9]{64}', sha)
        name = 'library-files/' + sha; expected.add(name)
        assert archive.getmember(name).size == size
        assert hashlib.file_digest(archive.extractfile(name), 'sha256').hexdigest() == sha
    assert set(archive.getnames()) == expected
with backup.open('rb') as stream: archive_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
print(json.dumps({'passed': True, 'backup': str(backup), 'archiveSha256': archive_sha,
                  'resources': counts, 'verifiedVersions': len(versions), 'messages': messages,
                  'scope': 'Read-only archive verification; live data was not restored or modified'}))
