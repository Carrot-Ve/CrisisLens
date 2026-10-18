import {writeFileSync} from 'node:fs';
const base='http://127.0.0.1:8787';
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json();}
const {task}=await post('/api/live/tasks',{title:'修复验证｜中文事件调查',clientId:crypto.randomUUID()});
const rounds=[];
for(const content of ['2024年的胖猫事件','那可以查什么啊？']) {
  await post(`/api/live/tasks/${task.taskId}/messages`,{content,clientId:crypto.randomUUID()});
  let done=false;
  for(let i=0;i<420;i++) {
    const d=await(await fetch(base+`/api/live/tasks/${task.taskId}`)).json();
    if(d.runs[0]?.status!=='running') {
      rounds.push(d); console.log(JSON.stringify({question:content,status:d.runs[0]?.status,sources:d.sources.map(s=>s.url),reply:d.messages.filter(m=>m.role==='assistant').at(-1)?.content}));
      if(d.runs[0]?.status!=='completed')throw new Error('Run did not complete');
      if(rounds.length===1 && (!d.report || !d.sources.length))throw new Error('Investigation has no cited report');
      if(rounds.length===2 && !/公开|搜索|新闻|公告/.test(d.messages.filter(m=>m.role==='assistant').at(-1)?.content ?? ''))throw new Error('Capabilities reply missing');
      done=true;break;
    }
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!done)throw new Error('Timed out');
}
writeFileSync('artifacts/search-regression.json',JSON.stringify({taskId:task.taskId,rounds},null,2));
