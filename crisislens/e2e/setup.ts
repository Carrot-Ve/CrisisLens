import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/storage/db.ts';
import { createInvestigationService } from '../src/app/service.ts';
import { createLiveService } from '../src/live/service.ts';
import { listen } from '../src/server/http.ts';

// Own the server in the test runner instead of spawning an npm/cmd process tree.
// Windows process-tree termination is unreliable under restricted execution.
export default async function setup() {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const temporary=mkdtempSync(join(tmpdir(),'crisislens-e2e-'));
  const db=openDb(join(temporary,'test.db'));
  const fixture=createInvestigationService(db.raw,resolve(root,'../crisislens_dataset'));
  const live=createLiveService(db.raw);
  let server:Awaited<ReturnType<typeof listen>>['server']|undefined;
  async function cleanup() {
    if(server) {server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}
    await live.close();fixture.close();db.close();
    if(!resolve(temporary).startsWith(resolve(join(tmpdir(),'crisislens-e2e-'))))throw new Error('拒绝清理非测试目录');
    rmSync(temporary,{recursive:true,force:true});
  }
  try {
    ({server}=await listen(fixture,{port:8788,live,webRoot:join(root,'web/dist'),tasksRoot:join(root,'tasks'),datasetRoot:resolve(root,'../crisislens_dataset')}));
  } catch(error) {await cleanup();throw error;}
  return cleanup;
}
