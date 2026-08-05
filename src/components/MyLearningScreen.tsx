import React, { useRef, useState } from 'react';
import { CheckCircle2, Clock3, Download, HardDrive, Upload } from 'lucide-react';
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from 'recharts';
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
  onStartEnglishTest?: () => void;
  onStartRecommendedReading?: () => void;
  assessedBand?: string | null;
  assessmentCompletedAt?: string | null;
  articlesReadCount: number;
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
  onOpenArticle,
  onStartEnglishTest,
  onStartRecommendedReading,
  assessedBand,
  assessmentCompletedAt,
  articlesReadCount,
  masteredWordsCount,
  learningWordsCount,
  streakDaysCount,
  recentEventCount,
  dueWordCount,
  proficiencies,
  proficienciesLoading,
  weakPointMetrics,
  isTargetedReviewLoading,
  articleProgress,
}) => {
  const radarData = weakPointMetrics.slice(0, 6).map((metric) => ({
    skill: metric.skill.slice(0, 16),
    severity: metric.severity,
    issueCount: metric.issueCount,
  }));
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
    <div className="min-h-screen bg-[#F8F6F0] text-[#2B2723] flex flex-col justify-between selection:bg-[#FDE68A]">
      <AppPageHeader onBack={onBack} navigation={navigation} />

      <main className="flex-1 max-w-2xl w-full mx-auto px-4 sm:px-6 py-5 sm:py-6 space-y-5 sm:space-y-6 safe-pb">
        <section
          className="rounded-2xl border border-[#D6E4F0] bg-[#F3F7FB] px-4 py-3 flex gap-3"
          aria-labelledby="local-data-notice-heading"
        >
          <HardDrive className="w-5 h-5 shrink-0 text-[#1E3A8A] mt-0.5" aria-hidden />
          <div className="min-w-0">
            <h2 id="local-data-notice-heading" className="text-sm font-semibold text-[#1E3A8A]">
              学习数据保存在本机浏览器
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#4A5568]">
              常规学习档案默认只写在当前设备，不会自动上传为云端档案。AI 请求和推荐诊断有单独的数据去向，请查看下方说明。
              换设备或清除站点数据会丢失进度；可用下方「导出备份」保存到文件。
            </p>
          </div>
        </section>

        <ReadingDataNotice />

        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          <MetricCard value={articlesReadCount} label="已完成文章" />
          <MetricCard value={masteredWordsCount} label="掌握词 (L4)" />
          <MetricCard value={learningWordsCount} label="学习中 (L1–L3)" />
          <MetricCard value={streakDaysCount} label="连续学习天数" />
        </div>

        <section
          className="bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-4 space-y-3"
          aria-labelledby="vocabulary-export-heading"
        >
          <div>
            <h2 id="vocabulary-export-heading" className="font-serif text-lg font-medium text-[#2A2621]">
              词汇表
            </h2>
            <p className="mt-1 text-sm text-[#8C8478]">
              导出词汇、英标、翻译和熟练度，CSV 文件可直接用 Excel 打开。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleExportVocabulary()}
            disabled={vocabularyExportBusy || proficienciesLoading || proficiencies.length === 0}
            aria-busy={vocabularyExportBusy || proficienciesLoading}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#C35E37] px-3 py-2 text-sm font-medium text-white hover:bg-[#A94E2B] disabled:cursor-not-allowed disabled:bg-[#CFA08E]"
          >
            <Download className="w-4 h-4" aria-hidden />
            {proficienciesLoading ? '加载中…' : vocabularyExportBusy ? '导出中…' : '导出词汇表'}
          </button>
          {!proficienciesLoading && proficiencies.length === 0 && (
            <p className="text-xs text-[#8C8478]" role="status">
              阅读并产生词汇学习记录后，这里会出现可导出的词汇。
            </p>
          )}
          {vocabularyExportMessage && (
            <p className="text-xs text-[#2F6B3A]" role="status">
              {vocabularyExportMessage}
            </p>
          )}
          {vocabularyExportError && (
            <p className="text-xs text-[#A94E2B]" role="alert">
              {vocabularyExportError}
            </p>
          )}
        </section>

        <section
          className="bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-4 space-y-3"
          aria-labelledby="cefr-profile-heading"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="cefr-profile-heading" className="font-serif text-lg font-medium text-[#2A2621]">
                阅读等级
              </h2>
              <p className="mt-1 text-sm text-[#8C8478]">
                {assessedBand
                  ? '来自英语测试，已同步到推荐与文库筛选。'
                  : '尚未定级：完成英语测试后，推荐会按你的 CEFR 档位匹配。'}
              </p>
            </div>
            <div className="shrink-0 rounded-xl bg-[#C35E37]/10 px-3 py-2 text-center">
              <div className="text-xs text-[#8C8478]">CEFR</div>
              <div className="font-serif text-xl font-semibold text-[#C35E37]">
                {assessedBand || '—'}
              </div>
            </div>
          </div>
          {assessmentCompletedAt && (
            <p className="text-xs text-[#8C8478]">
              最近测试：{new Date(assessmentCompletedAt).toLocaleString()}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {onStartEnglishTest && (
              <button
                type="button"
                onClick={onStartEnglishTest}
                className="rounded-xl border border-[#DCD5C7] bg-white px-3 py-2 text-sm font-medium text-[#332E28] hover:bg-[#F2ECE0]"
              >
                {assessedBand ? '重新测试' : '开始英语测试'}
              </button>
            )}
            {assessedBand && onStartRecommendedReading && (
              <button
                type="button"
                onClick={onStartRecommendedReading}
                className="rounded-xl bg-[#C35E37] px-3 py-2 text-sm font-medium text-white hover:bg-[#A94E2B]"
              >
                按 {assessedBand} 推荐阅读
              </button>
            )}
          </div>
        </section>

        <div className="bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-4 text-sm text-[#524B43] flex flex-wrap gap-x-5 gap-y-2">
          <span>
            到期复习：<strong className="text-[#C35E37]">{dueWordCount}</strong> 词
          </span>
          <span>
            近 7 天学习事件：<strong>{recentEventCount}</strong>
          </span>
        </div>

        {false && <section className="space-y-2" aria-labelledby="article-progress-heading">
          <h2 id="article-progress-heading" className="font-serif text-lg font-medium text-[#2A2621]">
            按文章的进度
          </h2>
          {articleProgress.length === 0 ? (
            <p className="text-sm text-[#8C8478] bg-[#FAF8F3] border border-[#E3DDD1] rounded-xl p-4">
              打开文章学习后，这里会记录阅读状态、查词与讨论次数。
            </p>
          ) : (
            <ul className="space-y-2">
              {articleProgress.map(({ article, discussionCount }) => {
                const completed = article.status === 'Completed';
                return (
                  <li key={article.id}>
                    <button
                      type="button"
                      onClick={() => onOpenArticle(article.id)}
                      className="w-full text-left bg-[#FAF8F3] hover:bg-[#F3EFE4] border border-[#E3DDD1] rounded-xl p-4 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3 mb-1.5">
                        <span className="font-medium text-sm text-[#2A2621]">{article.title}</span>
                        <span className={`inline-flex items-center gap-1 shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          completed
                            ? 'bg-[#E6F2E8] text-[#2F6B3A]'
                            : 'bg-[#EFEAE0] text-[#6B645B]'
                        }`}>
                          {completed ? <CheckCircle2 className="w-3 h-3" /> : <Clock3 className="w-3 h-3" />}
                          {completed ? '已完成' : '学习中'}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-3 text-[11px] text-[#6B645B]">
                        <span>讨论 {discussionCount}</span>
                        <span className="text-[#C35E37]">继续 →</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>}

        {false && <section
          className="bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-6 shadow-2xs"
          aria-labelledby="weak-points-heading"
        >
          <h2 id="weak-points-heading" className="text-xs font-semibold text-[#8C8478] uppercase tracking-wider">
            需要加强的知识点
          </h2>
          <p className="text-[11px] text-[#8C8478] mt-1 mb-3">
            根据近期结构化批改记录中知识点出现的次数计算，图形越靠外表示越需要复习。
          </p>

          {radarData.length === 0 ? (
            <div className="min-h-40 rounded-xl border border-dashed border-[#DCD5C8] bg-[#F7F4ED] px-5 py-8 flex flex-col items-center justify-center text-center">
              <CheckCircle2 className="w-8 h-8 text-[#6F9B73] mb-2" />
              <p className="text-sm font-medium text-[#4A443C]">尚未发现明确薄弱点</p>
              <p className="text-xs text-[#8C8478] mt-1">完成口语批改后，这里会显示真实反馈频次。</p>
            </div>
          ) : (
            <>
              <div className="h-56 w-full" aria-label="薄弱点频次雷达图">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
                    <PolarGrid stroke="#E2DDD0" />
                    <PolarAngleAxis
                      dataKey="skill"
                      tick={{ fill: '#4A443C', fontSize: 12, fontWeight: 500 }}
                    />
                    <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                    <Radar
                      name="需加强程度"
                      dataKey="severity"
                      stroke="#C35E37"
                      fill="#E8A387"
                      fillOpacity={0.42}
                      strokeWidth={2}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {weakPointMetrics.map((metric) => (
                  <span
                    key={metric.skill}
                    className="px-2 py-1 bg-[#FDF2EE] text-[#A94E2B] border border-[#FADCD1] rounded-md text-[11px]"
                  >
                    {metric.skill} · {metric.issueCount} 次记录
                  </span>
                ))}
              </div>
            </>
          )}
        </section>}

        <section
          className="bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-4 space-y-3"
          aria-labelledby="local-backup-heading"
        >
          <div>
            <h2 id="local-backup-heading" className="font-serif text-lg font-medium text-[#2A2621]">
              本地数据备份
            </h2>
            <p className="mt-1 text-sm text-[#8C8478]">
              导出为 JSON 文件，可在本机或另一台设备导入恢复。服务器不保存你的学习档案。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleExportBackup()}
              disabled={backupBusy !== null}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#DCD5C7] bg-white px-3 py-2 text-sm font-medium text-[#332E28] hover:bg-[#F2ECE0] disabled:opacity-60"
            >
              <Download className="w-4 h-4" aria-hidden />
              {backupBusy === 'export' ? '导出中…' : '导出备份'}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={backupBusy !== null}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#DCD5C7] bg-white px-3 py-2 text-sm font-medium text-[#332E28] hover:bg-[#F2ECE0] disabled:opacity-60"
            >
              <Upload className="w-4 h-4" aria-hidden />
              {backupBusy === 'import' ? '导入中…' : '导入备份'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                event.target.value = '';
                void handleImportFile(file);
              }}
            />
          </div>
          {backupMessage && (
            <p className="text-xs text-[#2F6B3A]" role="status">
              {backupMessage}
            </p>
          )}
          {backupError && (
            <p className="text-xs text-[#A94E2B]" role="alert">
              {backupError}
            </p>
          )}
        </section>

        <div className="space-y-2">
          <button
            type="button"
            onClick={onStartTargetedReview}
            disabled={isTargetedReviewLoading}
            aria-busy={isTargetedReviewLoading}
            className="w-full py-4 bg-[#C35E37] enabled:hover:bg-[#A94E2B] disabled:bg-[#CFA08E] disabled:cursor-wait text-white rounded-xl font-medium text-lg transition-all shadow-md text-center block"
          >
            {isTargetedReviewLoading ? '正在生成复习文章…' : '针对性复习（语境文章 → P2）'}
          </button>
          <p className="text-[11px] text-center text-[#8C8478]">
            到期词会被织入新文章，不提供孤立词卡。
          </p>
        </div>
      </main>
    </div>
  );
};

const MetricCard: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div className="bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-6 text-center shadow-2xs">
    <div className="text-4xl sm:text-5xl font-bold text-[#1E3A8A] tracking-tight mb-2">
      {value}
    </div>
    <div className="text-sm font-medium text-[#6B645B]">{label}</div>
  </div>
);
