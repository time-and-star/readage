import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MyLearningScreen } from '../src/components/MyLearningScreen';

const baseProps = {
  onBack: () => undefined,
  onStartTargetedReview: () => undefined,
  onOpenArticle: () => undefined,
  articlesReadCount: 2,
  introducedWordsCount: 11,
  masteredWordsCount: 8,
  learningWordsCount: 5,
  streakDaysCount: 4,
  recentEventCount: 12,
  dueWordCount: 3,
  proficiencies: [],
  proficienciesLoading: false,
  weakPointMetrics: [],
  isTargetedReviewLoading: false,
  articleProgress: [],
};

test('My Learning renders real metric labels and honest empty states', () => {
  const html = renderToStaticMarkup(React.createElement(MyLearningScreen, baseProps));
  assert.match(html, /已完成文章/);
  assert.doesNotMatch(html, /英语测试|重新测试|尚未定级|cefr-profile-heading/);
  assert.match(html, /新引入词/);
  assert.match(html, /学习中/);
    assert.match(html, /较熟悉词/);
  assert.match(html, /正式到期复习/);
  assert.match(html, /连续学习天数/);
  assert.match(html, /近 7 天学习事件/);
  assert.doesNotMatch(html, /\u5c1a\u672a\u53d1\u73b0\u660e\u786e\u8584\u5f31\u70b9/);
  assert.doesNotMatch(html, /weak-points-heading/);
  assert.match(html, /学习数据保存在本机浏览器/);
  assert.match(html, /阅读数据说明/);
  assert.match(html, /词汇学习证据/);
  assert.match(html, /主动调用 AI/);
  assert.match(html, /推荐诊断/);
  assert.match(html, /不使用这些功能时，不会为了统计阅读而上传整篇文章/);
  assert.match(html, /导出备份/);
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

test('My Learning exposes completion status and targeted-review loading state', () => {
  const html = renderToStaticMarkup(React.createElement(MyLearningScreen, {
    ...baseProps,
    isTargetedReviewLoading: true,
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
  assert.match(html, /正在生成复习文章/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /查词 4/);
  assert.doesNotMatch(html, /article-progress-heading/);
  assert.doesNotMatch(html, /A completed article/);
});
