"""Read-only functional checks plus bounded rejection checks against the owned website."""
import concurrent.futures
import hashlib
import http.client
import json
import ssl
import sys
import time
from pathlib import Path

host = 'readage.xyz'
base = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/var/lib/readage')
checks = []

def request(route, method='GET', body=None, headers=None, hostname=host, secure=True):
    connection = (http.client.HTTPSConnection(hostname, timeout=30, context=ssl.create_default_context())
                  if secure else http.client.HTTPConnection(hostname, timeout=30))
    try:
        connection.request(method, route, body, headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()

def check(name, condition, detail=None):
    checks.append({'name': name, 'passed': bool(condition), 'detail': detail})
    assert condition, (name, detail)

status, headers, homepage = request('/')
check('HTTPS homepage and CSP', status == 200 and b'ReadAge' in homepage and "frame-ancestors 'none'" in headers.get('Content-Security-Policy', ''))
check('HSTS and MIME protection', 'max-age=31536000' in headers.get('Strict-Transport-Security', '') and headers.get('X-Content-Type-Options') == 'nosniff')
for name, secure in [(host, False), ('www.readage.xyz', True)]:
    status, headers, _ = request('/?from=deployment-check', hostname=name, secure=secure)
    check(f'canonical redirect {name} https={secure}', status == 301 and headers.get('Location', '').startswith('https://readage.xyz/'))

status, _, body = request('/api/library/catalog')
catalog = json.loads(body)
items = catalog['items']; books = [item for item in items if item['kind'] == 'book']
check('public catalog keeps all 506 books and hosted magazines', status == 200 and len(books) == 506 and len(items) >= 522,
      {'books': len(books), 'total': len(items)})
check('no filesystem or admin credential in catalog', b'/var/lib/' not in body and b'ADMIN_TOKEN' not in body)
small = min(books, key=lambda item: item['bytes'])
status, headers, data = request(small['downloadPath'])
check('complete public EPUB download exact size and SHA256', status == 200 and len(data) == small['bytes'] and hashlib.sha256(data).hexdigest() == small['sha256'], small['sha256'])
time.sleep(1)
status, _, head = request(small['downloadPath'], method='HEAD')
check('HEAD supported', status == 200 and not head)
status, _, part = request(small['downloadPath'], headers={'Range': 'bytes=2-15'})
check('Range preserves original bytes', status == 206 and part == data[2:16])
status, _, _ = request(small['downloadPath'], headers={'If-None-Match': headers['ETag']})
check('ETag supported', status == 304)
time.sleep(1)
largest = max(books, key=lambda item: item['bytes'])
status, headers, part = request(largest['downloadPath'], headers={'Range': 'bytes=0-1023'})
with (base / 'library-files' / largest['sha256']).open('rb') as stream: original = stream.read(1024)
check('largest EPUB remains available with exact Range bytes', status == 206 and part == original and headers.get('Content-Range', '').endswith('/' + str(largest['bytes'])), largest['bytes'])

status, _, body = request('/api/updates/latest')
check('update manifest retains published versions', status == 200 and json.loads(body)['releases']['windows']['version'] == '0.1.2')
status, headers, body = request('/api/guestbook/session')
cookie = headers.get('Set-Cookie', '')
check('guestbook form, PNG captcha and secure cookie', status == 200 and json.loads(body)['challenge']['image'].startswith('data:image/png;base64,') and all(flag in cookie for flag in ['HttpOnly', 'SameSite=Lax', 'Secure']))
status, _, _ = request('/api/guestbook', 'POST', '{}', {'Origin': 'https://evil.example', 'Content-Type': 'application/json'})
check('cross-site publication denied', status == 403)
status, _, _ = request('/api/library/admin/upload', 'POST', 'unauthorized')
check('upload requires secret', status == 401)
status, _, _ = request('/api/guestbook', 'POST', 'x' * 9000, {'Content-Type': 'application/json'})
check('oversized anonymous body blocked at proxy', status == 413)
for route in ['/.env', '/.data/cookie.key', '/.data/library.sqlite', '/.git/config', '/server.mjs', '/deploy/nginx-site.conf', '/assets/../.data/guestbook.sqlite']:
    status, _, _ = request(route)
    check('private path denied ' + route, status == 404, status)

# 70 small read-only requests, not a load test. Never post test entries to the live board.
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    statuses = list(pool.map(lambda _: request('/api/updates/latest', headers={'X-Forwarded-For': '203.0.113.99'})[0], range(70)))
check('bounded burst receives rate-limit responses despite forged forwarding header', 429 in statuses and 200 in statuses, {str(code): statuses.count(code) for code in set(statuses)})
time.sleep(6)
status, _, _ = request('/api/updates/latest')
check('normal access recovers after burst', status == 200)
report = {'passed': all(item['passed'] for item in checks), 'checks': checks, 'scope': 'Public HTTPS HTTP behavior; no real message publication, administrative upload or installed app/device validation'}
print(json.dumps(report, ensure_ascii=False, indent=2))
