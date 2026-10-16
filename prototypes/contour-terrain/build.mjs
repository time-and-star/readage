import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source=new URL('./dist/',import.meta.url);
const result=await build({entryPoints:[fileURLToPath(new URL('./app.js',source))],bundle:true,format:'iife',target:'es2020',write:false,minify:true,legalComments:'none'});
const css=await readFile(new URL('./style.css',source),'utf8');
const html=await readFile(new URL('./index.html',source),'utf8');
const js=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const standalone=html.replace('<link rel="stylesheet" href="./style.css">',()=>`<style>${css}</style>`).replace('<script type="module" src="./app.js"></script>',()=>`<script>${js}</script>`);
const output=new URL('./terrain.html',import.meta.url);
await writeFile(output,standalone);
console.log(`Standalone: ${fileURLToPath(output)}`);
