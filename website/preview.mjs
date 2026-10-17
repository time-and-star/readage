import { createWebsiteServer } from './server.mjs';

const port = Number(process.env.READAGE_WEBSITE_PORT || 4175);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid READAGE_WEBSITE_PORT');
const host = process.env.READAGE_WEBSITE_HOST || '127.0.0.1';
const origin = process.env.READAGE_WEBSITE_ORIGIN;
if (origin && new URL(origin).origin !== origin) throw new Error('READAGE_WEBSITE_ORIGIN must be an origin without a trailing slash.');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !origin) throw new Error('Public hosting requires READAGE_WEBSITE_ORIGIN.');
const server = await createWebsiteServer({
  ...(process.env.READAGE_WEBSITE_DATA_DIR ? { dataDirectory: process.env.READAGE_WEBSITE_DATA_DIR } : {}),
  origins: origin ? [origin] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  secureCookie: Boolean(origin?.startsWith('https://')),
  trustedProxyIps: (process.env.READAGE_WEBSITE_PROXY_IPS || '').split(',').map(item => item.trim()).filter(Boolean),
  libraryOptions: {
    adminToken: process.env.READAGE_LIBRARY_ADMIN_TOKEN || '',
    syncOnBoot: process.env.READAGE_LIBRARY_SYNC === 'true',
    syncIntervalMs: process.env.READAGE_LIBRARY_SYNC === 'true' ? 6 * 60 * 60 * 1000 : 0,
  },
});
server.listen(port, host, () => console.log(`ReadAge website: ${origin || `http://127.0.0.1:${port}`}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
