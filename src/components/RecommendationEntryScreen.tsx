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
      <main className="recommendation-entry min-h-[calc(100dvh-4rem)] bg-[#F8F6F0] px-4 py-10 text-[#2B2723] sm:px-6 sm:py-16 safe-pb">
      <div className="mx-auto flex min-h-[min(66vh,600px)] w-full max-w-2xl items-center justify-center">
        <section
          className="recommendation-entry__card w-full border border-[#E3DDD1] bg-[#FFFDFA] px-6 py-10 text-center sm:px-12 sm:py-14"
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
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-[#EBD4C6] bg-[#F8EDE5] text-[#A94E2B]">
              <Sparkles className="h-7 w-7" strokeWidth={1.5} aria-hidden="true" />
            </div>
          )}
          <p className="app-section-kicker mt-7 uppercase text-[#A94E2B]">Your next chapter</p>
          <h1 className="app-editorial-title mt-3 text-[2.25rem] text-[#2A2622] sm:text-5xl">
            Recommended Reading
          </h1>
          <p className="mx-auto mt-5 max-w-md text-[15px] leading-7 text-[#6B645B]">
            {message}
          </p>

          {!isLoading && (
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
              <button
                type="button"
                onClick={onStartRecommendation}
                className="app-primary-action inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-xl px-5 py-3 text-sm font-semibold sm:w-auto"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Start recommendation
              </button>
              <button
                type="button"
                onClick={onOpenLibrary}
                className="inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-xl border border-[#DCD5C7] bg-[#FFFDFA] px-5 py-3 text-sm font-medium text-[#332E28] transition-colors hover:bg-[#F2ECE0] active:bg-[#EFEAE0] sm:w-auto"
              >
                <Library className="h-4 w-4" aria-hidden="true" />
                Browse library
              </button>
            </div>
          )}
          <p className="mt-8 border-t border-[#EDE7DD] pt-5 text-xs leading-6 text-[#81776B]">
            Read at your pace. Look up a word whenever you need to.
          </p>
        </section>
      </div>
      </main>
    </>
  );
};
