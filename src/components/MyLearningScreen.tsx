import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, BookOpen, ChevronDown, ChevronRight, Database, Globe, Puzzle, RefreshCw } from 'lucide-react';
import { openOfficialWebsite } from '../lib/appUpdates';
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
  getLocalDataBackupWarning,
  downloadFullLocalBackup,
  readMergeBackupFile,
  readNativeMergeBackup,
  mergeLocalDataBackupBatch,
} from '../lib/localDataBackup';
import { getLocalDatabaseSnapshot, subscribeLocalDatabase, selectLocalProfile, localDatabaseRequest } from '../lib/localDatabase';
import type { LocalDataBackup } from '../lib/localDataBackup';
import { flushPendingPersistentWrites } from '../lib/storage';
import { IS_ANDROID } from '../lib/platform/runtime';
import { nativeFiles, pickNativeFile } from '../lib/platform/nativeFiles';

interface MyLearningScreenProps {
  onCheckUpdates?: () => void;
  updateChecking?: boolean;
  appVersion?: string;
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

interface PendingBackup {
  id: number;
  name: string;
  full: boolean;
  backup: LocalDataBackup;
  selected: boolean;
}

export const MyLearningScreen: React.FC<MyLearningScreenProps> = ({
  onCheckUpdates,
  updateChecking,
  appVersion,
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
  const mergeButtonRef = useRef<HTMLButtonElement>(null);
  const nextBackupId = useRef(0);
  const [pendingBackups, setPendingBackups] = useState<PendingBackup[]>([]);
  const selectedBackups = pendingBackups.filter(item => item.selected);
  const mergeDecision = useRef<((confirmed: boolean) => void) | null>(null);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  useEffect(() => () => { mergeDecision.current?.(false); }, []);
  const [backupBusy, setBackupBusy] = useState<'export' | 'full-export' | 'recovery' | 'import' | 'merge' | 'restore' | 'profile' | null>(null);
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
      setBackupMessage('已导出上次合并或恢复前的学习档案。导入后在“其他工具”中选择恢复，可还原原来的记录。');
    } catch (error) { setBackupError(error instanceof Error ? error.message : '副本导出失败'); }
    finally { setBackupBusy(null); }
  };

  const mergePrompt = `将当前学习记录与所选 ${selectedBackups.length} 份备份一起合并。独有文章和学习记录保留，重复记录去重；已完成文章保持完成，段落进度合并，阅读位置采用较新的记录，复习历史合并后重新计算安排。当前设备设置保留；没有原始明细的旧统计取较大值。JSON 不含 PDF 和插图，跨设备请优先使用完整 ZIP 备份。同编号正文冲突会停止整次合并。${localDatabase ? '本机档案会保留合并前副本。' : '请先导出当前浏览器备份以便还原。'}是否继续？`;
  const confirmMerge = () => new Promise<boolean>(resolve => { mergeDecision.current = resolve; setMergeConfirmOpen(true); });
  const finishMergeConfirmation = (confirmed: boolean) => {
    setMergeConfirmOpen(false); mergeDecision.current?.(confirmed); mergeDecision.current = null;
    window.setTimeout(() => mergeButtonRef.current?.focus(), 0);
  };

  const addPendingBackup = (name: string, backup: LocalDataBackup) => {
    const entry = { id: ++nextBackupId.current, name, full: /\.zip$/i.test(name), backup, selected: true };
    setPendingBackups(items => [...items, entry]);
  };

  const handleNativeImport = async () => {
    setBackupBusy('import'); setBackupError(null); setBackupMessage(null);
    let pickedHandle: string | undefined;
    try {
      const file = await pickNativeFile('backup');
      if (!file) { setBackupMessage('已取消选择备份。'); return; }
      pickedHandle = file.handle;
      if (!localDatabase) throw new Error('手机学习档案尚未就绪。');
      addPendingBackup(file.name, await readNativeMergeBackup(file.handle, /\.zip$/i.test(file.name)));
      setBackupMessage('备份已加入列表，当前学习记录未改变。可以继续导入，或勾选后合并。');
    } catch (error) { setBackupError(error instanceof Error ? error.message : '手机备份读取失败。'); }
    finally {
      if (pickedHandle) await nativeFiles.releaseFile({ handle: pickedHandle }).catch(() => {});
      setBackupBusy(null);
    }
  };

  const handleImportFiles = async (files: File[]) => {
    if (!files.length) return;
    setBackupBusy('import'); setBackupError(null); setBackupMessage(null);
    const errors: string[] = [];
    let added = 0;
    for (const file of files) {
      try {
        addPendingBackup(file.name, await readMergeBackupFile(file));
        added++;
      } catch (error) { errors.push(`${file.name}：${error instanceof Error ? error.message : '读取失败'}`); }
    }
    if (added) setBackupMessage(`已加入 ${added} 份备份，当前学习记录未改变。可以继续导入，或勾选后合并。`);
    if (errors.length) setBackupError(errors.join('；'));
    setBackupBusy(null);
  };

  const handleMergeBackups = async () => {
    if (!selectedBackups.length) return;
    setBackupBusy('merge'); setBackupError(null); setBackupMessage(null);
    try {
      if (!await confirmMerge()) { setBackupMessage('已取消合并，备份仍在列表中，学习档案未改变。'); setBackupBusy(null); return; }
      await memoryStore.ensureReady();
      await mergeLocalDataBackupBatch(selectedBackups.map(item => item.backup));
      setBackupMessage('合并成功，正在刷新页面…');
      window.setTimeout(() => window.location.reload(), 400);
    } catch (error) { setBackupError(error instanceof Error ? error.message : '合并失败'); setBackupBusy(null); }
  };

  const handleRestoreBackup = async () => {
    if (selectedBackups.length !== 1) return;
    const item = selectedBackups[0];
    setBackupBusy('restore'); setBackupError(null); setBackupMessage(null);
    try {
      const warning = getLocalDataBackupWarning(item.backup);
      const confirmed = window.confirm(
        `使用“${item.name}”覆盖恢复，不会合并。\n\n${warning ? `${warning}\n\n` : ''}${localDatabase
          ? `将替换“${localDatabase.profile.name}”的学习进度、文章历史与词汇记忆。原档案会在本机保留恢复副本。是否继续？`
          : '将覆盖本浏览器中当前的学习进度、文章历史与词汇记忆，且不可撤销。是否继续？'}`
      );
      if (!confirmed) { setBackupMessage('已取消恢复，学习档案未改变。'); setBackupBusy(null); return; }
      await memoryStore.ensureReady();
      await importLocalDataBackup(item.backup);
      setBackupMessage('恢复成功，正在刷新页面…');
      window.setTimeout(() => window.location.reload(), 400);
    } catch (error) { setBackupError(error instanceof Error ? error.message : '恢复失败'); setBackupBusy(null); }
  };

  return (
    <div className="learning-screen min-h-screen bg-[#F8F6F0] text-[#2B2723] flex flex-col selection:bg-[#F3D7C7]">
      <div className="contents" inert={mergeConfirmOpen || undefined} aria-hidden={mergeConfirmOpen || undefined}>
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
            {onCheckUpdates && <button type="button" onClick={onCheckUpdates} disabled={updateChecking} className="learning-setting-row" aria-busy={updateChecking}>
              <RefreshCw size={20} className="learning-setting-icon" aria-hidden="true" />
              <span className="learning-setting-copy">
                <span className="learning-setting-title">{updateChecking ? '正在检查更新…' : '检查更新'}</span>
                <span className="learning-setting-description">当前 v{appVersion} · 定期与官网检查新版本</span>
              </span>
              <ChevronRight size={16} className="learning-setting-arrow" aria-hidden="true" />
            </button>}
              <button type="button" onClick={() => { void openOfficialWebsite(); }} className="learning-setting-row">
                <Globe size={20} className="learning-setting-icon" aria-hidden="true" />
                <span className="learning-setting-copy">
                  <span className="learning-setting-title">关于我们</span>
                  <span className="learning-setting-description">访问 ReadAge 官网</span>
                </span>
                <ArrowUpRight size={16} className="learning-setting-arrow" aria-hidden="true" />
              </button>
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
                  <span className="learning-setting-description">导入备份，再选择合并学习记录</span>
                </span>
                <ChevronDown size={16} className="learning-disclosure-arrow" aria-hidden="true" />
              </summary>
              <div className="learning-backup-content space-y-4">
                <div className="space-y-3 text-xs leading-6 text-[#85786B]">
                  <p>{localDatabase ? '学习数据保存在当前设备的本机学习档案中，清除浏览器缓存不会删除学习档案。' : '学习数据保存在本机浏览器。'}</p>
                  {localDatabase?.error && <p role="alert" className="text-[#A94E2B]">保存暂未完成：{localDatabase.error}。请保持页面打开，应用会继续重试。</p>}
                  <section className="space-y-3" aria-labelledby="backup-import-heading">
                    <h3 id="backup-import-heading" className="font-semibold text-[#44382D]">1. 导入备份</h3>
                    <p>先导入手机、电脑或其他时间保存的备份。导入只加入下方列表，不会覆盖当前学习记录。</p>
                    <div className="learning-backup-actions">
                      <button type="button" onClick={() => IS_ANDROID ? void handleNativeImport() : fileInputRef.current?.click()}
                        disabled={backupBusy !== null || vocabularyExportBusy} aria-busy={backupBusy === 'import'} className={`${toolButtonClassName} learning-backup-primary`}>
                        {backupBusy === 'import' ? '读取中…' : '导入备份'}
                      </button>
                      <button type="button" onClick={() => localDatabase ? void handleExportFullBackup() : void handleExportBackup()}
                        disabled={backupBusy !== null || vocabularyExportBusy} aria-busy={backupBusy === 'export' || backupBusy === 'full-export'} className={toolButtonClassName}>
                        {backupBusy === 'export' || backupBusy === 'full-export' ? '导出中…' : '导出当前备份'}
                      </button>
                    </div>
                    <p>{localDatabase ? '默认导出完整 ZIP，包含学习记录、文章正文及引用的本地 PDF 和插图；也兼容旧 JSON。词典和语音模型独立管理。' : '备份为 JSON，包含浏览器内的学习记录，不包含 PDF 原文件和插图；跨设备需另行迁移附件或重新导入文章。'}</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept={localDatabase ? 'application/json,application/zip,.json,.zip' : 'application/json,.json'}
                      aria-label="选择学习备份文件"
                      className="hidden"
                      onChange={(event) => {
                        const files = Array.from<File>(event.target.files ?? []);
                        event.target.value = '';
                        void handleImportFiles(files);
                      }}
                    />
                  </section>
                  <section className="learning-backup-sources space-y-3" aria-labelledby="backup-sources-heading">
                    <h3 id="backup-sources-heading" className="font-semibold text-[#44382D]">2. 选择并合并</h3>
                    {!pendingBackups.length ? <p>导入后，备份会出现在这里，再勾选需要合并的备份。</p> : <>
                      <p>当前学习记录始终保留，与勾选的备份一起合并。导入一份即可与当前记录合并，也可以继续导入多份。</p>
                      <div className="learning-backup-source"><strong>当前学习记录{localDatabase ? ` · ${localDatabase.profile.name}` : ''}</strong><span>本机 · 始终参与合并</span></div>
                      <ul aria-label="已导入的备份" className="space-y-2">
                        {pendingBackups.map(item => <li key={item.id} className="learning-backup-source">
                          <label className="learning-backup-source-label">
                            <input type="checkbox" checked={item.selected} disabled={backupBusy !== null || vocabularyExportBusy}
                              onChange={event => setPendingBackups(items => items.map(row => row.id === item.id ? { ...row, selected: event.target.checked } : row))} />
                            <span className="min-w-0"><strong>{item.name}</strong><span>{item.full ? '完整 ZIP · 含附件' : 'JSON · 不含附件'} · {Number.isNaN(Date.parse(item.backup.exportedAt)) ? '备份时间未知' : new Date(item.backup.exportedAt).toLocaleString('zh-CN')}</span></span>
                          </label>
                          <button type="button" disabled={backupBusy !== null || vocabularyExportBusy} className="learning-backup-remove"
                            aria-label={`移除备份 ${item.name}`} onClick={() => setPendingBackups(items => items.filter(row => row.id !== item.id))}>移除</button>
                        </li>)}
                      </ul>
                      <p>列表仅在本次页面中保留；移除、离开页面或刷新不会删除原备份文件。</p>
                      <button ref={mergeButtonRef} type="button" disabled={backupBusy !== null || vocabularyExportBusy || !selectedBackups.length}
                        aria-busy={backupBusy === 'merge'} className={`${toolButtonClassName} learning-backup-primary`} onClick={() => void handleMergeBackups()}>
                        {backupBusy === 'merge' ? '等待确认或合并中…' : `合并所选备份（${selectedBackups.length}）`}
                      </button>
                    </>}
                  </section>
                  <details className="learning-backup-other">
                    <summary className="learning-detail-toggle"><span>其他工具</span><ChevronDown size={16} aria-hidden="true" /></summary>
                    <div className="space-y-3 pt-3">
                      <p>需要回到某次备份时，在上方只勾选一份，再使用覆盖恢复。恢复前会确认覆盖当前记录。</p>
                      <button type="button" className={toolButtonClassName} disabled={backupBusy !== null || vocabularyExportBusy || selectedBackups.length !== 1}
                        onClick={() => void handleRestoreBackup()}>{backupBusy === 'restore' ? '恢复中…' : '用所选备份覆盖恢复'}</button>
                      <div className="learning-backup-actions">
                        {localDatabase && <button type="button" className={toolButtonClassName} disabled={backupBusy !== null || vocabularyExportBusy} onClick={() => void handleExportBackup()}>
                          {backupBusy === 'export' ? '导出中…' : '仅导出记录（JSON）'}
                        </button>}
                        {localDatabase && <button type="button" className={toolButtonClassName} disabled={backupBusy !== null || vocabularyExportBusy} onClick={() => void handleExportRecovery()}>
                          {backupBusy === 'recovery' ? '导出中…' : '导出上次合并或恢复前的档案'}
                        </button>}
                        <button type="button" onClick={() => void handleExportVocabulary()}
                          disabled={backupBusy !== null || vocabularyExportBusy || proficienciesLoading || !!proficienciesError || proficiencies.length === 0}
                          aria-busy={vocabularyExportBusy || proficienciesLoading} className={toolButtonClassName}>
                          {proficienciesLoading ? '加载中…' : vocabularyExportBusy ? '导出中…' : '导出词汇表'}
                        </button>
                      </div>
                      <p>词汇表包含词汇、音标、翻译和熟练度，CSV 文件可用 Excel 打开。</p>
                      {!proficienciesLoading && !proficienciesError && proficiencies.length === 0 && <p>阅读并产生词汇学习记录后，这里会出现可导出的词汇。</p>}
                      {localDatabase && <label className="flex flex-wrap items-center gap-2">当前学习档案
                        <select aria-label="当前学习档案" value={localDatabase.profile.id} disabled={backupBusy !== null || vocabularyExportBusy}
                          className="min-h-11 max-w-full rounded border border-[#DED6C9] bg-white px-2 py-1 text-[#44382D]"
                          onChange={event => void handleSelectProfile(event.target.value)}>
                          {localDatabase.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </label>}
                      {localDatabase && localDatabase.profiles.length > 1 && <p>不同浏览器的旧记录各自保留为独立档案。选择同一档案后，学习进度共用。</p>}
                    </div>
                  </details>
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
      {mergeConfirmOpen && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
        <section role="dialog" aria-modal="true" aria-labelledby="backup-merge-title" aria-describedby="backup-merge-description"
          className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-[#F8F6F0] p-5 shadow-xl"
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); finishMergeConfirmation(false); }
            if (event.key === 'Tab') {
              const buttons = event.currentTarget.querySelectorAll('button');
              if (event.shiftKey && event.target === buttons[0]) { event.preventDefault(); buttons[1].focus(); }
              else if (!event.shiftKey && event.target === buttons[1]) { event.preventDefault(); buttons[0].focus(); }
            }
          }}>
          <h2 id="backup-merge-title" className="text-lg font-semibold">合并备份</h2>
          <p id="backup-merge-description" className="mt-3 text-sm leading-7">{mergePrompt}</p>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            <button type="button" autoFocus className="min-h-11 rounded-lg border border-[#DED6C9] px-5" onClick={() => finishMergeConfirmation(false)}>取消</button>
            <button type="button" className="min-h-11 rounded-lg bg-[#44382D] px-5 text-white" onClick={() => finishMergeConfirmation(true)}>确认合并</button>
          </div>
        </section>
      </div>}
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
