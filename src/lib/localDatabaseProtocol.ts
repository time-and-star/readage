/** Record protocol shared by desktop HTTP and device-native SQLite adapters. */
export const LOCAL_DATA_API = '/api/local-data';
export const LOCAL_DATA_HEADER = 'x-readage-local-data';
export const LOCAL_PROFILE_KEY = 'readage:local-database-profile:v1';
export const MEMORY_TABLES = ['rawEvents', 'articleEvidence', 'dailyEvidence', 'memoryState', 'finalizationTasks', 'meta'] as const;
export type LocalTable = 'settings' | typeof MEMORY_TABLES[number];
export interface LocalRow { key: string; value: unknown }
export interface LocalChange extends LocalRow { table: LocalTable; deleted?: boolean }
export const ARTICLE_METADATA_FIELDS = ['lastOpenedAt', 'status', 'importEnrichmentStatus', 'importEnrichmentError'] as const;
export interface LocalArticleMetadataPatch { id: string; values: Record<string, unknown>; deletedFields: string[] }
export interface LocalArticleMetadataChange { table: 'settings'; key: 'english-ai:v2:articles'; articleMetadata: LocalArticleMetadataPatch[] }
export type LocalCommitChange = LocalChange | LocalArticleMetadataChange;
export interface LocalProfile { id: string; name: string; createdAt: string; revision: number }
export interface LocalQuery { revision: number; rows: LocalRow[] }
export interface LocalSettingsDelta extends LocalQuery { deletedKeys: string[]; reset: boolean }
export const LOCAL_QUERY_KEY_LIMIT = 500;
export interface LocalBootstrap { profile: LocalProfile; profiles: LocalProfile[]; settings: Record<string, string>; migrated: boolean }
export const FULL_BACKUP_FORMAT = 'readage-local-library';
export const FULL_BACKUP_VERSION = 1;
export interface BackupAsset { url: string; entry: string; sha256: string; bytes: number }
