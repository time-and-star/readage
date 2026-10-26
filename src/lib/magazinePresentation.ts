import type { MagazineSourceSummary } from '../types';

// Keep catalog metadata and English cover lettering separate from Chinese captions.
const sourceNames: Readonly<Record<string, string>> = {
  economist: '经济学人',
  new_yorker: '纽约客',
  atlantic: '大西洋月刊',
  wired: '连线',
  news_in_levels_a2: '分级新闻 · 第1级',
  news_in_levels_b1: '分级新闻 · 第2级',
  conversation: '对话',
  jstor_daily: 'JSTOR 日报',
  science_news_explores: '科学新闻探索',
  mit_press_reader: '麻省理工出版社读物',
};

const topicNames: Readonly<Record<string, string>> = {
  'Current Affairs': '时事',
  'Culture & Literature': '文化与文学',
  'Ideas & Society': '思想与社会',
  Technology: '科技',
  'Graded News': '分级新闻',
  'Research & Society': '研究与社会',
  'History & Culture': '历史与文化',
  'Science & Nature': '科学与自然',
  'Ideas & Philosophy': '思想与哲学',
};

export function magazineSourceCaption(source: Pick<MagazineSourceSummary, 'id' | 'displayName' | 'topic'>) {
  return {
    name: Object.prototype.hasOwnProperty.call(sourceNames, source.id) ? sourceNames[source.id] : source.displayName,
    topic: source.topic && (Object.prototype.hasOwnProperty.call(topicNames, source.topic) ? topicNames[source.topic] : source.topic),
  };
}
