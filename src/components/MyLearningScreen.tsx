import React, { useRef, useState } from 'react';
import { ArticleProgressRow, WeakPointMetric } from '../types';
import type { WordProficiencyView } from '../lib/memoryV2';
import { AppPageHeader } from './AppPageHeader';
import { ReadingDataNotice } from './ReadingDataNotice';
import { lookupDictionaryWords } from '../lib/dictionaryClient';
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
} from '../lib/localDataBackup';

interface MyLearningScreenProps {
  onBack: () => void;
  navigation?: React.ReactNode;
  onStartTargetedReview: () => void;
  onOpenArticle: (articleId: string) => void;
  articlesReadCount: number;
  introducedWordsCount: number;
  masteredWordsCount: number;
  learningWordsCount: number;
  streakDaysCount: number;
  recentEventCount: number;
  dueWordCount: number;
  proficiencies: WordProficiencyView[];
  proficienciesLoading: boolean;
  weakPointMetrics: WeakPointMetric[];
  isTargetedReviewLoading: boolean;
  articleProgress: ArticleProgressRow[];
}

export const MyLearningScreen: React.FC<MyLearningScreenProps> = ({
  onBack,
  navigation,
  onStartTargetedReview,
  articlesReadCount,
  introducedWordsCount,
  masteredWordsCount,
  learningWordsCount,
  streakDaysCount,
  recentEventCount,
  dueWordCount,
  proficiencies,
  proficienciesLoading,
  isTargetedReviewLoading,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | null>(null);
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
      downloadVocabularyCsv(buildVocabularyCsv(rows));
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
      const backup = await exportLocalDataBackup();
      downloadLocalDataBackup(backup);
      const keyCount = Object.keys(backup.localStorage).length;
      setBackupMessage(
        `已导出 ${keyCount} 项本地数据${backup.indexedDb ? '（含词汇记忆库）' : ''}。文件仅保存在你的设备上。`
      );
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : '导出失败');
    } finally {
      setBackupBusy(null);
    }
  };

  const handleImportFile = async (file: File | null) => {
    if (!file) return;
    setBackupBusy('import');
    setBackupError(null);
    setBackupMessage(null);
    try {
      const raw = await readBackupFile(file);
      const confirmed = window.confirm(
        '导入将覆盖本浏览器中当前的学习进度、文章历史与词汇记忆，且不可撤销。是否继续？'
      );
      if (!confirmed) {
        setBackupBusy(null);
        return;
      }
      await importLocalDataBackup(raw);
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

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-7 sm:px-8 sm:py-9 safe-pb">
        <h1 className="text-2xl font-semibold tracking-tight text-[#2A2621]">学习概览</h1>

        <dl className="grid grid-cols-3 rounded-xl border border-[#E3DDD1] bg-[#FFFDFA] py-5" aria-label="核心学习统计">
          <MetricCard value={articlesReadCount} label="已完成文章" />
          <MetricCard value={introducedWordsCount} label="新引入词" />
          <MetricCard value={streakDaysCount} label="连续学习天数" />
        </dl>

        <section className="flex items-center justify-between gap-3 border-y border-[#E3DDD1] py-4" aria-labelledby="targeted-review-heading">
          <h2 id="targeted-review-heading" className="text-sm text-[#655B50]">
            待复习 <strong className="mx-1 font-semibold tabular-nums text-[#2A2621]">{dueWordCount}</strong> 词
          </h2>
          <button
            type="button"
            onClick={onStartTargetedReview}
            disabled={isTargetedReviewLoading}
            aria-busy={isTargetedReviewLoading}
            className="app-primary-action inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-wait disabled:bg-[#CFA08E]"
          >
            {isTargetedReviewLoading ? '正在生成复习文章…' : '开始复习'}
          </button>
        </section>

        <section className="space-y-3" aria-labelledby="learning-tools-heading">
          <h2 id="learning-tools-heading" className="text-xs font-medium text-[#85786B]">工具</h2>
          <div className="grid grid-cols-2 gap-2 min-[520px]:grid-cols-4">
            <button
              type="button"
              onClick={() => void handleExportVocabulary()}
              disabled={vocabularyExportBusy || proficienciesLoading || proficiencies.length === 0}
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
              onClick={() => fileInputRef.current?.click()}
              disabled={backupBusy !== null}
              aria-busy={backupBusy === 'import'}
              className={toolButtonClassName}
            >
              {backupBusy === 'import' ? '导入中…' : '导入备份'}
            </button>
            <a href="/extension-setup.html" className={toolButtonClassName}>安装查词插件</a>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              aria-label="选择学习备份文件"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                event.target.value = '';
                void handleImportFile(file);
              }}
            />
          </div>
          {vocabularyExportMessage && <p className="text-xs leading-5 text-[#2F6B3A]" role="status">{vocabularyExportMessage}</p>}
          {vocabularyExportError && <p className="text-xs leading-5 text-[#A94E2B]" role="alert">{vocabularyExportError}</p>}
          {backupMessage && <p className="text-xs leading-5 text-[#2F6B3A]" role="status">{backupMessage}</p>}
          {backupError && <p className="text-xs leading-5 text-[#A94E2B]" role="alert">{backupError}</p>}
        </section>

        <details className="border-t border-[#E3DDD1] pt-4 text-sm text-[#6B6156]">
          <summary className="cursor-pointer rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-[#A94E2B]">学习详情</summary>
          <div className="mt-4 space-y-3 text-xs leading-6">
            <dl className="flex flex-wrap gap-x-6 gap-y-1">
              <div className="flex gap-2"><dt>较熟悉词 (L4 估计)</dt><dd className="font-semibold tabular-nums text-[#443A30]">{masteredWordsCount}</dd></div>
              <div className="flex gap-2"><dt>学习中 (L1–L3)</dt><dd className="font-semibold tabular-nums text-[#443A30]">{learningWordsCount}</dd></div>
              <div className="flex gap-2"><dt>近 7 天学习事件</dt><dd className="font-semibold tabular-nums text-[#443A30]">{recentEventCount}</dd></div>
            </dl>
            <p>正式到期复习指已到复习时间的词。开始复习会把待复习词编入新文章。</p>
            <p>词汇等级根据阅读和查词行为估计，用于安排复习；未查词不代表已理解，也不代表通过了回忆测试。</p>
            <p>词汇表包含词汇、音标、翻译和熟练度，CSV 文件可用 Excel 打开。</p>
            {!proficienciesLoading && proficiencies.length === 0 && <p>阅读并产生词汇学习记录后，这里会出现可导出的词汇。</p>}
            <p>备份为 JSON 文件，可在本机或另一台设备导入恢复。导入前会确认覆盖当前记录。</p>
          </div>
        </details>

        <footer className="space-y-3 border-t border-[#E3DDD1] pt-4">
          <p className="text-xs leading-5 text-[#85786B]">学习数据保存在本机浏览器；换设备或清除站点数据前，请导出备份。</p>
          <div className="[&_details]:rounded-none [&_details]:border-0 [&_details]:bg-transparent [&_details]:p-0 [&_summary]:items-center [&_summary>div:first-child]:hidden [&_summary>div>span:first-child]:text-xs [&_summary>div>span:first-child]:font-medium [&_summary>div>span:first-child]:text-[#6B6156] [&_summary>div>span:last-child]:hidden [&_summary>svg]:mt-0 [&_summary>svg]:h-4 [&_summary>svg]:w-4">
            <ReadingDataNotice />
          </div>
        </footer>
      </main>
    </div>
  );
};

const toolButtonClassName = 'inline-flex min-h-10 min-w-0 items-center justify-center rounded-lg border border-[#DDD5C8] bg-[#FFFDFA] px-2 py-2 text-xs font-medium text-[#5D5247] transition-colors hover:bg-[#F0EBE2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A94E2B] disabled:cursor-not-allowed disabled:opacity-50';

const MetricCard: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div className="learning-metric-card flex min-w-0 flex-col items-center gap-2 px-1 text-center [&:not(:first-child)]:border-l [&:not(:first-child)]:border-[#E7E0D5]">
    <dt className="order-2 text-[11px] font-medium leading-5 text-[#82766A] sm:text-xs">{label}</dt>
    <dd className="text-3xl font-semibold tabular-nums tracking-tight text-[#44382D] sm:text-4xl">{value}</dd>
  </div>
);
