export const FRENCH_TRIAL_TEXT = `Aujourd’hui, l’homme regarde les chevaux près de l’école. Les enfants mangent des pommes et lisent des livres.

Hier, nous sommes allés au marché. Une femme a acheté de belles fleurs, puis elle est rentrée chez elle.`;

export const JAPANESE_TRIAL_TEXT = `今日は学校の図書館で本を読んでいます。友達と日本語を勉強しました。

昨日、公園を歩きました。昼ご飯に寿司を食べました。家に帰ってから、新しい本を読みました。`;

export type DictionaryTrialLanguage = 'fr' | 'ja';

export const DICTIONARY_TRIALS = {
  fr: {
    languageName: '法语', nativeName: 'Français', sample: FRENCH_TRIAL_TEXT,
    sampleTitle: 'Une promenade à la campagne', customTitle: 'Texte à lire',
    queryPlaceholder: '例如 chevaux、école', sampleHint: '可以先点 chevaux、mangent、allés。',
    morphologyHint: '词典会展示已收录的词形对应；有多个可能原词时会保留多个结果。',
  },
  ja: {
    languageName: '日语', nativeName: '日本語', sample: JAPANESE_TRIAL_TEXT,
    sampleTitle: '図書館での一日', customTitle: '日本語の文章',
    queryPlaceholder: '例如 学校、図書館、食べました', sampleHint: '可以先点 学校、図書館、本，或查询 食べました。',
    morphologyHint: '词典会展示已收录的读音和中文释义；支持的变形词会同时查询原形。',
  },
} as const;

export function languageName(language: string): string {
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(language) ?? language; }
  catch { return language; }
}
