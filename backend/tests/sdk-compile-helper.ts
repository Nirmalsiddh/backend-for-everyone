import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export async function compileSdk(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-sdk-'));
  try {
    await writeFile(join(directory,'client.ts'),source);
    execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--lib','ES2022,DOM','--skipLibCheck','--outDir',join(directory,'out'),join(directory,'client.ts')],{encoding:'utf8'});
    return { module: await import(pathToFileURL(join(directory,'out/client.js')).href), cleanup: ()=>rm(directory,{recursive:true,force:true}) };
  } catch(error) { await rm(directory,{recursive:true,force:true}); throw error; }
}
