"""Check the actual local NGINX TLS negotiation; certificate verification stays enabled."""
import json
import socket
import ssl
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)
results = []
for version in (ssl.TLSVersion.TLSv1, ssl.TLSVersion.TLSv1_1, ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3):
    context = ssl.create_default_context()
    context.minimum_version = context.maximum_version = version
    context.set_ciphers('DEFAULT:@SECLEVEL=0')
    allowed = version >= ssl.TLSVersion.TLSv1_2
    try:
        with socket.create_connection(('127.0.0.1', 443), timeout=5) as connection:
            with context.wrap_socket(connection, server_hostname='readage.xyz') as secure:
                negotiated = secure.version()
        assert allowed, f'Legacy TLS unexpectedly accepted: {version.name}'
        results.append({'version': version.name, 'accepted': True, 'negotiated': negotiated})
    except ssl.SSLError as error:
        if allowed: raise
        assert 'PROTOCOL_VERSION' in str(error), str(error)
        results.append({'version': version.name, 'accepted': False, 'reason': error.reason})
try:
    with socket.create_connection(('127.0.0.1', 443), timeout=5) as connection:
        with ssl.create_default_context().wrap_socket(connection, server_hostname='invalid.example'):
            raise AssertionError('Unknown SNI accepted')
except ssl.SSLError as error:
    assert 'UNRECOGNIZED_NAME' in str(error), str(error)
    results.append({'unknownSniRejected': True, 'reason': error.reason})
print(json.dumps({'passed': True, 'checks': results}, indent=2))
