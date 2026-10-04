import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { ReadAgeBrand } from './ReadAgeBrand';
import { WordSearchModule } from './WordSearchModule';

interface AppPageHeaderProps {
  onBack: () => void;
  navigation: React.ReactNode;
  actions?: React.ReactNode;
  showWordSearch?: boolean;
}

export const AppPageHeader: React.FC<AppPageHeaderProps> = ({
  onBack,
  navigation,
  actions,
  showWordSearch = true,
}) => (
  <header className="app-page-header sticky top-0 z-20 bg-[#F8F6F0]/90 px-4 backdrop-blur-md safe-pt sm:px-6">
    <div className="app-page-header__inner mx-auto grid h-16 w-full max-w-[1040px] grid-cols-[auto_minmax(0,1fr)_auto] items-center sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
      <div className="flex min-w-11 items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="tap-target inline-flex items-center justify-center rounded-xl p-2.5 text-[#524B43] transition-colors hover:bg-[#EFEAE0] active:bg-[#E8E2D5]"
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <ReadAgeBrand
          className="app-desktop-brand"
          logoClassName="h-7 w-7"
          nameClassName="text-base"
        />
      </div>

      <div className="flex min-w-0 justify-center px-1 sm:px-2">{navigation}</div>

      <div className="flex min-h-11 min-w-11 items-center justify-end gap-1">
        {showWordSearch && <WordSearchModule />}
        {actions}
      </div>
    </div>
  </header>
);
