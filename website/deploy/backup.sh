#!/bin/sh
set -eu
umask 077
backup_root=/var/backups/readage
mkdir -p "$backup_root"
stage=$(mktemp -d "$backup_root/.snapshot.XXXXXXXX")
trap 'rm -f "$stage/guestbook.sqlite" "$stage/library.sqlite"; rmdir "$stage"' EXIT
python3 - "$stage" <<'PY'
import sqlite3, sys
from pathlib import Path
for name in ('guestbook.sqlite', 'library.sqlite'):
    with sqlite3.connect(f'file:/var/lib/readage/{name}?mode=ro', uri=True) as source:
        with sqlite3.connect(str(Path(sys.argv[1]) / name)) as target:
            source.backup(target)
            assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
PY
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_root/readage-$stamp.tar"
tar -cf "$archive.partial" -C "$stage" guestbook.sqlite library.sqlite -C /var/lib/readage cookie.key library-files
mv "$archive.partial" "$archive"
# This directory contains only this service's own snapshots; retain seven days.
find "$backup_root" -maxdepth 1 -type f -name 'readage-*.tar' -mtime +6 -delete
