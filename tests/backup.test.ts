
import {it,expect} from 'vitest';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDatabase} from '../src/persistence/database.js';
import {UserConfigRepository} from '../src/persistence/user-config-repository.js';
// Operational scripts share the same SQLite engine but never log in to Discord.
import {createConsistentBackup,verifyDatabase} from '../scripts/backup.mjs';
it('backs up an open database, restores independently, and detects damaged content',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dealio-backup-test-')),source=join(directory,'source.db'),copy=join(directory,'backup.db');
 const db=createDatabase(source);
 try{
  new UserConfigRepository(db).upsert('u','76561198000000000','tr','TR',new Date().toISOString());
  const manifest=await createConsistentBackup(source,copy);
  expect(manifest.users).toBe(1);expect(manifest.schemaVersion).toBe(16);expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  db.prepare("DELETE FROM user_config WHERE discord_user_id='u'").run();
  expect((await verifyDatabase(copy)).users).toBe(1);
  expect((await readFile(copy)).includes(Buffer.from('DISCORD_TOKEN'))).toBe(false);
  await writeFile(copy,'damaged');await expect(verifyDatabase(copy)).rejects.toThrow();
 }finally{db.close();await rm(directory,{recursive:true,force:true});}
});
