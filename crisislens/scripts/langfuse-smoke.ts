import {writeFileSync} from 'node:fs';
import {openDb} from '../src/storage/db.ts';
import {createLiveService} from '../src/live/service.ts';
import {initializeTracing,flushTracing,shutdownTracing} from '../src/live/tracing.ts';
process.loadEnvFile('.env.langfuse');
initializeTracing();
const db=openDb(':memory:'),service=createLiveService(db.raw);
try {
  const task=service.createTask('Langfuse 本地接入实测',crypto.randomUUID());
  service.send(task.taskId,'请读取 https://www.iana.org/help/example-domains ，用一句话说明该页面主题并附原文引用。',crypto.randomUUID());
  let finished=false;
  for(let i=0;i<360;i++) {
    const d=service.detail(task.taskId);
    if(d.runs[0]?.status!=='running') {
      const traceId=d.events.map(e=>JSON.parse(e.payload)).find(e=>e.type==='trace_started')?.traceId;
      if(!traceId)throw new Error('No trace ID');
      await flushTracing();
      const headers={authorization:'Basic '+Buffer.from(process.env.LANGFUSE_PUBLIC_KEY+':'+process.env.LANGFUSE_SECRET_KEY).toString('base64')};
      let observations:Record<string,unknown>[]=[];
      for(let n=0;n<30;n++) {
        const r=await fetch(`${process.env.LANGFUSE_BASE_URL}/api/public/v2/observations?limit=100&traceId=${traceId}&fields=core,basic,usage,model,io,metadata`,{headers});
        if(!r.ok)throw new Error(`Langfuse readback HTTP ${r.status}`);
        const data=await r.json() as {data:Record<string,unknown>[]};
        observations=data.data.filter(o=>o.traceId===traceId);
        if(observations.some(o=>o.name==='model.decide') && observations.some(o=>o.name==='web.read'))break;
        await new Promise(r=>setTimeout(r,1000));
      }
      writeFileSync('artifacts/langfuse-smoke.json',JSON.stringify({traceId,status:d.runs[0]?.status,observations},null,2));
      console.log(JSON.stringify({traceId,status:d.runs[0]?.status,observations:observations.map(o=>({name:o.name,type:o.type}))}));
      if(!observations.some(o=>o.name==='model.decide') || !observations.some(o=>o.name==='web.read'))throw new Error('Model/tool observations missing from Langfuse');
      if(!observations.some(o=>o.type==='GENERATION' && o.sessionId===task.taskId))throw new Error('Generation session association missing');
      if(!observations.some(o=>o.type==='GENERATION' && o.input && o.output && o.usageDetails))throw new Error('Generation input/output/usage missing');
      finished=true;break;
    }
    await new Promise(r=>setTimeout(r,500));
  }
  if(!finished)throw new Error('Smoke test timeout');
} finally {await service.close();db.close();await shutdownTracing();}
