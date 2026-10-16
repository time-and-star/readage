import type {
  Article,
  ArticleSession,
  LearningEvent,
  WeakPointMetric,
} from '../types';

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string | Date | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function toLocalDateKey(value: string | Date): string {
  const date = validDate(value);
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromKey(key: string): Date | null {
  if (!DATE_KEY_PATTERN.test(key)) return null;
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    ? date
    : null;
}


export function normalizeLearningDateKeys(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.filter(
    (candidate): candidate is string => typeof candidate === 'string' && Boolean(dateFromKey(candidate)),
  ))].sort();
}

export function calculateLearningStreak(dateKeys: string[], now = new Date()): number {
  const uniqueDays = new Set(dateKeys.filter((key) => dateFromKey(key)));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  let cursor: Date;
  if (uniqueDays.has(toLocalDateKey(today))) cursor = today;
  else if (uniqueDays.has(toLocalDateKey(yesterday))) cursor = yesterday;
  else return 0;

  let streak = 0;
  while (uniqueDays.has(toLocalDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function countRecentLearningEvents(
  events: LearningEvent[],
  now = new Date(),
  calendarDays = 7,
): number {
  if (!Number.isFinite(calendarDays) || calendarDays <= 0) return 0;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.floor(calendarDays) + 1);
  const endTime = now.getTime();
  return events.reduce((count, learningEvent) => {
    if (learningEvent.type === 'weak_point') return count;
    const createdAt = validDate(learningEvent.createdAt);
    if (!createdAt) return count;
    const time = createdAt.getTime();
    return time >= start.getTime() && time <= endTime ? count + 1 : count;
  }, 0);
}

function normalizeWeakPoint(value: string | undefined): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function buildWeakPointMetrics(
  events: LearningEvent[],
  fallbackWeakPoints: string[] = [],
): WeakPointMetric[] {
  const grouped = new Map<string, { issueCount: number; lastSeenAt?: string }>();

  for (const learningEvent of events) {
    if (learningEvent.type !== 'weak_point') continue;
    const skill = normalizeWeakPoint(learningEvent.detail || learningEvent.lemma);
    if (!skill) continue;
    const previous = grouped.get(skill);
    const eventDate = validDate(learningEvent.createdAt)?.toISOString();
    grouped.set(skill, {
      issueCount: (previous?.issueCount || 0) + 1,
      lastSeenAt: !previous?.lastSeenAt || (eventDate && eventDate > previous.lastSeenAt)
        ? eventDate
        : previous.lastSeenAt,
    });
  }

  for (const fallback of fallbackWeakPoints) {
    const skill = normalizeWeakPoint(fallback);
    if (skill && !grouped.has(skill)) grouped.set(skill, { issueCount: 1 });
  }

  return [...grouped.entries()]
    .map(([skill, value]) => ({
      skill,
      issueCount: value.issueCount,
      severity: Math.min(100, 25 + value.issueCount * 20),
      lastSeenAt: value.lastSeenAt,
    }))
    .sort((a, b) => (
      b.issueCount - a.issueCount
      || (b.lastSeenAt || '').localeCompare(a.lastSeenAt || '')
      || a.skill.localeCompare(b.skill)
    ));
}

export function countCompletedArticles(articles: Article[]): number {
  return articles.filter((article) => article.status === 'Completed').length;
}

export function getLearningActivityDateKeys(
  persistedDateKeys: string[],
  events: LearningEvent[],
  sessions: Record<string, ArticleSession>,
  articles: Article[],
): string[] {
  const keys = new Set(persistedDateKeys.filter((key) => dateFromKey(key)));
  const addDate = (value?: string) => {
    const key = value ? toLocalDateKey(value) : '';
    if (key) keys.add(key);
  };

  events.forEach((learningEvent) => {
    if (learningEvent.localDate && dateFromKey(learningEvent.localDate)) keys.add(learningEvent.localDate);
    else addDate(learningEvent.createdAt);
  });
  Object.values(sessions).forEach((session) => addDate(session.lastOpenedAt));
  articles.forEach((article) => {
    addDate(article.lastOpenedAt);
    addDate(article.completedAt);
  });

  return [...keys].sort();
}
