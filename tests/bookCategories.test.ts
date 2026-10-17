import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bookCategory, bookCategoryLabel, filterLibraryItems, libraryBookCategories, localizedBookTitle} from '../website/book-presentation.js';
const manifest=JSON.parse(await readFile(new URL('../website/book-titles.zh-CN.json',import.meta.url),'utf8'));
const entries: Array<{id:string;sha256:string;category:string;zhCN:string;originalTitle:string;authorZhCN:string;authorOriginal:string}>=manifest.entries;
const items=entries.map(entry=>({
  id:entry.id,sha256:entry.sha256,kind:'book',title:localizedBookTitle(entry),filename:entry.sha256+'.epub',expectedCategory:entry.category,name:entry.zhCN,
}));

test('506 books have one curated main category; all nine counts reconcile and magazine entries are excluded',()=>{
  assert.equal(items.length,506);
  for(const item of items){assert.equal(bookCategory(item),item.expectedCategory);assert.ok(bookCategoryLabel(item));}
  const categories=libraryBookCategories([...items,{id:'economist:2026.10.17',kind:'magazine'}]);
  assert.deepEqual(Object.fromEntries(categories.map(c=>[c.id,c.count])),{
    fiction:221,mystery:52,fantasy:49,children:54,poetry:71,history:27,thought:17,nature:5,essays:10,
  });
  assert.equal(categories.reduce((sum,c)=>sum+c.count,0),506);
});

test('category, Chinese or English title, and author search intersect without changing file identities',()=>{
  const categoryItems=filterLibraryItems(items,{category:'mystery'});
  assert.equal(categoryItems.length,52);
  const doyle=filterLibraryItems(items,{category:'mystery',query:'CONAN DOYLE'});
  assert.equal(doyle.length,9);assert.ok(doyle.some(item=>item.name==='血字的研究'));
  assert.equal(filterLibraryItems(items,{category:'fantasy',query:'失落的世界'}).length,1);
  assert.equal(filterLibraryItems(items,{category:'fiction',query:'简·奥斯汀'}).length,6);
  assert.equal(filterLibraryItems(items,{category:'mystery',query:'简·奥斯汀'}).length,0);
  assert.equal(filterLibraryItems(items,{category:'history',query:'世界简史'}).length,1);
  assert.equal(filterLibraryItems(items,{query:'    '}).length,506);
  assert.equal(filterLibraryItems(items,{category:'mystery',query:'血字'})[0],doyle.find(item=>item.name==='血字的研究'));
});

test('custom unknown books remain reachable; a changed file is not silently given the category of its old SHA',()=>{
  const first=items[0];assert.equal(bookCategory({id:first.id}),first.expectedCategory);
  assert.equal(bookCategory({...first,sha256:'0'.repeat(64)}),'other');
  const custom={id:'book:custom',kind:'book',title:'自建书籍',filename:'custom.epub'};
  const magazine={id:'wired:2026.10.17',kind:'magazine',title:'Wired · 2026.10.17',filename:'wired.epub'};
  assert.equal(bookCategory(custom),'other');assert.equal(bookCategory(magazine),'');
  assert.deepEqual(libraryBookCategories([custom,magazine]),[{id:'other',label:'其他书籍',count:1}]);
  assert.deepEqual(filterLibraryItems([custom,magazine],{category:'other'}),[custom]);
  assert.deepEqual(filterLibraryItems([custom,magazine],{kind:'magazine'}),[magazine]);
});
