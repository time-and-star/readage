import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await fs.readFile(path.join(root,'website/book-titles.zh-CN.json'),'utf8'));
const allowed=new Set(['fiction','mystery','fantasy','children','poetry','history','thought','nature','essays']);
assert.equal(manifest.entries.length,506);
const groups={};
for(const entry of manifest.entries){
 assert.ok(allowed.has(entry.category));assert.match(entry.sha256,/^[a-f0-9]{64}$/);
 (groups[entry.category]??=[]).push(entry.sha256);
}
assert.equal(new Set(Object.values(groups).flat()).size,506);
const begin='// BEGIN CURATED BOOK CATEGORIES',end='// END CURATED BOOK CATEGORIES';
const block=begin+'\nconst curatedBookCategoryGroups = '+JSON.stringify(groups,null,2)+';\n'+end;
const target=path.join(root,'website/book-presentation.js');let text=await fs.readFile(target,'utf8');
assert.ok(text.includes(begin)&&text.includes(end));
text=text.slice(0,text.indexOf(begin))+block+text.slice(text.indexOf(end)+end.length);
if(process.argv.includes('--check')){assert.equal(text,await fs.readFile(target,'utf8'),'Run node scripts/sync-book-categories.mjs');console.log('506 book categories match the curated manifest.');}
else{await fs.writeFile(target,text);console.log('506 curated categories synced to the shared presentation module.');}
