import React, { useMemo } from 'react';
import type { UserLibraryFile } from '../lib/userLibrary';
import { bookIntroduction } from '../lib/bookIntroduction';
import { IntroductionCard } from './PublicationIntroduction';

export function BookIntroduction({ file }: { file: UserLibraryFile }) {
  const introduction = useMemo(() => bookIntroduction(file), [file]);
  return <IntroductionCard {...introduction} />;
}
