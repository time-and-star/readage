#!/bin/sh
set -eu
umask 077
backup_root=/var/backups/readage
mkdir -p "$backup_root"
stage=$(mktemp -d "$backup_root/.snapshot.XXXXXXXX")
trap 'rm -f "$stage/guestbook.sqlite" "$stage/library.sqlite" "$stage/files.list"; rmdir "$stage"' EXIT
python3 - "$stage" <<'PY'
import re, sqlite3, sys
from pathlib import Path
for name in ('guestbook.sqlite', 'library.sqlite'):
    with sqlite3.connect(f'file:/var/lib/readage/{name}?mode=ro', uri=True) as source:
        with sqlite3.connect(str(Path(sys.argv[1]) / name)) as target:
            source.backup(target)
            assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            if name == 'library.sqlite':
                hashes = [row[0] for row in target.execute('SELECT sha256 FROM versions ORDER BY sha256')]
                assert all(re.fullmatch('[a-f0-9]{64}', value) for value in hashes)
                (Path(sys.argv[1]) / 'files.list').write_bytes(b''.join(
                    ('library-files/' + value).encode('ascii') + b'\0' for value in hashes))
PY
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_root/readage-$stamp.tar"
# Archive exactly the immutable versions in the database snapshot. A simultaneous
# sync may add files, but cannot change this list or invalidate directory mtimes.
tar -cf "$archive.partial" -C "$stage" guestbook.sqlite library.sqlite -C /var/lib/readage cookie.key --null --no-recursion -T "$stage/files.list"
mv "$archive.partial" "$archive"
# This directory contains only this service's own snapshots; retain seven days.
find "$backup_root" -maxdepth 1 -type f -name 'readage-*.tar' -mtime +6 -delete
