"""Package only the independent website and consistent, explicitly allowed public data."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tarfile

root = Path(__file__).resolve().parents[2]
output = root / 'tmp/website-deploy-2026-10-17'
stage = output / 'snapshot'
stage.mkdir(parents=True, exist_ok=True)
data = root / 'website/.data'
for name in ('guestbook.sqlite', 'library.sqlite'):
    with sqlite3.connect(f'file:{(data / name).as_posix()}?mode=ro', uri=True) as source:
        with sqlite3.connect(str(stage / name)) as target:
            source.backup(target)
            assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
with sqlite3.connect(str(stage / 'library.sqlite')) as db:
    counts = dict(db.execute('SELECT kind, COUNT(*) FROM resources GROUP BY kind'))
    versions = list(db.execute('SELECT sha256, bytes FROM versions'))
    for sha, size in versions:
        file = data / 'library-files' / sha
        assert file.is_file() and file.stat().st_size == size, sha
        assert hashlib.file_digest(file.open('rb'), 'sha256').hexdigest() == sha, sha
with sqlite3.connect(str(stage / 'guestbook.sqlite')) as db:
    messages = db.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
archive = output / 'readage-website.tar'
with tarfile.open(archive, 'w') as bundle:
    for file in sorted((root / 'website').iterdir()):
        if file.is_file() and file.suffix in ('.mjs', '.js', '.css', '.html', '.json'):
            bundle.add(file, arcname='website/' + file.name)
    bundle.add(root / 'website/assets', arcname='website/assets')
    bundle.add(root / 'website/deploy', arcname='website/deploy')
    for name in ('guestbook.sqlite', 'library.sqlite'):
        bundle.add(stage / name, arcname='seed/' + name)
    bundle.add(data / 'cookie.key', arcname='seed/cookie.key')
    for sha, _ in versions:
        bundle.add(data / 'library-files' / sha, arcname='seed/library-files/' + sha)
os.chmod(archive, 0o600)
summary = {'archive': str(archive), 'sha256': hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest(),
           'bytes': archive.stat().st_size, 'resources': counts, 'versions': len(versions), 'messages': messages,
           'excluded': ['learning profiles', 'SSH credentials', 'update signing private key', 'environment secrets']}
(output / 'package-report.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False))
