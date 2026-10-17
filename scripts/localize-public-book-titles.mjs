import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {localizedBookTitle} from '../website/book-presentation.js';

// Explicit local metadata maintenance. Never edits EPUB bytes or learning profiles.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await fs.readFile(path.join(root,'website/book-titles.zh-CN.json'),'utf8'));
assert.equal(manifest.schemaVersion,1);assert.equal(manifest.entries.length,506);
assert.equal(new Set(manifest.entries.map(e=>e.id)).size,506);
for(const entry of manifest.entries){
 assert.match(entry.sha256,/^[a-f0-9]{64}$/);assert.equal(entry.id,'book:public-'+entry.sha256);
 assert.ok(typeof entry.zhCN==='string' && /[\u3400-\u9fff]/.test(entry.zhCN) && !entry.zhCN.includes('｜'));
 assert.ok(typeof entry.originalTitle==='string' && entry.originalTitle.trim());
 assert.ok(!entry.authorZhCN || (typeof entry.authorZhCN==='string' && !entry.authorZhCN.includes('｜') && !entry.authorZhCN.includes(' — ')));
 assert.ok(localizedBookTitle(entry).length<=240);
}
const apply=process.argv.includes('--apply');
const dataDirectory=process.env.READAGE_WEBSITE_DATA_DIR || path.join(root,'website/.data');
const db=new DatabaseSync(path.join(dataDirectory,'library.sqlite'),{readOnly:!apply});
db.exec('PRAGMA busy_timeout=5000');
const before=db.prepare('SELECT * FROM resources ORDER BY id').all();
const versions=db.prepare('SELECT * FROM versions ORDER BY sha256').all();
const byId=new Map(before.map(row=>[row.id,row]));
let changed=0;
for(const entry of manifest.entries){
 const row=byId.get(entry.id),title=localizedBookTitle(entry);
 assert.ok(row,`Book missing: ${entry.id}`);assert.equal(row.kind,'book');assert.equal(row.sha256,entry.sha256);
 assert.ok(row.title===entry.originalTitle || row.title===entry.zhCN+'｜'+entry.originalTitle || row.title===title,`Unrecognized local title: ${row.title}`);
 if(row.title!==title)changed++;
}
if(!apply){console.log(JSON.stringify({mode:'preview',books:manifest.entries.length,toChange:changed}));db.close();process.exit(0);}
const phase=manifest.entries.every(entry=>entry.authorZhCN)?'authors':'titles';
const output=path.join(root,`output/website-book-${phase}-2026-10-17`);await fs.mkdir(output,{recursive:true});
const backupFile=path.join(output,`library-before-chinese-${phase}.sqlite`);
if(!await fs.stat(backupFile).catch(()=>null))await backup(db,backupFile);
db.exec('BEGIN IMMEDIATE');
try{
 const update=db.prepare("UPDATE resources SET title=? WHERE id=? AND kind='book' AND sha256=?");
 for(const entry of manifest.entries){const result=update.run(localizedBookTitle(entry),entry.id,entry.sha256);assert.equal(result.changes,1);}
 const after=db.prepare('SELECT * FROM resources ORDER BY id').all();
 // File identities, edition dates, filenames and magazine metadata must stay intact.
 assert.deepEqual(after.map(row=>({...row,title:byId.get(row.id).title})),before.map(row=>({...row})));
 assert.deepEqual(db.prepare('SELECT * FROM versions ORDER BY sha256').all(),versions);
 if(changed)db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run('updatedAt',new Date().toISOString());
 db.exec('COMMIT');
 const report={books:506,changed,authors:new Set(manifest.entries.map(entry=>entry.authorZhCN).filter(Boolean)).size,magazinesPreserved:before.filter(r=>r.kind==='magazine').length,
  originalFilesUnchanged:true,identitiesAndEditionDatesPreserved:true,backupFile,publishedToInternet:false,
  provisional:manifest.entries.filter(e=>e.note).map(e=>({title:e.zhCN,original:e.originalTitle,note:e.note})),completedAt:new Date().toISOString()};
 await fs.writeFile(path.join(output,'metadata-update.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
