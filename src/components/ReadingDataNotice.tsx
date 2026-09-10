import React from 'react';
import { ChevronDown, HardDrive, Server, ShieldCheck } from 'lucide-react';

type ReadingDataRow = {
  label: string;
  collected: string;
  purpose: string;
  destination: string;
};

const READING_DATA_ROWS: readonly ReadingDataRow[] = [
  {
    label: '文章与进度',
    collected: '打开/完成过的文章、最近阅读时间、完成状态、查词/讨论次数、来源与难度。',
    purpose: '恢复阅读历史、统计学习天数，并避免重复推荐。',
    destination: '本机浏览器',
  },
  {
    label: '词汇学习证据',
    collected: '实际看到过的词、点击查询的词、所在文章/位置、曝光与点击次数、发生时间、本地日期/时区和复习状态。',
    purpose: '按设备本地自然日估计词汇记忆强度，安排到期复习，并匹配包含待复习词的文章。',
    destination: '本机浏览器',
  },
  {
    label: '测评与推荐依据',
    collected: '独立测评结果、可选的文章难度反馈，以及本次推荐使用的主题和复习词。',
    purpose: '使用阅读反馈调整文章难度与长度，使用词汇证据安排复习；测评不是阅读前置步骤。',
    destination: '学习档案在本机；推荐请求按需处理',
  },
  {
    label: '文章与主动输入',
    collected: '你粘贴/导入的文章，以及主动发送的选词、段落、翻译、改写或讨论内容。',
    purpose: '生成解释、翻译、难度评级、改写或讨论回复。',
    destination: '需要 AI 时发送至服务端；历史仍保存在本机',
  },
];

export function ReadingDataNotice() {
  return (
    <details className="group rounded-2xl border border-[#DED6C9] bg-[#FAF8F3] p-4 sm:p-5">
      <summary className="flex cursor-pointer list-none items-start gap-3 rounded-xl outline-none marker:hidden [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-[#A94E2B] focus-visible:ring-offset-2">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#F3E4DA] text-[#A94E2B]">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <span id="reading-data-notice-heading" className="block text-base font-semibold text-[#332E28]">
            阅读数据说明
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-[#6B645B]">
            了解哪些信息留在本机，以及主动使用 AI 时哪些内容会发送。
          </span>
        </div>
        <ChevronDown className="mt-1 h-5 w-5 shrink-0 text-[#6B645B] transition-transform group-open:rotate-180" aria-hidden />
      </summary>

      <div className="mt-4 border-t border-[#E8E1D8] pt-4">
        <p className="mb-4 text-sm leading-relaxed text-[#5A534B]">
          为了恢复学习、安排复习和匹配合适的文章，我们只记录与阅读学习直接相关的信息。不同数据的保存位置和用途如下。
        </p>
        <div className="overflow-hidden rounded-xl border border-[#E3DDD1] bg-white/80">
        <div className="hidden bg-[#F3EFE7] px-3 py-2 text-[11px] font-semibold text-[#6B645B] sm:grid sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:gap-3">
          <span>类别</span>
          <span>记录什么</span>
          <span>作用 / 为什么需要</span>
          <span className="text-right">保存或发送到哪里</span>
        </div>
        {READING_DATA_ROWS.map((row, index) => (
          <div
            key={row.label}
            className={`grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start sm:gap-3 ${
              index > 0 ? 'border-t border-[#E8E1D8]' : ''
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-[#4A4038]">
              {index < 3 ? (
                <HardDrive className="h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <Server className="h-4 w-4 shrink-0" aria-hidden />
              )}
              {row.label}
            </div>
            <div className="text-xs leading-relaxed text-[#4A5568]">
              <span className="font-semibold text-[#6B7C8F] sm:hidden">记录：</span>
              {row.collected}
            </div>
            <div className="text-xs leading-relaxed text-[#4A5568]">
              <span className="font-semibold text-[#6B7C8F] sm:hidden">用途：</span>
              {row.purpose}
            </div>
            <div className="text-xs font-medium leading-relaxed text-[#8F3F22] sm:max-w-44 sm:text-right">
              <span className="font-semibold text-[#6B7C8F] sm:hidden">去向：</span>
              {row.destination}
            </div>
          </div>
          ))}
        </div>

      <div className="mt-4 space-y-2 text-xs leading-relaxed text-[#4A5568]">
        <p>
          <strong className="text-[#4A4038]">主动调用 AI：</strong>
          需要服务端处理的查词、翻译、分级、改写或讨论，会发送本次主动提交的文本和必要上下文；不使用这些功能时，不会为了统计阅读而上传整篇文章。
        </p>
        <p>
          <strong className="text-[#4A4038]">推荐诊断：</strong>
          在开发环境或启用推荐诊断的站点，可能会发送 CEFR 档位、复习词、文章标识、候选匹配分数和时间，用于检查推荐质量；不包含整篇文章或讨论全文。
        </p>
        <p>
          学习档案默认保存在当前浏览器，不会自动上传为云端档案。清除站点数据会删除本机记录；你可以在下方导出备份。
        </p>
      </div>
      </div>
    </details>
  );
}
