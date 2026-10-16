import React, { useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, BookOpen, ChevronDown, ChevronRight, Database, Puzzle } from 'lucide-react';
import { ArticleProgressRow, WeakPointMetric } from '../types';
import type { WordProficiencyView } from '../lib/memoryV2';
import { AppPageHeader } from './AppPageHeader';
import { ReadingDataNotice } from './ReadingDataNotice';
import { lookupDictionaryWords } from '../lib/dictionaryClient';
import { useMemoryStore } from '../lib/memoryV2';
import {
  buildVocabularyCsv,
  buildVocabularyExportRows,
  downloadVocabularyCsv,
} from '../lib/vocabularyExport';
import {
  downloadLocalDataBackup,
  exportLocalDataBackup,
  importLocalDataBackup,
  readBackupFile,
  validateLocalDataBackup,
  getLocalDataBackupWarning,
  downloadFullLocalBackup,
  importFullLocalBackup,
  importNativeFullLocalBackup,
  importNativeRecordBackup,
} from '../lib/localDataBackup';
import { getLocalDatabaseSnapshot, subscribeLocalDatabase, selectLocalProfile, localDatabaseRequest } from '../lib/localDatabase';
import type { LocalDataBackup } from '../lib/localDataBackup';
import { flushPendingPersistentWrites } from '../lib/storage';
import { IS_ANDROID } from '../lib/platform/runtime';
import { nativeFiles, pickNativeFile } from '../lib/platform/nativeFiles';

interface MyLearningScreenProps {
  onBack: () => void;
  navigation?: React.ReactNode;
  onOpenRecommendedReading: () => void;
  onOpenFlashcards: () => void;
  onOpenReadingRecords: () => void;
  onOpenDictionarySettings?: () => void;
  onOpenArticle: (articleId: string) => void;
  articlesReadCount: number;
  introducedWordsCount: number;
  learnedWordsCount: number;
  masteredWordsCount: number;
  learningWordsCount: number;
  streakDaysCount: number;
  recentEventCount: number;
  dueWordCount: number;
  proficiencies: WordProficiencyView[];
  proficienciesLoading: boolean;
  proficienciesError?: string | null;
  onRetryProficiencies?: () => void;
  weakPointMetrics: WeakPointMetric[];
  articleProgress: ArticleProgressRow[];
}

export const MyLearningScreen: React.FC<MyLearningScreenProps> = ({
  onBack,
  navigation,
  onOpenRecommendedReading,
  onOpenFlashcards,
  onOpenReadingRecords,
  onOpenDictionarySettings,
  articlesReadCount,
  introducedWordsCount,
  learnedWordsCount,
  masteredWordsCount,
  learningWordsCount,
  streakDaysCount,
  recentEventCount,
  dueWordCount,
  proficiencies,
  proficienciesLoading,
  proficienciesError,
  onRetryProficiencies,
}) => {
  const memoryStore = useMemoryStore();
  const localDatabase = useSyncExternalStore(subscribeLocalDatabase, getLocalDatabaseSnapshot, () => null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState<'export' | 'full-export' | 'recovery' | 'import' | 'profile' | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [vocabularyExportBusy, setVocabularyExportBusy] = useState(false);
  const [vocabularyExportMessage, setVocabularyExportMessage] = useState<string | null>(null);
  const [vocabularyExportError, setVocabularyExportError] = useState<string | null>(null);

  const handleExportVocabulary = async () => {
    setVocabularyExportBusy(true);
    setVocabularyExportMessage(null);
    setVocabularyExportError(null);
    try {
      const exportProficiencies = proficiencies.filter((item) => item.wordId.trim());
      if (exportProficiencies.length === 0) {
        setVocabularyExportMessage('暂无可导出的词汇。');
        return;
      }

      let dictionaryEntries: Awaited<ReturnType<typeof lookupDictionaryWords>> = [];
      let dictionaryUnavailable = false;
      try {
        dictionaryEntries = await lookupDictionaryWords(
          exportProficiencies.map((item) => item.wordId),
        );
      } catch {
        dictionaryUnavailable = true;
      }

      const rows = buildVocabularyExportRows(exportProficiencies, dictionaryEntries);
      const saved = await downloadVocabularyCsv(buildVocabularyCsv(rows));
      if (!saved) { setVocabularyExportMessage('已取消保存词汇表。'); return; }
      setVocabularyExportMessage(
        dictionaryUnavailable
          ? `已导出 ${rows.length} 个词汇；词典暂不可用，部分音标和翻译为空。`
          : `已导出 ${rows.length} 个词汇。`
      );
    } catch (error) {
      setVocabularyExportError(error instanceof Error ? error.message : '词汇表导出失败');
    } finally {
      setVocabularyExportBusy(false);
    }
  };

  const handleExportBackup = async () => {
    setBackupBusy('export');
    setBackupError(null);
    setBackupMessage(null);
    try {
      await memoryStore.ensureReady();
      const backup = await exportLocalDataBackup({ memoryStorage: memoryStore.system.getMemoryStorageKind() });
      if (IS_ANDROID && localDatabase) {
        const result = await nativeFiles.exportSnapshot({ profileId: localDatabase.profile.id });
        if (!result.saved) { setBackupMessage('已取消保存备份。'); return; }
      } else downloadLocalDataBackup(backup);
      const keyCount = Object.keys(backup.localStorage).length;
      setBackupMessage(
        `已导出 ${keyCount} 项本地数据（含词汇记忆库）。文件仅保存在你的设备上。`
      );
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : '导出失败');
    } finally {
      setBackupBusy(null);
    }
  };

  const handleExportFullBackup = async () => {
    setBackupBusy('full-export'); setBackupError(null); setBackupMessage(null);
    try {
      await memoryStore.ensureReady();
      if (!await downloadFullLocalBackup()) { setBackupMessage('已取消保存完整备份。'); return; }
      setBackupMessage('已导出完整备份，包含学习记录、文章正文及引用的本地 PDF 和插图。');
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : '完整备份导出失败');
    } finally { setBackupBusy(null); }
  };

  const handleSelectProfile = async (id: string) => {
    setBackupBusy('profile'); setBackupError(null);
    try { await flushPendingPersistentWrites(); await selectLocalProfile(id); }
    catch (error) { setBackupError(error instanceof Error ? error.message : '档案切换失败'); setBackupBusy(null); }
  };
  const handleExportRecovery = async () => {
    setBackupBusy('recovery'); setBackupError(null); setBackupMessage(null);
    try {
      const backup = await localDatabaseRequest<LocalDataBackup>('previous-snapshot');
      if (IS_ANDROID && localDatabase) {
        const result = await nativeFiles.exportSnapshot({ profileId: localDatabase.profile.id, previous: true,
          filename: `ReadAge-before-restore-${backup.exportedAt.slice(0, 10)}.json` });
        if (!result.saved) { setBackupMessage('已取消保存副本。'); return; }
      } else downloadLocalDataBackup(backup, `ReadAge-before-restore-${backup.exportedAt.slice(0, 10)}.json`);
      setBackupMessage('已导出上次恢复前的学习档案。导入该文件可还原原来的记录。');
    } catch (error) { setBackupError(error instanceof Error ? error.message : '副本导出失败'); }
    finally { setBackupBusy(null); }
  };

  const handleNativeImport = async () => {
    setBackupBusy('import'); setBackupError(null); setBackupMessage(null);
    let pickedHandle: string | undefined;
    try {
      const file = await pickNativeFile('backup');
      if (!file) { setBackupBusy(null); return; }
      pickedHandle = file.handle;
      if (!localDatabase) throw new Error('手机学习档案尚未就绪。');
      const full = /\.zip$/i.test(file.name);
      if (!window.confirm(`导入将替换“${localDatabase.profile.name}”的学习进度、文章和记忆记录，不会合并两台设备的进度。恢复前的档案会保留在手机上。是否继续？`)) {
        setBackupBusy(null); return;
      }
      if (full) await importNativeFullLocalBackup(file.handle);
      else await importNativeRecordBackup(file.handle);
      setBackupMessage('导入成功，正在刷新页面…');
      window.setTimeout(() => window.location.reload(), 400);
    } catch (error) { setBackupError(error instanceof Error ? error.message : '手机备份导入失败。'); setBackupBusy(null); }
    finally { if (pickedHandle) await nativeFiles.releaseFile({ handle: pickedHandle }).catch(() => {}); }
  };

  const handleImportFile = async (file: File | null) => {
    if (!file) return;
    setBackupBusy('import');
    setBackupError(null);
    setBackupMessage(null);
    try {
      const fullBackup = /\.zip$/i.test(file.name);
      if (fullBackup && !localDatabase) throw new Error('请在电脑本地版恢复 ZIP 完整备份。');
      const raw = fullBackup ? null : await readBackupFile(file);
      const warning = fullBackup ? null : getLocalDataBackupWarning(validateLocalDataBackup(raw));
      const confirmed = window.confirm(
        `${warning ? `${warning}\n\n` : ''}${localDatabase
          ? `导入将替换“${localDatabase.profile.name}”的学习进度、文章历史与词汇记忆。原档案会在本机保留恢复副本。是否继续？`
          : '导入将覆盖本浏览器中当前的学习进度、文章历史与词汇记忆，且不可撤销。是否继续？'}`
      );
      if (!confirmed) {
        setBackupBusy(null);
        return;
      }
      if (fullBackup) await importFullLocalBackup(file);
      else await importLocalDataBackup(raw);
      setBackupMessage('导入成功，正在刷新页面…');
      window.setTimeout(() => {
        window.location.reload();
      }, 400);
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : '导入失败');
      setBackupBusy(null);
    }
  };

  return (
    <div className="learning-screen min-h-screen bg-[#F8F6F0] text-[#2B2723] flex flex-col selection:bg-[#F3D7C7]">
      <AppPageHeader onBack={onBack} navigation={navigation} />

      <main className="learning-overview flex flex-1 flex-col safe-pb">
        <h1>学习概览</h1>
        {proficienciesError && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><p>{proficienciesError}</p>{onRetryProficiencies && <button type="button" className="mt-2 underline" disabled={proficienciesLoading} onClick={onRetryProficiencies}>{proficienciesLoading ? '正在重试…' : '重新读取学习记录'}</button>}</div>}

        <dl className="learning-metrics grid grid-cols-3" aria-label="核心学习统计">
          <MetricCard value={articlesReadCount} label="已完成文章" onClick={onOpenReadingRecords} />
          <MetricCard value={proficienciesLoading || proficienciesError ? '—' : introducedWordsCount} label="待学新词" />
          <MetricCard value={streakDaysCount} label="连续天数" />
        </dl>

        <section aria-label="词汇学习记录">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-[#655B50]">
              <div className="flex items-baseline gap-1.5"><dt>已学习</dt><dd><strong className="font-semibold tabular-nums text-[#2A2621]">{proficienciesLoading || proficienciesError ? '—' : learnedWordsCount}</strong> 词</dd></div>
              <div className="flex items-baseline gap-1.5"><dt>待复习</dt><dd><strong className="font-semibold tabular-nums text-[#2A2621]">{proficienciesLoading || proficienciesError ? '—' : dueWordCount}</strong> 词</dd></div>
            </dl>
            <div className="learning-actions" role="group" aria-label="学习入口">
              <button
                type="button"
                onClick={onOpenRecommendedReading}
                className="study-read-action"
              >
                推荐阅读
              </button>
              <button
                type="button"
                onClick={onOpenFlashcards}
                className="study-read-action"
              >
                词卡学习
              </button>
            </div>
          </div>
        </section>

        <details className="learning-detail text-sm text-[#6B6156]">
          <summary className="learning-detail-toggle">
            <span>学习详情</span>
            <ChevronDown size={16} className="learning-disclosure-arrow" aria-hidden="true" />
          </summary>
          <div className="pb-2 space-y-3 text-xs leading-6">
            <dl className="flex flex-wrap gap-x-6 gap-y-1">
              <div className="flex gap-2"><dt>较熟悉</dt><dd className="font-semibold tabular-nums text-[#443A30]">{proficienciesLoading || proficienciesError ? '—' : masteredWordsCount}</dd></div>
              <div className="flex gap-2"><dt>学习中</dt><dd className="font-semibold tabular-nums text-[#443A30]">{proficienciesLoading || proficienciesError ? '—' : learningWordsCount}</dd></div>
              <div className="flex gap-2"><dt>近 7 天记录</dt><dd className="font-semibold tabular-nums text-[#443A30]">{recentEventCount}</dd></div>
            </dl>
            <p>已学习指已有正式回忆记录的词，包含暂停或移出后保留的历史；待学新词显示查词或导入后的完整待学词库，不随每日数量设置变化。待复习仅计正式回忆后已到期且未暂停或移出的词；单纯阅读或查词不会算作正式回忆。熟悉度是估计，不代表全部掌握。</p>
            <p>每篇推荐文章只覆盖部分待复习词，读完后仅更新实际学习的词。</p>
          </div>
        </details>

        <section className="learning-settings" aria-labelledby="learning-tools-heading">
          <h2 id="learning-tools-heading">设置与工具</h2>
          <div className="learning-settings-list">
            {onOpenDictionarySettings && (
              <button type="button" onClick={onOpenDictionarySettings} className="learning-setting-row">
                <BookOpen size={20} className="learning-setting-icon" aria-hidden="true" />
                <span className="learning-setting-copy">
                  <span className="learning-setting-title">词典设置</span>
                  <span className="learning-setting-description">管理词典与查词顺序</span>
                </span>
                <ChevronRight size={16} className="learning-setting-arrow" aria-hidden="true" />
              </button>
            )}
            <a href="/extension-setup.html" className="learning-setting-row">
              <Puzzle size={20} className="learning-setting-icon" aria-hidden="true" />
              <span className="learning-setting-copy">
                <span className="learning-setting-title">安装查词插件</span>
                <span className="learning-setting-description">在其他网页中选词查词</span>
              </span>
              <ArrowUpRight size={16} className="learning-setting-arrow" aria-hidden="true" />
            </a>

            <details className="learning-backup text-sm text-[#6B6156]">
              <summary className="learning-setting-row">
                <Database size={20} className="learning-setting-icon" aria-hidden="true" />
                <span className="learning-setting-copy">
                  <span className="learning-setting-title">数据与备份</span>
                  <span className="learning-setting-description">导出词汇、备份或恢复学习记录</span>
                </span>
                <ChevronDown size={16} className="learning-disclosure-arrow" aria-hidden="true" />
              </summary>
              <div className="learning-backup-content space-y-4">
                <div className="space-y-3 text-xs leading-6 text-[#85786B]">
                  <p>{localDatabase ? '学习数据保存在当前设备的本机学习档案中，清除浏览器缓存不会删除学习档案。' : '学习数据保存在本机浏览器。'}</p>
                  {localDatabase && <label className="flex flex-wrap items-center gap-2">
                    当前学习档案
                    <select aria-label="当前学习档案" value={localDatabase.profile.id} disabled={backupBusy !== null}
                      className="rounded border border-[#DED6C9] bg-white px-2 py-1 text-[#44382D]"
                      onChange={event => void handleSelectProfile(event.target.value)}>
                      {localDatabase.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </label>}
                  {localDatabase && localDatabase.profiles.length > 1 && <p>不同浏览器的旧记录各自保留为独立档案。选择同一档案后，学习进度共用。</p>}
                  {localDatabase?.error && <p role="alert" className="text-[#A94E2B]">保存暂未完成：{localDatabase.error}。请保持页面打开，应用会继续重试。</p>}
                  <div className="learning-backup-actions">
                    {localDatabase && <button type="button" onClick={() => void handleExportFullBackup()}
                      disabled={backupBusy !== null} aria-busy={backupBusy === 'full-export'} className={toolButtonClassName}>
                      {backupBusy === 'full-export' ? '导出中…' : '导出完整备份'}
                    </button>}
                    <button
                      type="button"
                      onClick={() => void handleExportVocabulary()}
                      disabled={vocabularyExportBusy || proficienciesLoading || !!proficienciesError || proficiencies.length === 0}
                      aria-busy={vocabularyExportBusy || proficienciesLoading}
                      className={toolButtonClassName}
                    >
                      {proficienciesLoading ? '加载中…' : vocabularyExportBusy ? '导出中…' : '导出词汇表'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleExportBackup()}
                      disabled={backupBusy !== null}
                      aria-busy={backupBusy === 'export'}
                      className={toolButtonClassName}
                    >
                      {backupBusy === 'export' ? '导出中…' : '导出备份'}
                    </button>
                    <button
                      type="button"
                      onClick={() => IS_ANDROID ? void handleNativeImport() : fileInputRef.current?.click()}
                      disabled={backupBusy !== null}
                      aria-busy={backupBusy === 'import'}
                      className={toolButtonClassName}
                    >
                      {backupBusy === 'import' ? '导入中…' : '导入备份'}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={localDatabase ? 'application/json,application/zip,.json,.zip' : 'application/json,.json'}
                      aria-label="选择学习备份文件"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        event.target.value = '';
                        void handleImportFile(file);
                      }}
                    />
                  </div>
                  <p>词汇表包含词汇、音标、翻译和熟练度，CSV 文件可用 Excel 打开。</p>
                  {!proficienciesLoading && !proficienciesError && proficiencies.length === 0 && <p>阅读并产生词汇学习记录后，这里会出现可导出的词汇。</p>}
                  <p>{localDatabase ? '完整备份为 ZIP，包含学习记录、文章正文及引用的本地 PDF 和插图。更换设备时安装对应应用，再导入恢复。词典和语音模型独立管理。' : '备份为 JSON 文件，可在本机或另一台设备导入恢复。导入前会确认覆盖当前记录。'}</p>
                  <p>{localDatabase ? '“导出备份”保留原来的 JSON 格式，仅包含记录，不包含 PDF 和插图。导入兼容这两种格式，并在替换前保留原档案副本。' : '备份包含浏览器内的学习记录；导入文章的 PDF 原文件和插图保存在本地服务中，迁移设备时需单独迁移这些文件或重新导入文章。'}</p>
                  {localDatabase && <button type="button" className="underline" disabled={backupBusy !== null} onClick={() => void handleExportRecovery()}>
                    {backupBusy === 'recovery' ? '导出中…' : '导出上次恢复前的档案'}
                  </button>}
                </div>
                {vocabularyExportMessage && <p className="text-xs leading-5 text-[#2F6B3A]" role="status">{vocabularyExportMessage}</p>}
                {vocabularyExportError && <p className="text-xs leading-5 text-[#A94E2B]" role="alert">{vocabularyExportError}</p>}
                {backupMessage && <p className="text-xs leading-5 text-[#2F6B3A]" role="status">{backupMessage}</p>}
                {backupError && <p className="text-xs leading-5 text-[#A94E2B]" role="alert">{backupError}</p>}
                <ReadingDataNotice compact />
              </div>
            </details>
          </div>
        </section>
      </main>
    </div>
  );
};

const toolButtonClassName = 'learning-backup-action';

const MetricCard: React.FC<{ value: number | string; label: string; onClick?: () => void }> = ({ value, label, onClick }) => (
  <div className={`learning-metric-card relative flex min-w-0 flex-col items-center gap-2 px-1 text-center [&:not(:first-child)]:border-l [&:not(:first-child)]:border-[#E7E0D5] ${onClick ? 'rounded-lg transition-colors hover:bg-[#F3EBDF]' : ''}`}>
    <dt className="order-2 text-[11px] font-medium leading-5 text-[#82766A] sm:text-xs">{onClick ? <button type="button" onClick={onClick} aria-label={`已完成 ${value} 篇文章，查看文章与生词`} className="inline-flex items-center gap-1 after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-[#A94E2B]">{label}<ArrowUpRight size={12} aria-hidden="true" /></button> : label}</dt>
    <dd className={`text-3xl font-semibold tabular-nums tracking-tight sm:text-4xl ${onClick ? 'text-[#A94E2B]' : 'text-[#44382D]'}`}>{value}</dd>
  </div>
);
