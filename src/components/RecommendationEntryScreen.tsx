import React from 'react';
import { Library, RefreshCw, Sparkles } from 'lucide-react';
import { AppPageHeader } from './AppPageHeader';
import { ReadAgeLogo } from './ReadAgeBrand';

interface RecommendationEntryScreenProps {
  isLoading: boolean;
  phase: 'local' | 'ai' | null;
  feedEnded: boolean;
  onStartRecommendation: () => void;
  onOpenLibrary: () => void;
  onBack: () => void;
  navigation: React.ReactNode;
}

export const RecommendationEntryScreen: React.FC<RecommendationEntryScreenProps> = ({
  isLoading,
  phase,
  feedEnded,
  onStartRecommendation,
  onOpenLibrary,
  onBack,
  navigation,
}) => {
  const message = isLoading
    ? phase === 'ai'
      ? 'Generating a personalized article...'
      : 'Finding a good next article for you...'
    : feedEnded
      ? 'No unread recommendation is available right now.'
      : 'Your next reading session starts here.';

  return (
    <>
      <AppPageHeader onBack={onBack} navigation={navigation} />
      <main className="min-h-[calc(100dvh-4rem)] bg-[#F8F6F0] px-4 py-8 text-[#2B2723] sm:px-6 sm:py-12 safe-pb">
      <div className="mx-auto flex min-h-[min(58vh,520px)] w-full max-w-2xl items-center justify-center">
        <section
          className="w-full border border-[#E3DDD1] bg-[#FAF8F3] px-5 py-8 text-center shadow-sm sm:px-10 sm:py-10"
          aria-busy={isLoading}
          aria-live="polite"
        >
          {isLoading ? (
            <div className="recommendation-loading-visual" aria-hidden="true">
              <div className="recommendation-loading-orbit">
                <span />
                <span />
                <ReadAgeLogo className="h-12 w-12" />
              </div>
              <div className="recommendation-loading-lines">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : (
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#F3E4DA] text-[#C35E37]">
              <Sparkles className="h-7 w-7" aria-hidden="true" />
            </div>
          )}
          <h1 className="mt-5 font-serif text-[1.75rem] font-normal leading-tight text-[#2A2622] sm:text-4xl">
            Recommended Reading
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#777066]">
            {message}
          </p>

          {!isLoading && (
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
              <button
                type="button"
                onClick={onStartRecommendation}
                className="app-primary-action inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-colors sm:w-auto sm:min-h-0 sm:py-2.5"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Start recommendation
              </button>
              <button
                type="button"
                onClick={onOpenLibrary}
                className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-[#DCD5C7] bg-white px-4 py-3 text-sm font-medium text-[#332E28] transition-colors hover:bg-[#F2ECE0] active:bg-[#EFEAE0] sm:w-auto sm:min-h-0 sm:py-2.5"
              >
                <Library className="h-4 w-4" aria-hidden="true" />
                Browse library
              </button>
            </div>
          )}
        </section>
      </div>
      </main>
    </>
  );
};
