const NON_STORY_TITLE = /^(magazine articles|contents|table of contents|cover|masthead|advertisements?)$/i;

/** Exact publication furniture labels; ordinary story titles remain eligible. */
export function isNonStoryArticleTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && NON_STORY_TITLE.test(title.trim().replace(/\s+/g, ' '));
}
