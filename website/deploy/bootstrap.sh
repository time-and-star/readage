#!/bin/bash
set -euo pipefail
umask 022
# Run as root on the explicitly selected Ubuntu server. No application data is replaced.
test "$(id -u)" = 0
install -d -m 755 /opt/readage-runtime /srv/readage/releases /var/www/readage-acme
install -d -m 700 /etc/readage /var/backups/readage
if ! id readage >/dev/null 2>&1; then useradd --system --home-dir /var/lib/readage --shell /usr/sbin/nologin readage; fi
install -d -o readage -g readage -m 700 /var/lib/readage
if [ ! -x /opt/readage-node/bin/node ]; then
    runtime_stage=$(mktemp -d)
    cd "$runtime_stage"
    curl --fail --silent --show-error --location --max-time 60 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o SHASUMS256.txt
    runtime_file=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64.tar.xz$/ {print $2}' SHASUMS256.txt)
    test -n "$runtime_file"
    curl --fail --silent --show-error --location --max-time 180 "https://nodejs.org/dist/latest-v22.x/$runtime_file" -o "$runtime_file"
    grep "  $runtime_file$" SHASUMS256.txt | sha256sum --check --status
    tar -xJf "$runtime_file" -C /opt/readage-runtime
    ln -s "/opt/readage-runtime/${runtime_file%.tar.xz}" /opt/readage-node
    rm "$runtime_file" SHASUMS256.txt
    cd /
    rmdir "$runtime_stage"
fi
/opt/readage-node/bin/node --version
if [ ! -f /etc/readage/website.env ]; then
    python3 - <<'PY'
import os, secrets
content = '\n'.join([
    'READAGE_WEBSITE_HOST=127.0.0.1', 'READAGE_WEBSITE_PORT=4175',
    'READAGE_WEBSITE_ORIGIN=https://readage.xyz', 'READAGE_WEBSITE_DATA_DIR=/var/lib/readage',
    'READAGE_WEBSITE_PROXY_IPS=127.0.0.1',
    'READAGE_LIBRARY_ADMIN_TOKEN=' + secrets.token_hex(32),
    'READAGE_LIBRARY_SYNC=true', 'NODE_ENV=production', ''])
fd = os.open('/etc/readage/website.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as handle: handle.write(content)
PY
fi
# On this previously unconfigured server, replace only the packaged default virtual host.
if [ -L /etc/nginx/sites-enabled/default ]; then unlink /etc/nginx/sites-enabled/default; fi
cat > /etc/nginx/sites-available/readage-bootstrap <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}
server {
    listen 80;
    listen [::]:80;
    server_name readage.xyz www.readage.xyz;
    location ^~ /.well-known/acme-challenge/ { root /var/www/readage-acme; }
    location / { return 503; }
}
NGINX
if [ ! -e /etc/nginx/sites-enabled/readage ]; then ln -s /etc/nginx/sites-available/readage-bootstrap /etc/nginx/sites-enabled/readage; fi
nginx -t
systemctl reload nginx
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo BOOTSTRAP_READY
