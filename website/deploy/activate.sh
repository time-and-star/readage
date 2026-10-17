#!/bin/bash
set -euo pipefail
umask 077
test "$(id -u)" = 0
expected_sha=${1:?Expected deployment archive SHA-256 is required}
[[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]]
archive=/home/ubuntu/readage-website.tar
chmod 600 "$archive"
printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum --check --status
release=/srv/readage/releases/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 755 "$release"
tar --no-same-owner -xf "$archive" -C "$release"
# Deployment scripts and source can be corrected while the large immutable data archive uploads.
tar --no-same-owner -xf /home/ubuntu/readage-source.tar -C "$release"
test ! -e "$release/seed/update-signing-private.pem"
test ! -e /var/lib/readage/library.sqlite
test ! -e /var/lib/readage/guestbook.sqlite
cp -a "$release/seed/." /var/lib/readage/
chown -R readage:readage /var/lib/readage
find /var/lib/readage -type d -exec chmod 700 {} +
find /var/lib/readage -type f -exec chmod 600 {} +
find "$release/website" -type d -exec chmod 755 {} +
find "$release/website" -type f -exec chmod 644 {} +
python3 - <<'PY'
import hashlib, sqlite3
from pathlib import Path
data = Path('/var/lib/readage')
for name in ('library.sqlite', 'guestbook.sqlite'):
    with sqlite3.connect(f'file:{data / name}?mode=ro', uri=True) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        if name == 'library.sqlite':
            versions = list(db.execute('SELECT sha256, bytes FROM versions'))
            for sha, size in versions:
                file = data / 'library-files' / sha
                assert file.stat().st_size == size
                with file.open('rb') as stream: assert hashlib.file_digest(stream, 'sha256').hexdigest() == sha
            print('Verified resource counts:', dict(db.execute('SELECT kind, COUNT(*) FROM resources GROUP BY kind')))
            print('Verified file versions:', len(versions))
PY
ln -s "$release" /srv/readage/current
config="$release/website/deploy"
install -m 644 "$config/readage-website.service" /etc/systemd/system/
install -m 644 "$config/readage-backup.service" "$config/readage-backup.timer" /etc/systemd/system/
install -m 700 "$config/backup.sh" /usr/local/sbin/readage-backup
install -m 644 "$config/nginx-limits.conf" /etc/nginx/conf.d/readage-limits.conf
install -m 644 "$config/nginx-proxy.conf" /etc/nginx/snippets/readage-proxy.conf
install -m 644 "$config/nginx-site.conf" /etc/nginx/sites-available/readage
ln -sfn /etc/nginx/sites-available/readage /etc/nginx/sites-enabled/readage
nginx -t
systemd-analyze verify /etc/systemd/system/readage-website.service /etc/systemd/system/readage-backup.service /etc/systemd/system/readage-backup.timer
systemctl daemon-reload
systemctl enable --now readage-website.service
for i in $(seq 1 20); do
    if curl --fail --silent http://127.0.0.1:4175/api/updates/latest >/dev/null; then break; fi
    sleep 1
done
curl --fail --silent http://127.0.0.1:4175/api/updates/latest >/dev/null
systemctl reload nginx
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\n/usr/sbin/nginx -t && /bin/systemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/readage-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/readage-nginx
systemctl enable --now certbot.timer readage-backup.timer
systemctl start readage-backup.service
# The dedicated server has no other SSH authentication requirements; the provided key was verified.
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/00-readage.conf
/usr/sbin/sshd -t
systemctl reload ssh
echo WEBSITE_ACTIVATED
systemctl is-active readage-website nginx
systemctl list-timers readage-backup.timer certbot.timer --no-pager
ss -lntp
