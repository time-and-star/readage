import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MyLearningScreen } from '../src/components/MyLearningScreen';

const baseProps = {
  onBack: () => undefined,
  onOpenRecommendedReading: () => undefined,
  onOpenFlashcards: () => undefined,
  onOpenReadingRecords: () => undefined,
  onOpenDictionarySettings: () => undefined,
  onOpenArticle: () => undefined,
  articlesReadCount: 2,
  introducedWordsCount: 11,
  learnedWordsCount: 24,
  masteredWordsCount: 8,
  learningWordsCount: 5,
  streakDaysCount: 4,
  recentEventCount: 12,
  dueWordCount: 3,
  proficiencies: [],
  proficienciesLoading: false,
  weakPointMetrics: [],
  articleProgress: [],
};

test('My Learning renders real metric labels and honest empty states', () => {
  const html = renderToStaticMarkup(React.createElement(MyLearningScreen, baseProps));
  assert.match(html, /已完成文章/);
  assert.match(html, /<button[^>]*aria-label="已完成 2 篇文章，查看文章与生词"/);
  assert.doesNotMatch(html, /英语测试|重新测试|尚未定级|cefr-profile-heading/);
  assert.match(html, /新词/);
  assert.match(html, /学习中/);
  assert.match(html, /较熟悉/);
  assert.match(html, /正式回忆后已到期/);
  assert.match(html, /连续天数/);
  assert.match(html, /近 7 天记录/);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /新引入词|连续学习天数|L4|L1–L3/);
  assert.doesNotMatch(html, /\u5c1a\u672a\u53d1\u73b0\u660e\u786e\u8584\u5f31\u70b9/);
  assert.doesNotMatch(html, /weak-points-heading/);
  assert.match(html, /学习数据保存在本机浏览器/);
  assert.match(html, /阅读数据说明/);
  assert.match(html, /词汇学习证据/);
  assert.match(html, /主动调用 AI/);
  assert.match(html, /推荐诊断/);
  assert.match(html, /不使用这些功能时，不会为了统计阅读而上传整篇文章/);
  assert.match(html, /导出当前备份/);
  assert.match(html, /导入备份/);
  assert.match(html, /导出词汇表/);
  assert.match(html, /<details[^>]*>/);
  assert.match(html, /<summary[^>]*>[\s\S]*阅读数据说明/);
  assert.ok(
    html.indexOf('已完成文章') < html.indexOf('阅读数据说明'),
    'learning metrics should appear before the expandable data explanation',
  );
  assert.doesNotMatch(html, /演示固定值|中位示意/);
});

test('My Learning keeps the overview concise and secondary explanations collapsed', () => {
  const html = renderToStaticMarkup(React.createElement(MyLearningScreen, baseProps));
  // Details now contain nested sections and another collapsed tools disclosure.
  let depth = 0;
  const defaultContent = html.split(/(<\/?details\b[^>]*>)/).filter(part => {
    if (part.startsWith('<details')) { depth++; return false; }
    if (part.startsWith('</details')) { depth--; return false; }
    return depth === 0;
  }).join('') + Array.from(html.matchAll(/<summary\b[^>]*>[\s\S]*?<\/summary>/g), match => match[0]).join('');

  assert.match(defaultContent, /学习概览/);
  assert.match(defaultContent, /已学习<\/dt><dd><strong[^>]*>24<\/strong> 词/);
  assert.match(defaultContent, /待复习<\/dt><dd><strong[^>]*>3<\/strong> 词/);
  assert.match(defaultContent, /推荐阅读/);
  assert.match(defaultContent, /词卡学习/);
  assert.doesNotMatch(defaultContent, /每篇推荐文章只覆盖部分待复习词/);
  assert.match(html, /每篇推荐文章只覆盖部分待复习词/);
  assert.doesNotMatch(defaultContent, /开始复习|正在生成复习文章/);
  assert.match(defaultContent, /词典设置/);
  assert.match(defaultContent, /数据与备份/);
  assert.match(defaultContent, /安装查词插件/);
  assert.doesNotMatch(defaultContent, /导出词汇表|导出备份|学习数据保存在本机浏览器/);
  assert.doesNotMatch(defaultContent, /较熟悉|学习中|近 7 天|熟悉度|CSV|JSON/);
  assert.doesNotMatch(html, /A little|My learning|复习，让词汇留下来|在新的语境中/);
  assert.match(html, /<summary[^>]*>[\s\S]*?<span>学习详情<\/span>[\s\S]*?<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|>)/);
});

test('My Learning places reading and flashcards in one adjacent learning entry group', () => {
  const html = renderToStaticMarkup(React.createElement(MyLearningScreen, baseProps));
  const actions = html.match(/<div[^>]*role="group"[^>]*aria-label="学习入口"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? '';

  assert.match(actions, /<button[^>]*>推荐阅读<\/button><button[^>]*>词卡学习<\/button>/);
  assert.equal(actions.match(/<button\b/g)?.length, 2);
  assert.ok(html.indexOf('学习入口') < html.indexOf('学习详情'));
});

test('My Learning consolidates settings and utilities below learning content', () => {
  const html = renderToStaticMarkup(React.createElement(MyLearningScreen, baseProps));
  const utilities = html.slice(html.indexOf('<section class="learning-settings"'));

  assert.ok(html.indexOf('词卡学习') < html.indexOf('学习详情'));
  assert.ok(html.indexOf('学习详情') < html.indexOf('设置与工具'));
  assert.ok(html.indexOf('设置与工具') < html.indexOf('词典设置'));
  assert.match(utilities, /<button[^>]*>[\s\S]*?词典设置[\s\S]*?<\/button>/);
  assert.match(utilities, /<a href="\/extension-setup.html"[^>]*>[\s\S]*?安装查词插件[\s\S]*?<\/a>/);
  assert.match(utilities, /<details[^>]*><summary[^>]*>[\s\S]*?数据与备份[\s\S]*?<\/summary>[\s\S]*导入备份[\s\S]*导出当前备份[\s\S]*其他工具[\s\S]*导出词汇表/);
  assert.match(utilities, /aria-label="选择学习备份文件"/);
  assert.match(utilities, /CSV 文件可用 Excel 打开/);
  assert.match(utilities, /导入只加入下方列表，不会覆盖当前学习记录/);
  assert.match(utilities, /恢复前会确认覆盖当前记录/);
  assert.match(utilities, /阅读数据说明[\s\S]*词汇学习证据[\s\S]*主动调用 AI/);
  assert.doesNotMatch(html.slice(0, html.indexOf('设置与工具')), /导出词汇表|导出备份|导入备份|安装查词插件|阅读数据说明/);
});

test('My Learning describes recorded words separately from mastery and article coverage', () => {
  const html = renderToStaticMarkup(React.createElement(MyLearningScreen, {
    ...baseProps,
    weakPointMetrics: [{ skill: 'articles', issueCount: 2, severity: 65 }],
    articleProgress: [{
      article: {
        id: 'a1',
        title: 'A completed article',
        description: 'desc',
        date: 'Jul 24, 2026',
        status: 'Completed',
        content: ['Paragraph'],
      },
      clickCount: 4,
      discussionCount: 1,
      hasSession: true,
    }],
  }));

  assert.match(html, /已完成/);
  assert.doesNotMatch(html, /articles · 2 次记录/);
  assert.match(html, /已学习指已有正式回忆记录的词/);
  assert.match(html, /待复习仅计正式回忆后已到期且未暂停或移出的词/);
  assert.match(html, /熟悉度是估计，不代表全部掌握/);
  assert.match(html, /每篇推荐文章只覆盖部分待复习词/);
  assert.match(html, /读完后仅更新实际学习的词/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /查词 4/);
  assert.doesNotMatch(html, /article-progress-heading/);
  assert.doesNotMatch(html, /A completed article/);
});
