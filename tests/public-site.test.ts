
import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
it('publishes only reviewed public files and resolves every local page link',()=>{
 execFileSync(process.execPath,['scripts/build-public-site.mjs']);
 const root=resolve('.runtime/public-site'),files=readdirSync(root);
 expect(files).toHaveLength(30);expect(files.some(f=>f.endsWith('.md'))).toBe(false);
 for(const file of files.filter(f=>f.endsWith('.html'))){
  const text=readFileSync(resolve(root,file),'utf8');
  expect(text).toContain('lang=');
  for(const match of text.matchAll(/(?:href|src)="([^"]+)"/g)){
   if(/^(https?:|mailto:|#)/.test(match[1]))continue;
   expect(existsSync(resolve(dirname(resolve(root,file)),match[1]))).toBe(true);
  }
 }
});
it('forwards only numeric Steam app ids to the Steam app, under a hashed inline-script policy',()=>{
 const text=readFileSync(resolve('docs/open.html'),'utf8');
 const script=/<script>([\s\S]*?)<\/script>/.exec(text)![1]!;
 const hash=createHash('sha256').update(script).digest('base64');
 expect(text).toContain(`script-src 'sha256-${hash}'`);
 expect(script).toContain('/^[0-9]{1,10}$/.test(id)');
 expect(script).toContain("'steam://store/'+id");
});
