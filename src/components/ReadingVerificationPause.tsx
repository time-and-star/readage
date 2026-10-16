import React, { useRef } from 'react';
import { useReadingVerification } from '../lib/useReadingVerification';
import { ReadingVerificationCard } from './ReadingVerificationCard';

interface ReadingVerificationPauseProps {
  articleId: string;
  excludedContextTexts: readonly string[];
  level?: string;
  articleTitle?: string;
  readingComplete: boolean;
  onActiveChange: (articleId: string, active: boolean) => void;
}

export const ReadingVerificationPause: React.FC<ReadingVerificationPauseProps> = ({ articleId, excludedContextTexts,
  level, articleTitle, readingComplete, onActiveChange }) => {
  const wasActive = useRef(false);
  const { cancelRequest, ...verification } = useReadingVerification(articleId, excludedContextTexts, level,
    articleTitle, readingComplete);
  return <ReadingVerificationCard {...verification}
    onActiveChange={active => {
      if (!active && wasActive.current) cancelRequest();
      wasActive.current = active;
      onActiveChange(articleId, active);
    }} />;
};
