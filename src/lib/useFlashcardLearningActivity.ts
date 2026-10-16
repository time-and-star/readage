import { useEffect, useState } from 'react';
import type { LearningEvent } from '../types';
import { useMemorySystem } from './memoryV2/hooks';

/** Activity comes from the durable review journal, including recovered writes. */
export function useFlashcardLearningActivity() {
  const { memorySystem, userId, ready, activityVersion } = useMemorySystem();
  const [events, setEvents] = useState<LearningEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (ready) void memorySystem.getFlashcardReviewHistory(userId).then(attempts => {
      if (!active) return;
      setEvents(attempts.map(attempt => ({
        id: `flashcard:${attempt.attemptId}`,
        type: 'flashcard_review' as const,
        lemma: attempt.wordId,
        createdAt: attempt.occurredAt,
        localDate: attempt.localDate,
      })));
      setError(null);
    }).catch(() => {
      if (active) setError('词卡学习统计暂未加载，重新连接后会自动恢复。');
    });
    return () => { active = false; };
  }, [memorySystem, userId, ready, activityVersion]);

  return { events, error };
}
