// Transport optimization only: never append data to or modify the signed installer.
import path from 'node:path';
import { buildBlockMap } from '../../node_modules/app-builder-lib/out/targets/blockmap/blockmap.js';
const [input, output] = process.argv.slice(2);
if (!input || !output || path.resolve(input) === path.resolve(output)) throw new Error('Separate input and output paths required');
console.log(JSON.stringify(await buildBlockMap(input, 'gzip', output)));
