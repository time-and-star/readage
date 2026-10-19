import { createHash } from 'node:crypto';
import type { MagazineSourceMeta } from '../../src/types';
import { MAGAZINE_LIBRARY_ORIGIN, selectDistributedMagazineIssues } from '../../src/lib/magazineDistribution';
import { getMagazineDownloadMaxBytes, getMagazineDownloadTimeoutMs, getMagazineWebSourceTimeoutMs } from './config';
import type { RemoteIssueCandidate } from './github';
import { magazineFetch } from './network';

async function readResponse(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`官网期刊服务暂时不可用（${response.status}），已保留现有内容。`);
  if (Number(response.headers.get('content-length')) > maximum) { await response.body.cancel(); throw new Error('官网期刊文件超过下载上限。'); }
  const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maximum) throw new Error('官网期刊文件超过下载上限。');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export function validDistributedMagazineBytes(candidate: RemoteIssueCandidate, bytes: Buffer): boolean {
  return !!candidate.distributedFile && bytes.length === candidate.distributedFile.bytes
    && createHash('sha256').update(bytes).digest('hex') === candidate.distributedFile.sha256;
}

/** One catalogue per update; files always come from the fixed official download path. */
export function createOfficialMagazineSource(fetcher: typeof fetch = magazineFetch) {
  let catalog: Promise<unknown> | undefined;
  return {
    async discover(source: MagazineSourceMeta, limit: number): Promise<RemoteIssueCandidate[]> {
      catalog ??= fetcher(`${MAGAZINE_LIBRARY_ORIGIN}/api/library/catalog`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(getMagazineWebSourceTimeoutMs()),
      }).then(response => readResponse(response, 2 * 1024 * 1024)).then(bytes => JSON.parse(bytes.toString('utf8')));
      const candidates = selectDistributedMagazineIssues(await catalog, source.id, limit);
      if (!candidates.length) throw new Error('官网暂未缓存本刊，请稍后重试；已有内容仍可阅读。');
      return candidates.map(({ issueLabel, item, error }) => ({
        dirName: issueLabel, issueLabel, path: item?.downloadPath || '',
        format: item?.filename.toLowerCase().endsWith('.pdf') ? 'pdf' : 'epub',
        preferredFile: { name: item?.filename || '', path: item?.downloadPath || '', type: 'file',
          sha: item?.sha256 || '', size: item?.bytes || 0,
          download_url: item ? `${MAGAZINE_LIBRARY_ORIGIN}${item.downloadPath}` : null },
        ...(item ? { distributedFile: { sha256: item.sha256, bytes: item.bytes } } : { discoveryError: error }),
      }));
    },
    async download(candidate: RemoteIssueCandidate): Promise<Buffer> {
      const file = candidate.distributedFile;
      if (!file || candidate.preferredFile.download_url !== `${MAGAZINE_LIBRARY_ORIGIN}/api/library/files/${file.sha256}`) throw new Error('官网期刊下载地址无效。');
      const bytes = await readResponse(await fetcher(candidate.preferredFile.download_url, {
        headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(getMagazineDownloadTimeoutMs()),
      }), Math.min(getMagazineDownloadMaxBytes(), file.bytes));
      if (!validDistributedMagazineBytes(candidate, bytes)) throw new Error('官网期刊下载校验失败，已保留旧刊，请刷新后重试。');
      return bytes;
    },
  };
}
