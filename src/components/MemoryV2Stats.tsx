/**
 * Memory V2.2 统计卡片组件
 * 展示基于 Memory V2.2 系统的学习数据
 */

import React from 'react';
import { useProficiencyStats } from '../lib/memoryV2/hooks';
import { RECOGNITION_LEVEL_LABELS } from '../lib/wordMemoryDetails';

interface MemoryV2StatsProps {
  className?: string;
}

export const MemoryV2Stats: React.FC<MemoryV2StatsProps> = ({ className = '' }) => {
  const { stats, loading } = useProficiencyStats();

  if (loading) {
    return (
      <div className={`bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-4 ${className}`}>
        <div className="text-sm text-[#8C8478]">加载中...</div>
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  const { total, byLevel, averageScore, dueCount } = stats;

  return (
    <div className={`bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-5 ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-[#2C2723]">长期熟练度分布</h3>
        <span className="text-xs text-[#8C8478] bg-[#EFEAE0] px-2 py-1 rounded">
          稳定性评分
        </span>
      </div>

      {/* 等级分布 */}
      <div className="space-y-3 mb-4">
        <LevelBar level={4} count={byLevel[4] || 0} total={total} label={`L4 ${RECOGNITION_LEVEL_LABELS[4]}`} color="bg-green-500" />
        <LevelBar level={3} count={byLevel[3] || 0} total={total} label={`L3 ${RECOGNITION_LEVEL_LABELS[3]}`} color="bg-blue-500" />
        <LevelBar level={2} count={byLevel[2] || 0} total={total} label={`L2 ${RECOGNITION_LEVEL_LABELS[2]}`} color="bg-yellow-500" />
        <LevelBar level={1} count={byLevel[1] || 0} total={total} label={`L1 ${RECOGNITION_LEVEL_LABELS[1]}`} color="bg-orange-500" />
        <LevelBar level={0} count={byLevel[0] || 0} total={total} label={`L0 ${RECOGNITION_LEVEL_LABELS[0]}`} color="bg-gray-400" />
      </div>

      {/* 汇总信息 */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-[#524B43] pt-3 border-t border-[#E3DDD1]">
        <span>
          总词汇：<strong className="text-[#2C2723]">{total}</strong>
        </span>
        <span>
          平均分：<strong className="text-[#2C2723]">{averageScore.toFixed(1)}</strong>
        </span>
        <span>
          到期：<strong className="text-[#C35E37]">{dueCount}</strong>
        </span>
      </div>
    </div>
  );
};

interface LevelBarProps {
  level: number;
  count: number;
  total: number;
  label: string;
  color: string;
}

const LevelBar: React.FC<LevelBarProps> = ({ level, count, total, label, color }) => {
  const percentage = total > 0 ? (count / total) * 100 : 0;

  return (
    <div className="flex items-center gap-3">
      <div className="w-20 text-xs text-[#8C8478] text-right">{label}</div>
      <div className="flex-1 h-6 bg-[#EFEAE0] rounded-full overflow-hidden relative">
        <div
          className={`h-full ${color} transition-all duration-500 ease-out`}
          style={{ width: `${percentage}%` }}
        />
        <div className="absolute inset-0 flex items-center justify-center text-xs font-medium text-[#2C2723]">
          {count > 0 && `${count} (${percentage.toFixed(0)}%)`}
        </div>
      </div>
    </div>
  );
};

/**
 * Memory V2.2 到期单词列表
 */
interface MemoryV2DueWordsProps {
  limit?: number;
  onWordClick?: (wordId: string) => void;
  className?: string;
}

export const MemoryV2DueWords: React.FC<MemoryV2DueWordsProps> = ({
  limit = 10,
  onWordClick,
  className = '',
}) => {
  const { useDueWords } = require('../lib/memoryV2/hooks');
  const { dueWords, loading } = useDueWords(limit);

  if (loading) {
    return (
      <div className={`bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-4 ${className}`}>
        <div className="text-sm text-[#8C8478]">加载到期单词...</div>
      </div>
    );
  }

  if (dueWords.length === 0) {
    return (
      <div className={`bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-5 ${className}`}>
        <h3 className="font-semibold text-[#2C2723] mb-3">到期复习</h3>
        <p className="text-sm text-[#8C8478]">暂无到期单词，继续保持！</p>
      </div>
    );
  }

  return (
    <div className={`bg-[#FAF8F3] border border-[#E3DDD1] rounded-2xl p-5 ${className}`}>
      <h3 className="font-semibold text-[#2C2723] mb-3">
        到期复习 ({dueWords.length})
      </h3>
      <div className="space-y-2">
        {dueWords.map((word) => (
          <button
            key={word.wordId}
            onClick={() => onWordClick?.(word.wordId)}
            className="w-full flex items-center justify-between p-3 hover:bg-[#EFEAE0] rounded-xl transition-colors text-left"
          >
            <div>
              <div className="font-medium text-[#2C2723]">{word.wordId}</div>
              <div className="text-xs text-[#8C8478]">
                MS: {word.memoryScore.toFixed(0)} | L{word.level} |
                稳定性: {word.stability.toFixed(1)} 天
              </div>
            </div>
            <div className="text-xs text-[#C35E37]">
              {getDaysOverdue(word.nextReview)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

function getDaysOverdue(nextReview: string): string {
  const now = new Date();
  const due = new Date(nextReview);
  const diffMs = now.getTime() - due.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return `${diffDays} 天前`;
}
