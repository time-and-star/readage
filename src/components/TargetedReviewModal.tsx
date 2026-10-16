import React, { useState } from 'react';
import { X, Volume2, CheckCircle2, RotateCcw, Award } from 'lucide-react';
import { ReviewWord } from '../types';
import { useSpeech } from '../lib/speech/useSpeech';
import { SpeechFeedback } from './SpeechControls';

interface TargetedReviewModalProps {
  reviewWords: ReviewWord[];
  onClose: () => void;
  onMasterWord: (wordId: string) => void;
  /** Preferred product path: open contextual article in P2 */
  onStartContextualReview?: () => void;
}

export const TargetedReviewModal: React.FC<TargetedReviewModalProps> = ({
  reviewWords,
  onClose,
  onMasterWord,
  onStartContextualReview,
}) => {
  const speech = useSpeech();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [completed, setCompleted] = useState(false);

  const currentWord = reviewWords[currentIndex];

  const handleNext = (mastered: boolean) => {
    speech.stop();
    if (currentWord && mastered) {
      onMasterWord(currentWord.id);
    }

    setIsFlipped(false);
    if (currentIndex + 1 < reviewWords.length) {
      setCurrentIndex((prev) => prev + 1);
    } else {
      setCompleted(true);
    }
  };

  const handleSpeak = (text: string) => {
    speech.speak(text);
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-fade-in">
      <SpeechFeedback state={speech.state} onStop={speech.stop} floating />
      <div className="bg-[#FAF8F3] border border-[#E0DBCF] w-full max-w-md rounded-2xl shadow-2xl p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 text-[#777] hover:bg-[#EFEAE0] rounded-full"
        >
          <X className="w-5 h-5" />
        </button>

        {!completed && currentWord ? (
          <div>
            <div className="flex items-center justify-between border-b border-[#E8E2D5] pb-3 mb-4">
              <span className="font-serif text-lg font-medium text-[#2A2621]">
                Quick Card Review
              </span>
              <span className="text-xs font-semibold text-[#8C8478] bg-[#EFECE3] px-2.5 py-1 rounded-full">
                {currentIndex + 1} of {reviewWords.length}
              </span>
            </div>

            {onStartContextualReview && (
              <button
                onClick={onStartContextualReview}
                className="app-primary-action w-full mb-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
              >
                推荐：进入语境复习文章（P2）
              </button>
            )}

            {/* Flashcard Box */}
            <div
              onClick={() => setIsFlipped(!isFlipped)}
              className="bg-white border-2 border-[#DCD5C7] hover:border-[#C35E37] rounded-2xl p-6 min-h-[300px] flex flex-col justify-between cursor-pointer transition-all shadow-md group relative overflow-hidden"
            >
              {/* Top Row: Word, Phonetic, Part of Speech, Audio */}
              <div className="space-y-2 text-left">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="font-serif text-3xl font-bold text-[#2A2621] tracking-tight">
                      {currentWord.word}
                    </h2>
                    <div className="flex items-center gap-2 mt-1">
                      {currentWord.phonetic && (
                        <span className="text-sm font-mono text-[#78716C] bg-[#F5F2EB] px-2 py-0.5 rounded border border-[#E7E2D7]">
                          {currentWord.phonetic}
                        </span>
                      )}
                      {currentWord.partOfSpeech && (
                        <span className="text-xs font-medium text-[#C35E37] bg-[#FDF2EE] border border-[#FADCD1] px-2 py-0.5 rounded-md">
                          {currentWord.partOfSpeech}
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSpeak(currentWord.word);
                    }}
                    className="p-2 text-[#78716C] hover:text-[#C35E37] hover:bg-[#F5F2EB] rounded-full transition-colors"
                    title="Pronounce"
                  >
                    <Volume2 className="w-5 h-5" />
                  </button>
                </div>

                {/* 汉译 (单词直译) */}
                {currentWord.chineseTranslation && (
                  <div className="mt-3 inline-block bg-[#FEF3C7] text-[#92400E] font-semibold text-sm px-3 py-1 rounded-lg border border-[#FDE68A]">
                    汉译：{currentWord.chineseTranslation}
                  </div>
                )}
              </div>

              {/* Middle Body: Flip or Detailed Explanation */}
              <div className="my-4 text-left space-y-3">
                {!isFlipped ? (
                  <div className="py-6 text-center border-t border-b border-[#F0EBE0]">
                    <p className="text-xs text-[#90877C] font-medium group-hover:text-[#C35E37] transition-colors">
                      点击卡片展开：英英释义、释义汉译与例句 ➔
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3 animate-fade-in text-left border-t border-[#F0EBE0] pt-3">
                    {/* 英英释义 */}
                    <div>
                      <span className="text-[11px] font-bold uppercase tracking-wider text-[#9C9388] block">
                        英英释义 (English Definition)
                      </span>
                      <p className="text-sm text-[#2C2723] font-medium mt-0.5 leading-relaxed">
                        {currentWord.definition}
                      </p>
                    </div>

                    {/* 英英释义的汉译 */}
                    {currentWord.definitionChinese && (
                      <div>
                        <span className="text-[11px] font-bold uppercase tracking-wider text-[#9C9388] block">
                          释义汉译 (Definition Chinese)
                        </span>
                        <p className="text-sm text-[#065F46] font-medium mt-0.5 bg-[#ECFDF5] px-2.5 py-1 rounded-md border border-[#A7F3D0]">
                          {currentWord.definitionChinese}
                        </p>
                      </div>
                    )}

                    {/* 例句 */}
                    {currentWord.exampleSentence && (
                      <div>
                        <span className="text-[11px] font-bold uppercase tracking-wider text-[#9C9388] block">
                          例句 (Example)
                        </span>
                        <p className="text-xs text-[#524B43] italic bg-[#F7F5EF] p-2.5 rounded-lg border border-[#EAE4D8] mt-0.5">
                          &quot;{currentWord.exampleSentence}&quot;
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Bottom Card Footer hint */}
              <div className="text-right">
                <span className="text-[10px] text-[#A8A095] uppercase font-semibold tracking-wider">
                  {isFlipped ? '点击收起' : '点击翻转卡片'}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="grid grid-cols-2 gap-3 mt-6">
              <button
                onClick={() => handleNext(false)}
                className="py-3 bg-[#EFECE3] hover:bg-[#E2DDD0] text-[#4A443C] font-medium rounded-xl text-sm transition-colors flex items-center justify-center gap-1.5"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Need Review</span>
              </button>
              <button
                onClick={() => handleNext(true)}
              className="app-primary-action py-3 font-medium rounded-xl text-sm transition-colors flex items-center justify-center gap-1.5 shadow-2xs"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Mastered!</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center py-8 space-y-4">
            <div className="w-16 h-16 bg-[#D2E7D6] text-[#27532F] rounded-full flex items-center justify-center mx-auto shadow-2xs">
              <Award className="w-8 h-8" />
            </div>
            <h3 className="font-serif text-2xl font-semibold text-[#2A2621]">
              Review Completed!
            </h3>
            <p className="text-sm text-[#666056] max-w-xs mx-auto">
              Great job! You have reviewed all ready words for today.
            </p>
            <button
              onClick={onClose}
              className="app-primary-action mt-4 px-6 py-3 rounded-xl font-medium text-sm transition-colors shadow-xs"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
