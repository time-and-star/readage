import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditDesktopPe } from '../scripts/desktop-audit-pe.mjs';

test('PE acceptance cannot mark an installer core as a complete offline application', async t => {
  const temporary = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, 'ra-core-gate-'));
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith('ra-core-gate-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'resources'));
  await fs.writeFile(path.join(root, 'resources/installer-assets.json'), '{}');
  // Rejection precedes any LLVM invocation or optimistic empty-closure report.
  await assert.rejects(auditDesktopPe({ directory: root, tool: path.join(root, 'must-not-run.exe') }), /核心中间目录.*完整PE/);
  await assert.rejects(fs.stat(path.join(root, 'pe-integrity.json')), { code: 'ENOENT' });
});
