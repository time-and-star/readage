import { getApplicationStorage } from './localDatabase';
/**
 * Memory V2.2 产出能力追踪扩展
 * 补充识别维度之外的主动产出能力评估
 */

import { memoryV2 } from './memoryV2/hooks';

export interface ProductionScore {
  userId: string;
  wordId: string;
  score: number; // 0-1，产出能力分数
  lastUpdatedAt: string;
  correctUseCount: number;
  incorrectUseCount: number;
  avoidanceCount: number;
}

/**
 * 产出能力追踪器
 */
export class ProductionTracker {
  private storageKey = 'english-ai:v2:production';

  /**
   * 获取产出分数
   */
  async getProductionScore(userId: string, wordId: string): Promise<ProductionScore | null> {
    const storage = this.getStorage();
    if (!storage) return null;

    const key = `${this.storageKey}:${userId}:${wordId}`;
    const raw = storage.getItem(key);
    if (!raw) return null;

    try {
      return JSON.parse(raw) as ProductionScore;
    } catch {
      return null;
    }
  }

  /**
   * 保存产出分数
   */
  private async saveProductionScore(score: ProductionScore): Promise<void> {
    const storage = this.getStorage();
    if (!storage) return;

    const key = `${this.storageKey}:${score.userId}:${score.wordId}`;
    storage.setItem(key, JSON.stringify(score));
  }

  /**
   * 记录正确使用
   */
  async trackCorrectUse(userId: string, wordId: string, boost: number = 0.1): Promise<void> {
    let score = await this.getProductionScore(userId, wordId);

    if (!score) {
      score = {
        userId,
        wordId,
        score: 0,
        lastUpdatedAt: new Date().toISOString(),
        correctUseCount: 0,
        incorrectUseCount: 0,
        avoidanceCount: 0,
      };
    }

    score.correctUseCount++;
    score.score = Math.min(1, score.score + boost);
    score.lastUpdatedAt = new Date().toISOString();

    await this.saveProductionScore(score);
  }

  /**
   * 记录错误使用
   */
  async trackIncorrectUse(userId: string, wordId: string, penalty: number = 0.25): Promise<void> {
    let score = await this.getProductionScore(userId, wordId);

    if (!score) {
      score = {
        userId,
        wordId,
        score: 0,
        lastUpdatedAt: new Date().toISOString(),
        correctUseCount: 0,
        incorrectUseCount: 0,
        avoidanceCount: 0,
      };
    }

    score.incorrectUseCount++;
    score.score = Math.max(0, score.score - penalty);
    score.lastUpdatedAt = new Date().toISOString();

    await this.saveProductionScore(score);
  }

  /**
   * 记录回避使用
   */
  async trackAvoidance(userId: string, wordId: string, penalty: number = 0.12): Promise<void> {
    let score = await this.getProductionScore(userId, wordId);

    if (!score) {
      score = {
        userId,
        wordId,
        score: 0,
        lastUpdatedAt: new Date().toISOString(),
        correctUseCount: 0,
        incorrectUseCount: 0,
        avoidanceCount: 0,
      };
    }

    score.avoidanceCount++;
    score.score = Math.max(0, score.score - penalty);
    score.lastUpdatedAt = new Date().toISOString();

    await this.saveProductionScore(score);
  }

  /**
   * 批量获取产出分数
   */
  async getBatchProductionScores(
    userId: string,
    wordIds: string[]
  ): Promise<Map<string, ProductionScore>> {
    const scores = new Map<string, ProductionScore>();

    for (const wordId of wordIds) {
      const score = await this.getProductionScore(userId, wordId);
      if (score) {
        scores.set(wordId, score);
      }
    }

    return scores;
  }

  private getStorage(): Storage | null {
    if (typeof window === 'undefined') return null;
    return getApplicationStorage() ?? null;
  }
}

/**
 * 全局产出追踪器实例
 */
export const productionTracker = new ProductionTracker();

/**
 * 扩展的单词熟练度视图（包含产出能力）
 */
export interface ExtendedWordProficiency {
  wordId: string;
  memoryScore: number; // 0-100，识别能力
  productionScore: number; // 0-1，产出能力
  level: 0 | 1 | 2 | 3 | 4;
  stability: number;
  difficulty: number;
  nextReview: string;
  lastReview: string | null;
}

/**
 * 结合识别和产出能力计算最终等级
 */
export function computeLevelWithProduction(
  memoryScore: number, // 0-100
  productionScore: number, // 0-1
  retrievability: number // 0-1
): 0 | 1 | 2 | 3 | 4 {
  // 基础等级（纯识别）
  if (memoryScore < 20) return 0;
  if (memoryScore < 40) return 1;
  if (memoryScore < 60) return 2;

  // L3-L4 需要考虑产出能力
  if (retrievability >= 0.8 && productionScore >= 0.7) {
    return 4; // 识别和产出都优秀
  }

  if (retrievability >= 0.6 && productionScore >= 0.3) {
    return 3; // 识别好，产出尚可
  }

  // 识别好但产出差，降级到 L2
  if (memoryScore >= 60 && productionScore < 0.3) {
    return 2;
  }

  if (memoryScore < 85) return 3;
  return 4;
}

/**
 * 获取扩展的单词熟练度（识别 + 产出）
 */
export async function getExtendedWordProficiency(
  userId: string,
  wordId: string
): Promise<ExtendedWordProficiency | null> {
  const system = memoryV2.getSystem();

  // 获取识别能力（Memory V2.2）
  const recognition = await system.getWordProficiency(userId, wordId);
  if (!recognition) return null;

  // 获取产出能力
  const production = await productionTracker.getProductionScore(userId, wordId);
  const productionScore = production?.score || 0;

  // 计算 retrievability
  const retrievability = recognition.memoryScore / 100;

  // 重新计算等级
  const level = computeLevelWithProduction(
    recognition.memoryScore,
    productionScore,
    retrievability
  );

  return {
    wordId,
    memoryScore: recognition.memoryScore,
    productionScore,
    level,
    stability: recognition.stability,
    difficulty: recognition.difficulty,
    nextReview: recognition.nextReview,
    lastReview: recognition.lastReview,
  };
}

/**
 * 批量获取扩展的单词熟练度
 */
export async function getBatchExtendedProficiency(
  userId: string,
  wordIds: string[]
): Promise<Map<string, ExtendedWordProficiency>> {
  const system = memoryV2.getSystem();

  // 获取识别能力
  const recognitionMap = await system.getBatchWordProficiency(userId, wordIds);

  // 获取产出能力
  const productionMap = await productionTracker.getBatchProductionScores(userId, wordIds);

  // 合并数据
  const result = new Map<string, ExtendedWordProficiency>();

  for (const [wordId, recognition] of recognitionMap) {
    const production = productionMap.get(wordId);
    const productionScore = production?.score || 0;
    const retrievability = recognition.memoryScore / 100;

    const level = computeLevelWithProduction(
      recognition.memoryScore,
      productionScore,
      retrievability
    );

    result.set(wordId, {
      wordId,
      memoryScore: recognition.memoryScore,
      productionScore,
      level,
      stability: recognition.stability,
      difficulty: recognition.difficulty,
      nextReview: recognition.nextReview,
      lastReview: recognition.lastReview,
    });
  }

  return result;
}

/**
 * 查找文本中使用的单词
 */
export function findUsedLemmas(text: string, knownWords: string[]): string[] {
  const normalizedText = text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z'\s-]/g, ' ')
    .replace(/[-\s]+/g, ' ')
    .trim();

  return knownWords.filter(word => {
    const normalizedWord = word
      .toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[^a-z'\s-]/g, ' ')
      .trim();

    return ` ${normalizedText} `.includes(` ${normalizedWord} `);
  });
}

/**
 * 应用产出使用（正确）
 */
export async function applyProductionUse(
  text: string,
  knownWords: string[],
  boost: number = 0.1
): Promise<void> {
  const userId = memoryV2.getUserId();
  const usedWords = findUsedLemmas(text, knownWords);

  for (const wordId of usedWords) {
    await productionTracker.trackCorrectUse(userId, wordId, boost);
  }
}

/**
 * 应用错误使用
 */
export async function applyIncorrectUse(
  words: string[],
  penalty: number = 0.25
): Promise<void> {
  const userId = memoryV2.getUserId();

  for (const wordId of words) {
    await productionTracker.trackIncorrectUse(userId, wordId, penalty);
  }
}

/**
 * 应用回避使用
 */
export async function applyAvoidance(
  targetWords: string[],
  actualText: string,
  penalty: number = 0.12
): Promise<void> {
  const userId = memoryV2.getUserId();
  const usedWords = findUsedLemmas(actualText, targetWords);
  const avoidedWords = targetWords.filter(w => !usedWords.includes(w));

  for (const wordId of avoidedWords) {
    await productionTracker.trackAvoidance(userId, wordId, penalty);
  }
}

/**
 * 获取扩展的统计数据
 */
export async function getExtendedStats(userId: string): Promise<{
  total: number;
  byLevel: Record<number, number>;
  averageMemoryScore: number;
  averageProductionScore: number;
  dueCount: number;
}> {
  const system = memoryV2.getSystem();
  const allRecognition = await system.getAllWordProficiency(userId);

  const wordIds = allRecognition.map(p => p.wordId);
  const extended = await getBatchExtendedProficiency(userId, wordIds);

  const byLevel: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  let totalMemoryScore = 0;
  let totalProductionScore = 0;
  let dueCount = 0;
  const now = new Date();

  for (const prof of extended.values()) {
    byLevel[prof.level]++;
    totalMemoryScore += prof.memoryScore;
    totalProductionScore += prof.productionScore;

    if (new Date(prof.nextReview) <= now) {
      dueCount++;
    }
  }

  return {
    total: extended.size,
    byLevel,
    averageMemoryScore: extended.size > 0 ? totalMemoryScore / extended.size : 0,
    averageProductionScore: extended.size > 0 ? totalProductionScore / extended.size : 0,
    dueCount,
  };
}
