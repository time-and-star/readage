/**
 * Automated acceptance harness for Reading Memory Engine V2.2 / V4 / V5.
 *
 * Drives MemorySystemV2 through a simulated multi-day learner, then ranks
 * the next article. Asserts the V4 acceptance criteria from RME_V4_SPEC.md
 * against the live persistence + recommendation path.
 *
 * Usage:
 *   npx tsx scripts/test-memory-system.ts
 *   npm run test:memory
 *   npm run test:memory -- --unit
 *   npm run test:memory -- --json
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem.ts';
import type { MemoryStorage } from '../src/lib/memoryV2/storage.ts';
import type {
  ArticleWordEvidence,
  DailyWordEvidence,
  FinalizationTask,
  RawWordEvent,
  WordMemoryState,
} from '../src/lib/memoryV2/types.ts';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration.ts';
import {
  MemoryV2Store,
  setDefaultMemoryStore,
} from '../src/lib/memoryV2/memoryStore.ts';
import {
  createMemoryV2Adapter,
  rankMagazineLemmaCandidates,
} from '../src/lib/memoryV2RecommendationAdapter.ts';
import type { ArticleCandidate } from '../src/lib/memoryV2/recommendation.ts';
import { scoreArticleOpportunity } from '../src/lib/memoryV4/opportunity.ts';
import { rankArticlesV5 } from '../src/lib/recommendationV5.ts';
import { buildCefrRecommendationProfile } from '../src/lib/userReadingProfile.ts';

const USER_ID = 'memory-lab-user';
const TIMEZONE = 'UTC';
const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = Date.UTC(2026, 6, 1, 12, 0, 0);

type CheckResult = {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
  error?: string;
};

const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const runUnit = args.has('--unit');

class MemoryStorageFake implements MemoryStorage {
  raw = new Map<string, RawWordEvent[]>();
  article = new Map<string, ArticleWordEvidence>();
  daily = new Map<string, DailyWordEvidence>();
  states = new Map<string, WordMemoryState>();
  tasks = new Map<string, FinalizationTask>();

  private rawKey(userId: string, wordId: string, localDate: string) {
    return `${userId}:${wordId}:${localDate}`;
  }

  async saveRawEvent(event: RawWordEvent): Promise<void> {
    const key = this.rawKey(event.userId, event.wordId, event.localDate);
    this.raw.set(key, [...(this.raw.get(key) ?? []), event]);
  }

  async saveRawEvents(events: RawWordEvent[]): Promise<void> {
    for (const event of events) await this.saveRawEvent(event);
  }

  async getRawEventsByDate(userId: string, wordId: string, localDate: string) {
    return this.raw.get(this.rawKey(userId, wordId, localDate)) ?? [];
  }

  async getRawEventsByDateRange(
    userId: string,
    wordId: string,
    startDate: string,
    endDate: string,
  ) {
    return [...this.raw.entries()]
      .filter(([key]) => key.startsWith(`${userId}:${wordId}:`))
      .flatMap(([, events]) => events)
      .filter((event) => event.localDate >= startDate && event.localDate <= endDate);
  }

  async deleteRawEventsByDate(userId: string, wordId: string, localDate: string) {
    this.raw.delete(this.rawKey(userId, wordId, localDate));
  }

  async saveArticleEvidence(evidence: ArticleWordEvidence): Promise<void> {
    this.article.set(
      `${evidence.userId}:${evidence.wordId}:${evidence.articleId}:${evidence.localDate}`,
      evidence,
    );
  }

  async getArticleEvidence(
    userId: string,
    wordId: string,
    articleId: string,
    localDate: string,
  ) {
    return this.article.get(`${userId}:${wordId}:${articleId}:${localDate}`) ?? null;
  }

  async getArticleEvidencesByDate(userId: string, wordId: string, localDate: string) {
    return [...this.article.values()].filter(
      (item) =>
        item.userId === userId && item.wordId === wordId && item.localDate === localDate,
    );
  }

  async saveDailyEvidence(evidence: DailyWordEvidence): Promise<void> {
    this.daily.set(`${evidence.userId}:${evidence.wordId}:${evidence.localDate}`, evidence);
  }

  async getDailyEvidence(userId: string, wordId: string, localDate: string) {
    return this.daily.get(`${userId}:${wordId}:${localDate}`) ?? null;
  }

  async getUnfinalizedDailyEvidence(userId: string) {
    return [...this.daily.values()].filter((item) => item.userId === userId && !item.finalizedAt);
  }

  async getUnfinalizedDailyEvidenceByDate(userId: string, localDate: string) {
    return [...this.daily.values()].filter(
      (item) => item.userId === userId && item.localDate === localDate && !item.finalizedAt,
    );
  }

  async markDailyEvidenceFinalized(
    userId: string,
    wordId: string,
    localDate: string,
    finalizedAt: string,
  ) {
    const key = `${userId}:${wordId}:${localDate}`;
    const current = this.daily.get(key);
    if (!current) return;
    this.daily.set(key, { ...current, finalizedAt });
  }

  async saveMemoryState(state: WordMemoryState): Promise<void> {
    this.states.set(`${state.userId}:${state.wordId}`, state);
  }

  async getMemoryState(userId: string, wordId: string) {
    return this.states.get(`${userId}:${wordId}`) ?? null;
  }

  async getBatchMemoryStates(userId: string, wordIds: string[]) {
    const map = new Map<string, WordMemoryState>();
    for (const wordId of wordIds) {
      const state = await this.getMemoryState(userId, wordId);
      if (state) map.set(wordId, state);
    }
    return map;
  }

  async getAllMemoryStates(userId: string) {
    return [...this.states.values()].filter((state) => state.userId === userId);
  }

  async createFinalizationTask(task: FinalizationTask): Promise<void> {
    this.tasks.set(`${task.userId}:${task.localDate}`, task);
  }

  async getPendingFinalizationTasks(userId: string) {
    return [...this.tasks.values()].filter((task) => task.userId === userId);
  }

  async deleteFinalizationTask(userId: string, localDate: string): Promise<void> {
    this.tasks.delete(`${userId}:${localDate}`);
  }
}

class MemoryLab {
  readonly storage = new MemoryStorageFake();
  readonly system: MemorySystemV2;
  readonly store: MemoryV2Store;

  constructor() {
    this.system = new MemorySystemV2(this.storage);
    this.store = new MemoryV2Store({
      storage: this.storage,
      userId: USER_ID,
      timezone: TIMEZONE,
      now: () => new Date('2026-09-21T12:00:00.000Z'),
    });
  }

  installStore(): void {
    setDefaultMemoryStore(this.store);
  }

  at(day: number, hour = 12): Date {
    return new Date(ORIGIN + day * DAY_MS + (hour - 12) * 60 * 60 * 1000);
  }

  localDate(at: Date): string {
    return at.toISOString().slice(0, 10);
  }

  occurrence(articleId: string, wordId: string, at: Date, slot = 0): string {
    return `${articleId}:p0:w${slot}:${wordId}:${at.toISOString()}`;
  }

  async expose(input: {
    wordId: string;
    articleId: string;
    at: Date;
    clicked?: boolean;
    isRecommendation?: boolean;
    dwellTimeMs?: number;
    expectedDwellTimeMs?: number;
    slot?: number;
  }): Promise<RawWordEvent> {
    const occurrenceId = this.occurrence(
      input.articleId,
      input.wordId,
      input.at,
      input.slot ?? 0,
    );
    const event: RawWordEvent = {
      userId: USER_ID,
      wordId: input.wordId,
      articleId: input.articleId,
      occurrenceId,
      eventType: 'exposure',
      occurredAt: input.at.toISOString(),
      localDate: this.localDate(input.at),
      isRecommendation: input.isRecommendation,
      dwellTimeMs: input.dwellTimeMs,
      expectedDwellTimeMs: input.expectedDwellTimeMs,
    };
    await this.system.recordEvent(event);
    if (input.clicked) {
      await this.system.recordEvent({
        ...event,
        eventType: 'click',
        occurredAt: new Date(input.at.getTime() + 1000).toISOString(),
      });
    }
    return event;
  }

  async finalizePast(): Promise<void> {
    await this.system.finalizeHistoricalDates(USER_ID, TIMEZONE);
  }

  state(wordId: string): Promise<WordMemoryState | null> {
    return this.storage.getMemoryState(USER_ID, wordId);
  }

  evidence(wordId: string, localDate: string): Promise<DailyWordEvidence | null> {
    return this.storage.getDailyEvidence(USER_ID, wordId, localDate);
  }

  proficiency(wordId: string, now = new Date('2026-09-21T12:00:00.000Z')) {
    return this.system.getWordProficiency(USER_ID, wordId, now);
  }

  allProficiency(now = new Date('2026-09-21T12:00:00.000Z')) {
    return this.system.getAllWordProficiency(USER_ID, now);
  }
}

function candidate(
  id: string,
  lemmas: string[],
  options: { level?: string; topic?: string; wordCount?: number } = {},
): ArticleCandidate {
  const level = options.level ?? 'B1';
  const content = lemmas.length > 0 ? [lemmas.join(' ')] : ['the'];
  return {
    article: {
      id,
      title: id,
      content,
      level,
      topic: options.topic,
      estimatedWordCount: options.wordCount ?? Math.max(180, lemmas.length * 20),
      levelRating: { level, estimatedWordCount: options.wordCount ?? 220 },
    },
    lemmas,
  };
}

async function check(
  name: string,
  run: () => void | Promise<void>,
): Promise<CheckResult> {
  const started = Date.now();
  try {
    await run();
    return { name, ok: true, ms: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    return {
      name,
      ok: false,
      ms: Date.now() - started,
      error: stack && !jsonMode ? `${message}\n${stack}` : message,
    };
  }
}

async function runScenarios(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = async (name: string, run: () => void | Promise<void>) => {
    results.push(await check(name, run));
  };

  await add('E1 首次曝光只建档，不提交 FSRS', async () => {
    const lab = new MemoryLab();
    await lab.expose({ wordId: 'abandon', articleId: 'article-a', at: lab.at(0) });
    const state = await lab.state('abandon');
    const evidence = await lab.evidence('abandon', '2026-07-01');
    assert.ok(state?.rme, 'should create a V4 profile');
    assert.equal(state?.rme?.exposureHistory[0]?.kind, 'new');
    assert.equal(state?.rme?.exposureHistory[0]?.isValid, false);
    assert.equal(state?.fsrsCard.reps, 0);
    assert.equal(state?.fsrsReviews.length, 0);
    assert.equal(evidence?.validExposureCount, 0);
    assert.equal(evidence?.pendingGrade, null);
  });

  await add('E2 自然曝光 24 小时窗口内不形成有效证据', async () => {
    const lab = new MemoryLab();
    await lab.expose({ wordId: 'maintain', articleId: 'article-a', at: lab.at(0, 12) });
    await lab.expose({ wordId: 'maintain', articleId: 'article-b', at: lab.at(0, 23) });
    const sameDay = await lab.state('maintain');
    assert.equal(sameDay?.rme?.exposureHistory[1]?.kind, 'natural');
    assert.equal(sameDay?.rme?.exposureHistory[1]?.isValid, false);
    assert.equal(sameDay?.rme?.lastEffectiveExposureAt, null);

    await lab.expose({ wordId: 'maintain', articleId: 'article-c', at: lab.at(2, 12) });
    const nextDay = await lab.state('maintain');
    assert.equal(nextDay?.rme?.exposureHistory[2]?.kind, 'natural');
    assert.equal(nextDay?.rme?.exposureHistory[2]?.isValid, true);
    assert.ok(nextDay?.rme?.lastEffectiveExposureAt);
    const evidence = await lab.evidence('maintain', '2026-07-03');
    assert.equal(evidence?.validExposureCount, 1);
    assert.equal(evidence?.pendingGrade, 'Good');
  });

  await add('点击把对应 occurrence 的 Quality 归零，并记为 Again', async () => {
    const lab = new MemoryLab();
    const first = await lab.expose({
      wordId: 'constraint',
      articleId: 'article-a',
      at: lab.at(0),
    });
    await lab.expose({
      wordId: 'constraint',
      articleId: 'article-b',
      at: lab.at(1, 13),
      clicked: true,
    });
    const state = await lab.state('constraint');
    const clicked = state?.rme?.exposureHistory.find(
      (item) => item.articleId === 'article-b',
    );
    assert.equal(clicked?.quality, 0);
    const firstQuality = state?.rme?.exposureHistory.find(
      (item) => item.occurrenceId === first.occurrenceId,
    )?.quality;
    assert.equal(firstQuality, 1);
    const evidence = await lab.evidence('constraint', '2026-07-02');
    assert.equal(evidence?.pendingGrade, 'Again');
    assert.equal(evidence?.clickedOccurrenceCount, 1);
  });

  await add('同一篇文章不能当作新的有效计划曝光', async () => {
    const lab = new MemoryLab();
    await lab.expose({ wordId: 'signal', articleId: 'article-a', at: lab.at(0) });
    await lab.expose({
      wordId: 'signal',
      articleId: 'article-b',
      at: lab.at(1, 13),
      isRecommendation: true,
    });
    const afterValid = await lab.state('signal');
    assert.equal(afterValid?.rme?.lastEffectiveExposureAt, lab.at(1, 13).toISOString());

    await lab.expose({
      wordId: 'signal',
      articleId: 'article-b',
      at: lab.at(3, 12),
      isRecommendation: true,
      slot: 1,
    });
    const repeated = await lab.state('signal');
    const last = repeated?.rme?.exposureHistory.at(-1);
    assert.equal(last?.kind, 'scheduled');
    assert.equal(last?.isValid, false);
    assert.equal(repeated?.rme?.lastEffectiveExposureAt, lab.at(1, 13).toISOString());
  });

  await add('连续 3 个跨自然日 Again 进入强制曝光，两次高质量 Good 后退出', async () => {
    const lab = new MemoryLab();
    const wordId = 'fragile';
    await lab.expose({ wordId, articleId: 'intro', at: lab.at(0) });

    for (let day = 1; day <= 3; day += 1) {
      await lab.expose({
        wordId,
        articleId: `fail-${day}`,
        at: lab.at(day, 13),
        clicked: true,
      });
      await lab.finalizePast();
    }
    const forced = await lab.state(wordId);
    assert.equal(forced?.rme?.forcedExposure, true);
    assert.equal(forced?.rme?.consecutiveAgain, 3);
    assert.ok((forced?.fsrsCard.reps ?? 0) >= 3, 'three Again days should submit FSRS');

    for (let day = 4; day <= 7; day += 1) {
      await lab.expose({
        wordId,
        articleId: `recover-${day}`,
        at: lab.at(day, 13),
      });
      await lab.finalizePast();
    }
    const recovered = await lab.state(wordId);
    assert.equal(recovered?.rme?.forcedExposure, false);
    assert.equal(recovered?.rme?.recoveryStreak, 0);
    assert.equal(recovered?.rme?.lastReviewGrade, 'Good');
  });

  await add('旧 V2.2 记录无需迁移即可继续学习和重算分数', async () => {
    const lab = new MemoryLab();
    const legacy = initializeWordMemory(USER_ID, 'legacy');
    assert.equal(legacy.rme, undefined);
    await lab.storage.saveMemoryState(legacy);
    await lab.expose({
      wordId: 'legacy',
      articleId: 'article-new',
      at: lab.at(2),
      isRecommendation: true,
    });
    const state = await lab.state('legacy');
    assert.ok(state?.rme, 'legacy state should gain a V4 profile on next exposure');
    assert.equal(state?.fsrsCard.reps, legacy.fsrsCard.reps);
    const view = await lab.proficiency('legacy', lab.at(2));
    assert.ok(view);
    assert.equal(typeof view?.confidence, 'number');
    assert.equal(typeof view?.opportunityScore, 'number');
    assert.ok((view?.confidence ?? -1) >= 0 && (view?.confidence ?? 101) <= 100);
    assert.ok((view?.opportunityScore ?? -1) >= 0 && (view?.opportunityScore ?? 101) <= 100);
  });

  await add('Confidence / Opportunity 可从真实存储状态稳定重算', async () => {
    const lab = new MemoryLab();
    await lab.expose({ wordId: 'stable', articleId: 'a1', at: lab.at(0) });
    await lab.expose({ wordId: 'stable', articleId: 'a2', at: lab.at(1, 13) });
    await lab.expose({ wordId: 'stable', articleId: 'a3', at: lab.at(2, 13) });
    await lab.finalizePast();
    const first = await lab.proficiency('stable', lab.at(10));
    const second = await lab.proficiency('stable', lab.at(10));
    assert.ok(first && second);
    assert.equal(first?.confidence, second?.confidence);
    assert.equal(first?.opportunityScore, second?.opportunityScore);
    assert.ok((first?.opportunityScore ?? 0) > 0);
  });

  await add('文章按唯一高机会词覆盖排序，重复词不计两次', async () => {
    const lab = new MemoryLab();
    lab.installStore();
    await lab.expose({ wordId: 'urgent', articleId: 'seed', at: lab.at(0) });
    await lab.expose({ wordId: 'steady', articleId: 'seed', at: lab.at(0), slot: 1 });
    for (let day = 1; day <= 3; day += 1) {
      await lab.expose({
        wordId: 'urgent',
        articleId: `fail-${day}`,
        at: lab.at(day, 13),
        clicked: true,
      });
      await lab.expose({
        wordId: 'steady',
        articleId: `fail-${day}`,
        at: lab.at(day, 13),
        slot: 1,
      });
      await lab.finalizePast();
    }
    const urgent = await lab.proficiency('urgent');
    const steady = await lab.proficiency('steady');
    assert.ok((urgent?.opportunityScore ?? 0) >= 80);
    assert.ok((steady?.opportunityScore ?? 0) > 0);

    const ranked = await createMemoryV2Adapter({
      userLevel: 'B1',
      applyHardFilters: false,
    }).recommendCandidates(
      [
        candidate('padded', ['urgent', 'urgent', 'urgent']),
        candidate('unique-high', ['urgent', 'steady']),
        candidate('low', ['steady']),
      ],
      { limit: 3, applyHardFilters: false },
    );

    assert.equal(ranked[0]?.articleId, 'unique-high');
    const padded = ranked.find((row) => row.articleId === 'padded');
    const unique = ranked.find((row) => row.articleId === 'unique-high');
    assert.ok(unique && padded);
    assert.ok(
      (unique.opportunityCoverage ?? 0) > (padded.opportunityCoverage ?? 0),
      `unique coverage ${unique.opportunityCoverage} should beat padded ${padded.opportunityCoverage}`,
    );

    const opportunityByWord = new Map<string, number>([
      ['urgent', urgent?.opportunityScore ?? 0],
      ['steady', steady?.opportunityScore ?? 0],
    ]);
    const uniqueScore = scoreArticleOpportunity({
      lemmas: ['urgent', 'steady'],
      opportunityByWord,
    });
    const paddedScore = scoreArticleOpportunity({
      lemmas: ['urgent', 'urgent', 'urgent'],
      opportunityByWord,
    });
    assert.equal(paddedScore.coveredWords.length, 1);
    assert.ok(uniqueScore.opportunityCoverage > paddedScore.opportunityCoverage);
  });

  await add('已读文章继续被排除，CEFR 安全窗口保持有效', async () => {
    const lab = new MemoryLab();
    lab.installStore();
    await lab.expose({ wordId: 'target', articleId: 'read-me', at: lab.at(0) });
    await lab.expose({ wordId: 'target', articleId: 'fresh-hit', at: lab.at(1, 13) });
    await lab.finalizePast();

    const ranked = await rankMagazineLemmaCandidates(
      [
        candidate('read-me', ['target'], { level: 'B1' }),
        candidate('fresh-hit', ['target'], { level: 'B1' }),
        candidate('also-ok', ['target', 'other'], { level: 'B1' }),
      ],
      {
        userLevel: 'B1',
        reviewWords: ['target'],
        excludeArticleIds: ['read-me'],
        limit: 5,
      },
    );
    const ids = ranked.map((row) => row.articleId);
    assert.equal(ids.includes('read-me'), false);
    assert.ok(ids.includes('fresh-hit') || ids.includes('also-ok'));

    const cefrRanked = await createMemoryV2Adapter({
      userLevel: 'B1',
      applyHardFilters: true,
      cefrHardFilter: true,
      cefrProfile: buildCefrRecommendationProfile('B1', {
        confidence: 'high',
        useLevelFilter: true,
      }),
      minCandidatesAfterCefrFilter: 1,
    }).recommendCandidates(
      [
        candidate('fresh-hit', ['target'], { level: 'B1' }),
        candidate('also-ok', ['target', 'other'], { level: 'B1' }),
        candidate('too-hard', ['target'], { level: 'C2' }),
        candidate('also-b1', ['target', 'river'], { level: 'B1' }),
      ],
      {
        limit: 10,
        applyHardFilters: true,
        cefrHardFilter: true,
        cefrProfile: buildCefrRecommendationProfile('B1', {
          confidence: 'high',
          useLevelFilter: true,
        }),
        minCandidatesAfterCefrFilter: 1,
      },
    );
    assert.equal(cefrRanked.some((row) => row.articleId === 'too-hard'), false);
    assert.ok(cefrRanked.some((row) => row.articleId === 'fresh-hit'));
  });

  await add('V5 在机会分相近时提高兴趣和目标匹配文章', async () => {
    const ranked = rankArticlesV5(
      [
        {
          articleId: 'memory-only',
          opportunityCoverage: 90,
          topic: 'finance',
          level: 'B1',
          estimatedWordCount: 220,
        },
        {
          articleId: 'preferred',
          opportunityCoverage: 20,
          topic: 'environment',
          level: 'B1',
          estimatedWordCount: 220,
          goalTags: ['ielts'],
        },
      ],
      {
        userLevel: 'B1',
        goal: 'ielts',
        preferredTopics: ['environment'],
        recentTopics: ['technology'],
        targetWordCount: { min: 180, max: 320 },
      },
    );
    assert.equal(ranked[0]?.articleId, 'preferred');
    assert.equal(ranked[0]?.features.interest, 1);
    assert.equal(ranked[0]?.features.goal, 1);
  });

  await add('闭环：阅读 → 曝光 → 结算 → 下一篇覆盖高机会词', async () => {
    const lab = new MemoryLab();
    lab.installStore();

    await lab.expose({ wordId: 'abandon', articleId: 'day-0', at: lab.at(0) });
    await lab.expose({ wordId: 'maintain', articleId: 'day-0', at: lab.at(0), slot: 1 });

    for (let day = 1; day <= 3; day += 1) {
      await lab.expose({
        wordId: 'abandon',
        articleId: `forget-${day}`,
        at: lab.at(day, 13),
        clicked: true,
      });
      await lab.expose({
        wordId: 'maintain',
        articleId: `forget-${day}`,
        at: lab.at(day, 13),
        slot: 1,
      });
      await lab.finalizePast();
    }

    const abandon = await lab.proficiency('abandon');
    const maintain = await lab.proficiency('maintain');
    assert.ok((abandon?.opportunityScore ?? 0) >= 80, 'forgotten word should stay visible');
    assert.ok(maintain, 'successfully read word should still have a memory profile');
    assert.equal((await lab.state('abandon'))?.rme?.forcedExposure, true);

    const next = await rankMagazineLemmaCandidates(
      [
        candidate('cover-abandon', ['abandon', 'river'], { topic: 'environment' }),
        candidate('cover-maintain', ['maintain', 'river'], { topic: 'environment' }),
        candidate('unrelated', ['economy', 'market'], { topic: 'finance' }),
        candidate('already-read', ['abandon'], { topic: 'environment' }),
      ],
      {
        userLevel: 'B1',
        reviewWords: ['abandon'],
        excludeArticleIds: ['already-read', 'day-0', 'forget-1', 'forget-2', 'forget-3'],
        limit: 3,
        v5Profile: {
          userLevel: 'B1',
          goal: 'general',
          preferredTopics: ['environment'],
        },
      },
    );

    assert.equal(next[0]?.articleId, 'cover-abandon');
    assert.equal(next.map((row) => row.articleId).includes('already-read'), false);
    const stats = await lab.system.getProficiencyStats(
      USER_ID,
      new Date('2026-09-21T12:00:00.000Z'),
    );
    assert.ok(stats.total >= 2);
    assert.ok(stats.dueCount >= 1);
  });

  return results;
}

function memoryUnitTestFiles(): string[] {
  const dir = path.join(process.cwd(), 'tests');
  return fs
    .readdirSync(dir)
    .filter((name) =>
      /^(memory|fsrs|readingExposure|recommendationV5)/.test(name) && name.endsWith('.test.ts'),
    )
    .map((name) => path.join('tests', name))
    .sort();
}

function runUnitTests(files: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const child = spawn(process.execPath, [tsxCli, '--test', ...files], {
      stdio: jsonMode ? 'pipe' : 'inherit',
      cwd: process.cwd(),
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function printReport(results: CheckResult[]): void {
  const passed = results.filter((item) => item.ok).length;
  const failed = results.length - passed;
  if (jsonMode) {
    console.log(JSON.stringify({ passed, failed, results }, null, 2));
    return;
  }

  console.log('\nReading Memory Engine — acceptance harness\n');
  const width = Math.max(...results.map((item) => item.name.length));
  for (const item of results) {
    const status = item.ok ? 'PASS' : 'FAIL';
    const pad = ' '.repeat(width - item.name.length);
    console.log(`  ${status}  ${item.name}${pad}  ${item.ms}ms`);
    if (!item.ok && item.error) {
      for (const line of item.error.split('\n')) {
        console.log(`         ${line}`);
      }
    }
  }
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failed > 0) console.log(`${failed} failed`);
}

async function main(): Promise<void> {
  let results: CheckResult[] = [];
  try {
    results = await runScenarios();
  } finally {
    setDefaultMemoryStore(null);
  }

  printReport(results);
  const scenarioFailed = results.some((item) => !item.ok);
  if (scenarioFailed && !runUnit) process.exit(1);

  if (runUnit) {
    const files = memoryUnitTestFiles();
    if (!jsonMode) {
      console.log(`\nRunning ${files.length} memory unit test files...\n`);
    }
    const code = await runUnitTests(files);
    if (scenarioFailed || code !== 0) process.exit(1);
  }
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
