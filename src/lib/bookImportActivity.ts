/** In-session import work stays alive when its dialog is tucked away. */
export interface BookImportActivity {
  phase: 'downloading' | 'preparing' | 'ready' | 'paused' | 'error';
  title: string;
  detail: string;
  receivedBytes?: number;
  totalBytes?: number;
  preparedCount?: number;
  totalCount?: number;
}
