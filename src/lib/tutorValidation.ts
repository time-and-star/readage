import type { ChatMessage, TutorIntent, TutorRequest } from '../types';

import { MAX_READING_AGENT_WORDS, MAX_READING_AGENT_ARTICLE_CHARS } from './afterReadingContext';

const INTENTS = new Set<TutorIntent>([
  'explain',
  'translate',
  'translate_article',
  'recommend_article',
  'rewrite_article',
  'rate_article',
  'reading_verification',
  'after_reading',
  'discuss',
]);

/** Max paragraphs for a single full-article translate call. */
export const MAX_TRANSLATE_ARTICLE_PARAGRAPHS = 400;
/** Max total characters across all paragraphs in one translate_article call. */
export const MAX_TRANSLATE_ARTICLE_CHARS = 120_000;

export const MAX_VERIFICATION_WORDS = 5;
export const MAX_VERIFICATION_CONTEXTS = 12;
export const MAX_VERIFICATION_CONTEXT_CHARS = 500;
export const MAX_VERIFICATION_TOTAL_CONTEXT_CHARS = 6_000;

const VERIFICATION_FIELDS = new Set(['intent', 'articleId', 'reviewWords', 'verificationContexts', 'level']);
const CEFR_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const ENGLISH_LEARNING_UNIT = /^[a-z]+(?:['’][a-z]+)*(?:[- ][a-z]+(?:['’][a-z]+)*)*$/i;
// Reject common directives while preserving ordinary words and phrasal verbs
// such as "ignore", "give up", "write off", and "run out of".
const INSTRUCTION_LIKE_UNIT = new RegExp([
  /^(?:ignore|disregard|override|forget)\b.*\b(?:instructions?|prompts?|rules?|messages?)\b/.source,
  /^(?:you are|act as|tell me|please)\b/.source,
  /\b(?:system|developer|assistant)\s+(?:prompts?|messages?|instructions?)\b/.source,
  /^(?:write|generate|create|compose)\s+(?:(?:a|an|the|some)\s+)?(?:poem|story|code|json|answer|response|prompt|instructions?)\b/.source,
  /^(?:return|print|output|reveal)\s+(?:only\s+)?(?:the\s+)?(?:answers?|json|keys?|secrets?|prompts?)\b/.source,
  /^(?:execute|run)\s+(?:the\s+)?(?:system\s+)?(?:code|commands?|scripts?|shell|powershell|javascript|python)\b/.source,
].join('|'), 'i');

const STRING_LIMITS: Partial<Record<keyof TutorRequest, number>> = {
  articleId: 200,
  /** Full article for CEFR rating; sized for ~10k English words (万字, up to ~120k chars). */
  articleContext: 120_000,
  /** Paragraph body for import translation (one paragraph per call). */
  message: 6_000,
  selectedText: 2_000,
  contextSentence: 3_000,
  targetLanguage: 50,
  topic: 500,
  level: 20,
};

export type TutorRequestValidation =
  | { ok: true; value: TutorRequest }
  | { ok: false; code: string; message: string };

function fail(message: string): Extract<TutorRequestValidation, { ok: false }> {
  return { ok: false, code: 'INVALID_REQUEST', message };
}

function validateReadingVerification(body: Record<string, unknown>): TutorRequestValidation {
  if (Object.keys(body).some(field => !VERIFICATION_FIELDS.has(field))) return fail('reading_verification contains an unsupported field.');
  if (!Array.isArray(body.reviewWords) || body.reviewWords.length < 1 || body.reviewWords.length > MAX_VERIFICATION_WORDS) {
    return fail(`reading_verification requires 1–${MAX_VERIFICATION_WORDS} review words.`);
  }
  const reviewWords: string[] = [];
  for (const candidate of body.reviewWords) {
    if (typeof candidate !== 'string' || candidate.length > 80) return fail('Each review word must be an English word or phrase of at most 80 characters.');
    const word = candidate.trim();
    if (!word || !ENGLISH_LEARNING_UNIT.test(word) || INSTRUCTION_LIKE_UNIT.test(word)) {
      return fail('reviewWords must contain non-empty English words or phrases, not numbers or instructions.');
    }
    reviewWords.push(word);
  }
  const value: TutorRequest = { intent: 'reading_verification', reviewWords };
  if (body.articleId !== undefined) {
    if (typeof body.articleId !== 'string' || body.articleId.length > 200 || !body.articleId.trim()) return fail('articleId must be a non-empty string of at most 200 characters.');
    value.articleId = body.articleId.trim();
  }
  if (body.level !== undefined) {
    if (typeof body.level !== 'string' || !CEFR_LEVELS.has(body.level.trim())) return fail('level must be one of A1, A2, B1, B2, C1, C2.');
    value.level = body.level.trim();
  }
  if (body.verificationContexts !== undefined) {
    if (!Array.isArray(body.verificationContexts) || body.verificationContexts.length > MAX_VERIFICATION_CONTEXTS) {
      return fail(`verificationContexts must be an array of at most ${MAX_VERIFICATION_CONTEXTS} strings.`);
    }
    let total = 0;
    const contexts: string[] = [];
    for (const context of body.verificationContexts) {
      if (typeof context !== 'string' || context.length > MAX_VERIFICATION_CONTEXT_CHARS) {
        return fail(`Each verification context must be a string of at most ${MAX_VERIFICATION_CONTEXT_CHARS} characters.`);
      }
      total += context.length;
      if (total > MAX_VERIFICATION_TOTAL_CONTEXT_CHARS) return fail(`verificationContexts exceeds ${MAX_VERIFICATION_TOTAL_CONTEXT_CHARS} total characters.`);
      contexts.push(context.trim());
    }
    value.verificationContexts = contexts;
  }
  return { ok: true, value };
}

function validateAfterReading(body: Record<string, unknown>): TutorRequestValidation {
  const fields = new Set(['intent', 'articleId', 'articleTitle', 'articleContext', 'learnerWords',
    'learningSummary', 'allowImmediatePractice', 'level', 'verificationContexts']);
  if (Object.keys(body).some(field => !fields.has(field))) return fail('after_reading contains an unsupported field.');
  if (typeof body.articleId !== 'string' || !body.articleId.trim() || body.articleId.length > 200
    || typeof body.articleContext !== 'string' || !body.articleContext.trim()
    || body.articleContext.length > MAX_READING_AGENT_ARTICLE_CHARS) return fail('after_reading requires a complete bounded article and articleId.');
  if (body.articleTitle !== undefined && (typeof body.articleTitle !== 'string' || body.articleTitle.length > 240)) return fail('Invalid articleTitle.');
  if (body.allowImmediatePractice !== undefined && typeof body.allowImmediatePractice !== 'boolean') return fail('Invalid practice permission.');
  const common = validateReadingVerification({ intent: 'reading_verification', reviewWords: ['word'],
    ...(body.level !== undefined ? { level: body.level } : {}),
    ...(body.verificationContexts !== undefined ? { verificationContexts: body.verificationContexts } : {}) });
  if (!common.ok) return common;
  if (!Array.isArray(body.learnerWords) || body.learnerWords.length > MAX_READING_AGENT_WORDS) return fail('Invalid bounded learnerWords.');
  const wordFields = new Set(['wordId', 'inArticle', 'eligibleDelayed', 'memoryScore', 'confidence',
    'exposureCount', 'reviewCount', 'lastSeenAt', 'lastAssistedAt', 'lastReviewAt', 'lastOutcome', 'lastOutcomePurpose', 'recentContext']);
  const outcomes = new Set(['recognized', 'incorrect', 'uncertain', 'guessed', 'skipped']);
  const learnerWords: NonNullable<TutorRequest['learnerWords']> = [];
  for (const input of body.learnerWords) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Invalid learner word.');
    const row = input as Record<string, unknown>;
    if (Object.keys(row).some(field => !wordFields.has(field))
      || typeof row.wordId !== 'string' || row.wordId.length > 80 || !ENGLISH_LEARNING_UNIT.test(row.wordId)
      || INSTRUCTION_LIKE_UNIT.test(row.wordId) || row.wordId !== row.wordId.trim().toLowerCase()
      || typeof row.inArticle !== 'boolean' || typeof row.eligibleDelayed !== 'boolean') return fail('Invalid learner word identity or flags.');
    for (const field of ['memoryScore', 'confidence']) {
      if (row[field] !== null && (typeof row[field] !== 'number' || !Number.isFinite(row[field])
        || Number(row[field]) < 0 || Number(row[field]) > 100)) return fail('Invalid learner score.');
    }
    for (const field of ['exposureCount', 'reviewCount']) {
      if (!Number.isInteger(row[field]) || Number(row[field]) < 0 || Number(row[field]) > 1_000_000) return fail('Invalid learner evidence count.');
    }
    for (const field of ['lastSeenAt', 'lastAssistedAt', 'lastReviewAt']) {
      if (row[field] !== null && (typeof row[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(String(row[field]))
        || String(row[field]).length > 40 || !Number.isFinite(Date.parse(String(row[field]))))) return fail('Invalid learner evidence time.');
    }
    if (row.lastOutcome !== undefined && !outcomes.has(String(row.lastOutcome))) return fail('Invalid learner outcome.');
    if (row.lastOutcomePurpose !== undefined && !['delayed_verification', 'immediate_practice'].includes(String(row.lastOutcomePurpose))) return fail('Invalid learner outcome purpose.');
    if (row.recentContext !== undefined && (typeof row.recentContext !== 'string' || row.recentContext.length > 500)) return fail('Invalid learner context.');
    learnerWords.push(row as unknown as NonNullable<TutorRequest['learnerWords']>[number]);
  }
  if (new Set(learnerWords.map(row => row.wordId)).size !== learnerWords.length) return fail('Duplicate learner words.');
  const summary = body.learningSummary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return fail('Invalid learning summary.');
  const summaryFields = ['trackedWordCount', 'articleWordCount', 'eligibleDelayedCount'];
  if (Object.keys(summary).some(field => !summaryFields.includes(field))
    || summaryFields.some(field => !Number.isInteger((summary as Record<string, unknown>)[field])
      || Number((summary as Record<string, unknown>)[field]) < 0
      || Number((summary as Record<string, unknown>)[field]) > 1_000_000)) return fail('Invalid learning summary counts.');
  return { ok: true, value: { intent: 'after_reading', articleId: body.articleId.trim(),
    articleContext: body.articleContext, articleTitle: body.articleTitle as string | undefined,
    learnerWords, learningSummary: summary as TutorRequest['learningSummary'],
    allowImmediatePractice: body.allowImmediatePractice === true,
    level: common.value.level, verificationContexts: common.value.verificationContexts } };
}

export function validateTutorRequest(input: unknown): TutorRequestValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Request body must be a JSON object.');
  const body = input as Record<string, unknown>;
  if (typeof body.intent !== 'string' || !INTENTS.has(body.intent as TutorIntent)) {
    return fail('Unknown tutor intent.');
  }

  if (body.intent === 'reading_verification') return validateReadingVerification(body);
  if (body.intent === 'after_reading') return validateAfterReading(body);

  const value: TutorRequest = { intent: body.intent as TutorIntent };
  for (const [field, limit] of Object.entries(STRING_LIMITS) as Array<
    [keyof TutorRequest, number]
  >) {
    const candidate = body[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string') return fail(`${String(field)} must be a string.`);
    if (candidate.length > limit) return fail(`${String(field)} exceeds ${limit} characters.`);
    (value as unknown as Record<string, unknown>)[field] = candidate;
  }

  if (body.reviewWords !== undefined) {
    if (!Array.isArray(body.reviewWords)) return fail('reviewWords must be an array.');
    const reviewWords = body.reviewWords.slice(0, 20);
    if (reviewWords.some((word) => typeof word !== 'string' || word.length > 80)) {
      return fail('Each review word must be a string of at most 80 characters.');
    }
    value.reviewWords = reviewWords as string[];
  }

  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) return fail('history must be an array.');
    const history = body.history.slice(-12);
    if (
      history.some(
        (message) =>
          !message ||
          typeof message !== 'object' ||
          !['user', 'ai'].includes(String((message as ChatMessage).sender)) ||
          typeof (message as ChatMessage).text !== 'string' ||
          (message as ChatMessage).text.length > 2_000
      )
    ) {
      return fail('history contains an invalid message.');
    }
    value.history = history.map((message, index) => {
      const item = message as Partial<ChatMessage>;
      return {
        id: typeof item.id === 'string' ? item.id : `history-${index}`,
        sender: item.sender as 'user' | 'ai',
        text: item.text as string,
        timestamp: typeof item.timestamp === 'string' ? item.timestamp : '',
      };
    });
  }

  if (body.paragraphIndex !== undefined) {
    if (typeof body.paragraphIndex !== 'number' || !Number.isInteger(body.paragraphIndex) || body.paragraphIndex < 1) {
      return fail('paragraphIndex must be a positive integer.');
    }
    value.paragraphIndex = body.paragraphIndex;
  }

  if (body.paragraphTotal !== undefined) {
    if (typeof body.paragraphTotal !== 'number' || !Number.isInteger(body.paragraphTotal) || body.paragraphTotal < 1) {
      return fail('paragraphTotal must be a positive integer.');
    }
    value.paragraphTotal = body.paragraphTotal;
  }

  if (body.paragraphs !== undefined) {
    if (!Array.isArray(body.paragraphs)) return fail('paragraphs must be an array.');
    if (body.paragraphs.length === 0) return fail('paragraphs must not be empty.');
    if (body.paragraphs.length > MAX_TRANSLATE_ARTICLE_PARAGRAPHS) {
      return fail(`paragraphs exceeds ${MAX_TRANSLATE_ARTICLE_PARAGRAPHS} items.`);
    }
    if (body.paragraphs.some((p) => typeof p !== 'string')) {
      return fail('Each paragraph must be a string.');
    }
    const paragraphs = (body.paragraphs as string[]).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) return fail('paragraphs must contain non-empty strings.');
    const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);
    if (totalChars > MAX_TRANSLATE_ARTICLE_CHARS) {
      return fail(`paragraphs total characters exceed ${MAX_TRANSLATE_ARTICLE_CHARS}.`);
    }
    value.paragraphs = paragraphs;
    value.paragraphTotal = paragraphs.length;
  }

  return { ok: true, value };
}

