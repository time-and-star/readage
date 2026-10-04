import type { ReadingAgentDecision, TutorRequest } from '../types';
import type { ReadingVerificationQuestion } from './readingVerificationQuestions';
import { validateGeneratedReadingVerificationQuestion } from './readingVerificationValidation';

export interface AfterReadingResult {
  decision: ReadingAgentDecision;
  question: ReadingVerificationQuestion | null;
}

const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reading agent response.');
  return value as Record<string, unknown>;
}

export function validateReadingAgentDecision(raw: unknown, request: TutorRequest): ReadingAgentDecision {
  const value = object(raw);
  if (typeof value.reasonZh !== 'string' || !/[\u3400-\u9fff]/.test(value.reasonZh)
    || value.reasonZh.length > 300 || /[<>\u0000-\u001f]/.test(value.reasonZh)) throw new Error('Invalid agent reason.');
  const reasonZh = value.reasonZh.trim();
  if (value.action === 'skip') return { action: 'skip', reasonZh };
  if (value.action !== 'ask' || typeof value.wordId !== 'string') throw new Error('Invalid agent action.');
  const word = request.learnerWords?.find(row => row.wordId === value.wordId);
  if (!word) throw new Error('Agent selected an unknown learning word.');
  if (value.purpose === 'delayed_verification') {
    if (!word.eligibleDelayed) throw new Error('Agent bypassed delayed eligibility.');
  } else if (value.purpose === 'immediate_practice') {
    if (!request.allowImmediatePractice || !word.inArticle) throw new Error('Agent selected an unavailable practice word.');
  } else throw new Error('Invalid agent question purpose.');
  const level = typeof value.level === 'string' ? value.level : request.level || 'B1';
  if (!levels.includes(level) || levels.indexOf(level) > levels.indexOf(request.level || 'B1')) {
    throw new Error('Agent selected an unsuitable surrounding-language level.');
  }
  return { action: 'ask', wordId: word.wordId, purpose: value.purpose, level, reasonZh };
}

export function validateAfterReadingResult(raw: unknown, request: TutorRequest,
  excludedContextTexts: readonly string[] = [], excludedQuestionIds: readonly string[] = []): AfterReadingResult {
  const value = object(raw);
  const decision = validateReadingAgentDecision(value.decision, request);
  if (decision.action === 'skip') {
    if (value.question != null) throw new Error('A skipped agent decision cannot carry a question.');
    return { decision, question: null };
  }
  const question = validateGeneratedReadingVerificationQuestion(value.question, {
    wordIds: [decision.wordId!], excludedContextTexts, excludedQuestionIds,
  });
  return { decision, question: { ...question, purpose: decision.purpose } };
}
