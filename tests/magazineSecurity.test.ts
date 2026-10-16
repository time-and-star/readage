import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { issueFileKey, parseIssueId } from '../server/magazines/config';
import { downloadFile, listRepoContents } from '../server/magazines/github';
import { parseSyncRequest } from '../server/magazines/routes';
import { readJsonFile, writeFileAtomic } from '../server/magazines/store';

const originalFetch = globalThis.fetch;
const originalMaxBytes = process.env.MAGAZINE_DOWNLOAD_MAX_BYTES;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv('MAGAZINE_DOWNLOAD_MAX_BYTES', originalMaxBytes);
});

describe('magazine issue identifiers', () => {
  it('accepts canonical issue ids without decoding a second time', () => {
    assert.deepEqual(parseIssueId('economist:2026.07.18'), {
      sourceId: 'economist',
      issueLabel: '2026.07.18',
    });
    assert.equal(parseIssueId('economist%3A2026.07.18'), null);
    assert.equal(parseIssueId('economist:%2e%2e%2foutside'), null);
  });

  it('refuses path separators and traversal in issue file keys', () => {
    assert.throws(() => issueFileKey('economist', '../../outside'), /invalid issue/i);
    assert.throws(() => issueFileKey('economist', '..\\..\\outside'), /invalid issue/i);
    assert.throws(() => issueFileKey('../economist', '2026.07.18'), /invalid source/i);
  });
});

describe('magazine sync request validation', () => {
  it('deduplicates configured sources and accepts a bounded integer issue count', () => {
    assert.deepEqual(
      parseSyncRequest({
        sources: ['wired', 'economist', 'wired'],
        maxIssuesPerSource: 12,
      }),
      {
        sources: ['wired', 'economist'],
        maxIssuesPerSource: 12,
      }
    );
  });

  it('rejects malformed, unknown, empty, or oversized sync options', () => {
    const invalidBodies = [
      { sources: 'wired' },
      { sources: [] },
      { sources: ['wired', 42] },
      { sources: ['unknown'] },
      { maxIssuesPerSource: 0 },
      { maxIssuesPerSource: 1.5 },
      { maxIssuesPerSource: 31 },
      { maxIssuesPerSource: '4' },
    ];

    for (const body of invalidBodies) {
      assert.throws(() => parseSyncRequest(body), /invalid sync request/i);
    }
  });
});

describe('magazine JSON storage boundaries', () => {
  it('uses fallback only when a JSON file does not exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-store-'));
    try {
      const missing = path.join(dir, 'missing.json');
      assert.deepEqual(await readJsonFile(missing, { empty: true }), { empty: true });

      const malformed = path.join(dir, 'malformed.json');
      await fs.writeFile(malformed, '{not-json', 'utf8');
      await assert.rejects(readJsonFile(malformed, null), SyntaxError);

      await assert.rejects(readJsonFile(dir, null), (error: unknown) => {
        return error instanceof Error && 'code' in error && error.code !== 'ENOENT';
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('replaces files through a same-directory temporary file and leaves no temp artifact', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magazine-atomic-'));
    try {
      const target = path.join(dir, 'state.json');
      await fs.writeFile(target, 'old', 'utf8');
      await writeFileAtomic(target, 'new');
      assert.equal(await fs.readFile(target, 'utf8'), 'new');
      assert.deepEqual(await fs.readdir(dir), ['state.json']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('magazine remote request boundaries', () => {
  it('rejects non-HTTPS and non-GitHub hosts before making a request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('unexpected');
    }) as typeof fetch;

    await assert.rejects(downloadFile('http://raw.githubusercontent.com/file.epub'), /https/i);
    await assert.rejects(downloadFile('https://example.com/file.epub'), /host/i);
    assert.equal(calls, 0);
  });

  it('validates every redirect target before following it', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/file.epub' },
      });
    }) as typeof fetch;

    await assert.rejects(
      downloadFile('https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/file.epub'),
      /host|来源/i
    );
    assert.equal(calls, 1);
  });

  it('passes timeout signals to API and download requests', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = (async (_input, init) => {
      signals.push(init?.signal);
      if (signals.length === 1) {
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('file', { status: 200 });
    }) as typeof fetch;

    await listRepoContents('01_economist');
    await downloadFile('https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/file.epub');
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  });

  it('enforces declared and streamed download byte limits', async () => {
    process.env.MAGAZINE_DOWNLOAD_MAX_BYTES = '8';

    globalThis.fetch = (async () => new Response('123456789', {
      status: 200,
      headers: { 'content-length': '9' },
    })) as typeof fetch;
    await assert.rejects(
      downloadFile('https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/file.epub'),
      /too large/i
    );

    globalThis.fetch = (async () => new Response('123456789', { status: 200 })) as typeof fetch;
    await assert.rejects(
      downloadFile('https://raw.githubusercontent.com/hehonghui/awesome-english-ebooks/master/file.epub'),
      /too large/i
    );
  });
});
