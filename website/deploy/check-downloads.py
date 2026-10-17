"""Bounded public installer checks, including real concurrent Range transfers.

Uses local release artifacts as the byte oracle; never installs or changes data.
"""
import concurrent.futures
import hashlib
import http.client
import json
from pathlib import Path
import ssl
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = [
    ('ReadAge-0.1.4-windows-x64-setup.exe', ROOT / 'build/desktop/ReadAge-0.1.4-windows-x64-setup.exe'),
    ('ReadAge-1.0.6-android.apk', ROOT / 'android/app/build/outputs/apk/debug/app-debug.apk'),
]


def transfer(name, source, start, count, barrier=None):
    connection = http.client.HTTPSConnection('readage.xyz', timeout=45, context=ssl.create_default_context())
    started = time.monotonic()
    try:
        if barrier:
            barrier.wait(timeout=10)
        connection.request('GET', '/downloads/' + name, headers={'Range': f'bytes={start}-{start + count - 1}'})
        response = connection.getresponse()
        # Keep successful responses active together, exposing the old four-stream cap.
        first = response.read(1)
        if barrier:
            time.sleep(1)
        data = first + response.read()
        with source.open('rb') as stream:
            stream.seek(start)
            expected = stream.read(count)
        elapsed = time.monotonic() - started
        return {'file': name, 'start': start, 'status': response.status, 'bytes': len(data),
                'seconds': round(elapsed, 3), 'bytesPerSecond': round(len(data) / elapsed),
                'passed': response.status == 206 and data == expected and response.getheader('Content-Range') == f'bytes {start}-{start + count - 1}/{source.stat().st_size}',
                'sha256': hashlib.sha256(data).hexdigest()}
    finally:
        connection.close()


results = []
for name, source in PACKAGES:
    results.append(transfer(name, source, source.stat().st_size - 65536, 65536))
    time.sleep(1)
name, source = PACKAGES[1]
barrier = threading.Barrier(8)
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    results.extend(pool.map(lambda i: transfer(name, source, i * 1048576, 1048576, barrier), range(8)))
report = {'passed': all(item['passed'] for item in results), 'checks': results,
          'scope': '8 concurrent 1MiB ranges plus both installer tails; not a full download or device installation'}
print(json.dumps(report, indent=2))
sys.exit(0 if report['passed'] else 1)
