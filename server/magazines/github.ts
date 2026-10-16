import {
  GITHUB_API_BASE,
  GITHUB_REPO_NAME,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_REF,
  USER_AGENT,
  getGitHubApiTimeoutMs,
  getMagazineDownloadMaxBytes,
  getMagazineDownloadTimeoutMs,
  parseIssueLabel,
} from './config';
import { magazineFetch } from './network';
import type { FullTextFeedEntry } from './fullTextFeeds';

export interface GitHubContentItem {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir' | string;
  download_url: string | null;
}

export interface RemoteIssueCandidate {
  dirName: string;
  issueLabel: string;
  path: string;
  preferredFile: GitHubContentItem;
  format: 'epub' | 'pdf' | 'html';
  /** In-memory body for web sources that do not have a downloadable archive. */
  content?: string;
  feedEntry?: FullTextFeedEntry;
}

const MAX_REDIRECTS = 5;
const EXACT_ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
]);

function remoteError(message: string, code: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function validateGitHubUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw remoteError('Invalid remote URL', 'INVALID_REMOTE_URL');
  }

  if (url.protocol !== 'https:') {
    throw remoteError('Remote URL must use HTTPS', 'INVALID_REMOTE_PROTOCOL');
  }
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw remoteError('Remote URL contains unsupported credentials or port', 'INVALID_REMOTE_URL');
  }

  const hostname = url.hostname.toLowerCase();
  const allowed = EXACT_ALLOWED_HOSTS.has(hostname) || hostname.endsWith('.githubusercontent.com');
  if (!allowed) {
    throw remoteError(`Remote host is not allowed: ${hostname}`, 'REMOTE_HOST_NOT_ALLOWED');
  }
  return url;
}

function headersForUrl(url: URL): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  const token = process.env.GITHUB_TOKEN;
  if (token && (url.hostname === 'api.github.com' || url.hostname === 'github.com')) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchGitHub(
  input: string | URL,
  timeoutMs: number
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = validateGitHubUrl(input);
  const signal = AbortSignal.timeout(timeoutMs);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await magazineFetch(currentUrl, {
      headers: headersForUrl(currentUrl),
      redirect: 'manual',
      signal,
    });

    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: currentUrl };
    }

    if (redirects === MAX_REDIRECTS) {
      throw remoteError('Too many remote redirects', 'TOO_MANY_REDIRECTS');
    }
    const location = response.headers.get('location');
    if (!location) {
      throw remoteError('Remote redirect is missing a Location header', 'INVALID_REMOTE_REDIRECT');
    }

    // Validate before issuing the redirected request, not after fetch follows it.
    currentUrl = validateGitHubUrl(new URL(location, currentUrl));
  }

  throw remoteError('Too many remote redirects', 'TOO_MANY_REDIRECTS');
}

export async function listRepoContents(dirPath = ''): Promise<GitHubContentItem[]> {
  const encodedPath = dirPath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const url = new URL(
    `/repos/${encodeURIComponent(GITHUB_REPO_OWNER)}/${encodeURIComponent(GITHUB_REPO_NAME)}/contents/${encodedPath}`,
    GITHUB_API_BASE
  );
  url.searchParams.set('ref', GITHUB_REPO_REF);

  const { response: res } = await fetchGitHub(url, getGitHubApiTimeoutMs());
  if (res.status === 403 || res.status === 429) {
    throw remoteError(`GitHub rate limit or forbidden (${res.status})`, 'GITHUB_RATE_LIMIT');
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw remoteError(`GitHub API ${res.status}: ${detail}`, 'GITHUB_API_ERROR');
  }
  const data = (await res.json()) as GitHubContentItem[] | GitHubContentItem;
  return Array.isArray(data) ? data : [data];
}

export async function downloadFile(downloadUrl: string): Promise<Buffer> {
  const maxBytes = getMagazineDownloadMaxBytes();
  const { response: res, finalUrl } = await fetchGitHub(
    downloadUrl,
    getMagazineDownloadTimeoutMs()
  );
  if (!res.ok) {
    throw remoteError(
      `Failed to download ${finalUrl.hostname}: ${res.status}`,
      'DOWNLOAD_FAILED'
    );
  }

  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw remoteError(
      `Remote file is too large (${declaredLength} bytes; limit ${maxBytes})`,
      'DOWNLOAD_TOO_LARGE'
    );
  }

  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw remoteError(
        `Remote file is too large (limit ${maxBytes} bytes)`,
        'DOWNLOAD_TOO_LARGE'
      );
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, totalBytes);
}

function pickPreferredFile(files: GitHubContentItem[]): { file: GitHubContentItem; format: 'epub' | 'pdf' } | null {
  const epub = files.find((f) => f.type === 'file' && f.name.toLowerCase().endsWith('.epub'));
  if (epub) return { file: epub, format: 'epub' };
  const pdf = files.find((f) => f.type === 'file' && f.name.toLowerCase().endsWith('.pdf'));
  if (pdf) return { file: pdf, format: 'pdf' };
  return null;
}

/** List issue folders under a magazine source directory, newest first. */
export async function discoverIssues(repoDir: string, maxIssues: number): Promise<RemoteIssueCandidate[]> {
  const entries = await listRepoContents(repoDir);
  const dirs = entries
    .filter((e) => e.type === 'dir' && !['fonts', 'images', 'assets'].includes(e.name.toLowerCase()))
    .sort((a, b) => (a.name < b.name ? 1 : -1));

  const candidates: RemoteIssueCandidate[] = [];
  for (const dir of dirs.slice(0, maxIssues)) {
    try {
      const files = await listRepoContents(dir.path);
      const preferred = pickPreferredFile(files);
      if (!preferred || !preferred.file.download_url) continue;
      candidates.push({
        dirName: dir.name,
        issueLabel: parseIssueLabel(dir.name),
        path: dir.path,
        preferredFile: preferred.file,
        format: preferred.format,
      });
    } catch (err) {
      console.warn(`[magazines] skip issue dir ${dir.path}:`, err);
    }
  }
  return candidates;
}
