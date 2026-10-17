#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
stage=/home/ubuntu/readage-transport
destination=/var/lib/readage-downloads
install -d -o root -g root -m 755 "$destination"
for filename in ReadAge-0.1.4-windows-x64-setup.exe ReadAge-1.0.6-android.apk; do
    test ! -e "$destination/$filename"
    install -o root -g root -m 644 "$stage/$filename" "$destination/$filename.partial"
done
cd "$destination"
printf '%s  %s\n' \
  c0cc236a7c41336c3c41da66da04559a3d953539f9593442aad7bd58e3f2427f ReadAge-0.1.4-windows-x64-setup.exe.partial \
  25c535a9595f7de4a2248ddfeb4b216f84f7624f68a1c164aaa2d512467392d8 ReadAge-1.0.6-android.apk.partial | sha256sum --check
for filename in ReadAge-0.1.4-windows-x64-setup.exe ReadAge-1.0.6-android.apk; do mv "$filename.partial" "$filename"; done
install -o root -g root -m 644 "$stage/SHA256SUMS.txt" "$destination/SHA256SUMS.txt"
sha256sum --check SHA256SUMS.txt
install -m 644 /home/ubuntu/readage-transport/nginx-site.conf /etc/nginx/sites-available/readage
nginx -t
systemctl reload nginx
echo INSTALLERS_PUBLISHED
