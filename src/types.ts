export type ArticleSource =
  | 'user_input'
  | 'library'
  | 'ai_generated'
  | 'oral_session'
  | 'magazine'
  /** LLM rewrite of an existing article at a target CEFR level. */
  | 'level_rewrite';
export type ArticleStatus = 'Completed' | 'In Progress';
export type ReadingMode = 'single' | 'recommendation-feed';
export type ReadingAdvanceReason = 'completed' | 'skipped';

export interface ReadingAdvancePayload {
  articleId: string;
  reason: ReadingAdvanceReason;
  exposedLemmas: string[];
}
export type ProficiencyLevel = 0 | 1 | 2 | 3 | 4;

export type MagazineSourceId = 'economist' | 'new_yorker' | 'atlantic' | 'wired' | string;
export type MagazineIssueStatus = 'ready' | 'parsing' | 'failed' | 'partial';
export type MagazineFormat = 'epub' | 'pdf' | 'html';
export type MagazineSourceProvider = 'github' | 'news_in_levels';

export interface MagazineSourceMeta {
  id: MagazineSourceId;
  /** GitHub directory for the default provider. */
  repoDir?: string;
  /** Fixed source page for non-GitHub providers. */
  sourceUrl?: string;
  provider?: MagazineSourceProvider;
  displayName: string;
  levelHint?: string;
  topic?: string;
}

export interface MagazineIssue {
  id: string;
  sourceId: MagazineSourceId;
  issueLabel: string;
  title: string;
  publishedAt?: string;
  importedAt: string;
  format: MagazineFormat;
  remotePath: string;
  remoteSha?: string;
  articleCount: number;
  status: MagazineIssueStatus;
  errorMessage?: string;
}

export interface MagazineArticleStub {
  id: string;
  title: string;
  description: string;
  wordCount?: number;
}

/** Compact article metadata for cross-magazine catalog browsing. */
export interface MagazineCatalogArticleStub extends MagazineArticleStub {
  level: string;
  sourceId: MagazineSourceId;
  sourceName: string;
  issueId: string;
  issueLabel: string;
  date: string;
}

export interface MagazineSourceSummary {
  id: MagazineSourceId;
  displayName: string;
  levelHint?: string;
  topic?: string;
  issueCount: number;
}

export interface MagazineCatalogIndex {
  lastSyncAt: string | null;
  sources: MagazineSourceSummary[];
  issues: MagazineIssue[];
}

export interface MagazineSyncStatus {
  running: boolean;
  lastRunAt: string | null;
  lastResult: MagazineSyncResult | null;
  progress: string | null;
}

export interface MagazineSyncResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  importedIssues: number;
  skippedIssues: number;
  failedIssues: number;
  errors: string[];
  perSource: Record<string, { imported: number; skipped: number; failed: number }>;
}

export type LearningEventType =
  | 'click'
  | 'exposure'
  | 'grammar_query'
  | 'discussion'
  | 'review_start'
  | 'add_review'
  | 'incorrect_use'
  | 'avoidance'
  | 'article_open'
  | 'article_complete'
  | 'weak_point';

/** AI CEFR rating produced on article import. */
export interface ArticleLevelRating {
  /** CEFR band: A1 | A2 | B1 | B2 | C1 | C2 */
  level: string;
  /** 0–100 objective difficulty. */
  difficultyScore: number;
  /** Short Chinese rationale for learners. */
  summary: string;
  vocabularyNotes?: string;
  structureNotes?: string;
  estimatedWordCount?: number;
}

export interface Article {
  id: string;
  title: string;
  description: string;
  date: string;
  status: ArticleStatus;
  content: string[];
  keyWords?: string[];
  source?: ArticleSource;
  level?: string;
  topic?: string;
  lastOpenedAt?: string;
  /** Time when every paragraph first satisfied the active-reading visibility rule. */
  completedAt?: string;
  /** Words intentionally woven in for due review (AI-generated / targeted review). */
  embeddedReviewWords?: string[];
  magazineIssueId?: string;
  magazineSourceId?: MagazineSourceId;
  /**
   * Chinese translation per paragraph, aligned with `content` indices.
   * Filled by the import module in the background after store.
   */
  paragraphTranslations?: string[];
  /** Full-article CEFR rating from the import module. */
  levelRating?: ArticleLevelRating;
  /**
   * Import module lifecycle (translate + rate).
   * pending/processing: stored but enrichment not ready yet.
   */
  importEnrichmentStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  importEnrichmentError?: string;
  /** If this article was rewritten from another, the original article id. */
  parentArticleId?: string;
  /** CEFR level the user requested when generating a level_rewrite version. */
  rewriteTargetLevel?: string;
  /** Optional title of the parent article for UI ("改写自…"). */
  parentArticleTitle?: string;
  /** Hidden provenance for catalog-generated articles; intentionally not shown as a rewrite banner. */
  generatedFromArticleId?: string;
  generatedFromArticleTitle?: string;
  generationKind?: string;
  generationProvider?: string;
  generationModel?: string;
  generatedAt?: string;
}

export interface ReviewWord {
  id: string;
  word: string;
  phonetic: string;
  partOfSpeech?: string;
  definition: string;
  definitionChinese?: string;
  chineseTranslation?: string;
  exampleSentence: string;
  mastered: boolean;
  nextReviewDate: string;
}

/** Stability is measured in days; nextReviewDue is an ISO timestamp. */
export interface FsrsCardState {
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview?: string;
}

export interface FsrsReviewLog {
  rating: number;
  state: number;
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  lastElapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  review: string;
}

export interface FsrsMemory {
  version: 2;
  algorithm: 'FSRS-6';
  implementation: 'ts-fsrs@5.4.1';
  /** Fingerprint of all scheduler parameters, including the FSRS weights. */
  parametersId: string;
  /** Reviews known only as a migration baseline, before complete logs began. */
  historyStartReps: number;
  card: FsrsCardState;
  /** Complete immutable history after historyStartReps. */
  reviews: FsrsReviewLog[];
  /** Whether the word has entered the review system (not merely been seen). */
  isIntroduced: boolean;
  lastRating?: number;
}

export interface WordProficiency {
  lemma: string;
  level: ProficiencyLevel;
  recognitionScore: number;
  productionScore: number;
  stabilityDays: number;
  lastReviewedAt: string;
  nextReviewDue: string;
  phonetic?: string;
  partOfSpeech?: string;
  definition?: string;
  definitionChinese?: string;
  chineseTranslation?: string;
  exampleSentence?: string;
  exposureCount: number;
  /** Canonical FSRS-6 memory state; older records are migrated lazily. */
  fsrs?: FsrsMemory;
}

export interface LearningEvent {
  id: string;
  type: LearningEventType;
  articleId?: string;
  lemma?: string;
  createdAt: string;
  /** Captured local date for learning outside the current timezone. */
  localDate?: string;
  detail?: string;
}

export interface GrammarExplanation {
  wordOrPhrase: string;
  type: string;
  phonetic?: string;
  definition: string;
  definitionChinese?: string;
  chineseTranslation?: string;
  grammarRules: string[];
  exampleSentences: string[];
  vietnameseMeaning?: string;
  /** Origin of the explanation: local offline ECDICT or LLM. */
  source?: 'dictionary' | 'ai';
  /** CEFR band from the local dictionary (A1–C2). */
  cefrLevel?: string;
  /** Curriculum/exam tags from ECDICT (中考/高考/CET4…). */
  tags?: string[];
  /** Multi-sense bilingual definitions from the dictionary. */
  senses?: Array<{ partOfSpeech: string; definition: string; definitionZh?: string }>;
  /** Inflections/word forms (过去式 ran, 复数 runs…). */
  exchanges?: Array<{ label: string; value: string }>;
  /** Common collocations with Chinese glosses. */
  collocations?: Array<{ en: string; zh: string }>;
  /** Words in the same family (strong derivations first). */
  relatedWords?: string[];
}

export interface TranslationResult {
  originalText: string;
  translatedText: string;
  targetLanguage: string;
  culturalNote?: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
}

export interface AssessmentError {
  type: string;
  span: string;
  fix: string;
}

export interface StructuredAssessResult {
  reply: string;
  errors: AssessmentError[];
  wordsUsedCorrectly: string[];
  wordsUsedIncorrectly: string[];
  weakPoints: string[];
  scoreOutOf10?: number;
}

export interface ArticleSession {
  articleId: string;
  chatMessages: ChatMessage[];
  clickCount: number;
  discussionCount: number;
  lastOpenedAt: string;
}

export interface WeakPointMetric {
  skill: string;
  issueCount: number;
  severity: number;
  lastSeenAt?: string;
}

export interface ArticleProgressRow {
  article: Article;
  clickCount: number;
  discussionCount: number;
  hasSession: boolean;
}

export interface LearningSignals {
  incorrectWords: string[];
  grammarIssues: string[];
  usedTargetWords: string[];
}

export type TutorIntent =
  | 'explain'
  | 'translate'
  | 'translate_article'
  | 'recommend_article'
  | 'rewrite_article'
  | 'rate_article'
  | 'discuss';

/** Full-article translate: one Chinese string per English paragraph (same length). */
export interface ArticleTranslationResult {
  translations: string[];
}

export interface TutorRequest {
  intent: TutorIntent;
  articleId?: string;
  articleContext?: string;
  message?: string;
  selectedText?: string;
  contextSentence?: string;
  targetLanguage?: string;
  topic?: string;
  reviewWords?: string[];
  level?: string;
  history?: ChatMessage[];
  /** 1-based paragraph index when translating one paragraph during import. */
  paragraphIndex?: number;
  /** Total paragraphs when translating one paragraph during import. */
  paragraphTotal?: number;
  /**
   * Ordered English paragraphs for intent `translate_article`.
   * Model must return the same number of Chinese translations.
   */
  paragraphs?: string[];
}

export interface TutorSuccessResponse<T> {
  ok: true;
  intent: TutorIntent;
  result: T;
  learningSignals?: LearningSignals;
  validation?: {
    wordCount: number;
    newWordDensity: number;
  };
}

export interface TutorErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type TutorResponse<T> = TutorSuccessResponse<T> | TutorErrorResponse;

export interface UserProfile {
  userId: string;
  level: string;
  weakPoints: string[];
  streakDays: number;
}
