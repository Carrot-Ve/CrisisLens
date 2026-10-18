import { mkdirSync, writeFileSync } from 'node:fs';
import { openDb } from '../src/storage/db.ts';
import { createLiveService } from '../src/live/service.ts';
mkdirSync('data', { recursive:true });
mkdirSync('artifacts', { recursive:true });
const db=openDb('data/live-smoke.db');
const service=createLiveService(db.raw);
const prompt=process.argv[2] ?? '请联网搜索 模型 API 官方文档，仅核实它是否支持工具调用。读取一条官方原文后，立即用中文给出两句话的结论和原文引用。';
try {
  console.log('Model:',await service.status());
  const task=service.createTask(prompt,crypto.randomUUID());
  service.send(task.taskId,prompt,crypto.randomUUID());
  let cursor=-1;
  for(let i=0;i<650;i++) {
    const d=service.detail(task.taskId);
    for(const event of d.events.filter(e=>e.sequence>cursor)) { console.log(event.payload);cursor=event.sequence; }
    if(d.runs[0]?.status!=='running') {
      writeFileSync('artifacts/live-smoke.json',JSON.stringify(d,null,2));
      console.log(JSON.stringify({status:d.runs[0]?.status,sources:d.sources.length,report:d.report?.markdown},null,2));
      if(d.runs[0]?.status!=='completed' || !d.sources.length || !d.report)process.exitCode=1;
      break;
    }
    await new Promise(r=>setTimeout(r,1000));
  }
} finally {await service.close();db.close();}
