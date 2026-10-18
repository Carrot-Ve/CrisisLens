import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.ts';
import { createInvestigationService } from '../src/app/service.ts';
import { createLiveService } from '../src/live/service.ts';
import { createApiServer } from '../src/server/http.ts';
import { boundedContext } from '../src/live/context.ts';
import { abortable } from '../src/live/web.ts';
import { createLiveStore } from '../src/live/store.ts';
import { insertRun } from '../src/storage/repos.ts';
import type { ModelContext } from '../src/live/types.ts';

test('旧模拟服务不列出真实任务，也不能为真实任务启动假模型',async()=>{
  const db=openDb(':memory:'),fixture=createInvestigationService(db.raw,'unused'),live=createLiveService(db.raw);
  try {
    const task=live.createTask('真实敏感任务','t');
    assert.equal(fixture.listTasks().length,0);
    await assert.rejects(()=>fixture.startRun(task.taskId),/真实|不存在/);
    assert.equal(live.detail(task.taskId).runs.length,0);
  } finally {await live.close();fixture.close();db.close();}
});

test('整个上下文受限且长消息尾部的修订保持完整',()=>{
  const latest='材料'.repeat(5900)+'最后修订：只调查召回，https://example.com/latest';
  const input:ModelContext={objective:'初始目标'.repeat(1000),messages:[{role:'assistant',content:'旧结果'.repeat(5000)},{role:'user',content:latest}],sources:Array.from({length:8},(_,i)=>({id:`S${i}`,runId:'r',url:'https://example.com',title:'来源',content:'原文'.repeat(7000),hash:'h',retrievedAt:1})),observations:['观察'.repeat(5000)],remainingSteps:3,date:'2026-10-14'};
  const result=boundedContext(input);
  assert.equal(result.messages.at(-1)?.content,latest);
  assert.ok(JSON.stringify(result).length<=18000);
});

test('DNS 等待可被取消，不等待底层解析结束',async()=>{
  const controller=new AbortController();
  const pending=abortable(new Promise<never>(()=>{}),controller.signal);
  controller.abort(new Error('cancelled DNS'));
  await assert.rejects(pending,/cancelled DNS/);
});

test('搜索候选截取后仍是完整 JSON，并保留后面的来源链接',()=>{
  const results=Array.from({length:10},(_,i)=>({url:`https://example.com/${i}`,title:`报道${i}`,snippet:'摘要'.repeat(500)}));
  const result=boundedContext({objective:'调查',messages:[{role:'user',content:'事件'}],sources:[],observations:[JSON.stringify({search:'事件',results})],remainingSteps:7,date:'2026-10-15'});
  const parsed=JSON.parse(result.observations[0]!);
  assert.equal(parsed.results.length,10);
  assert.equal(parsed.results[9].url,'https://example.com/9');
});

test('重启将旧运行标记失败并保留会话及来源',async()=>{
  const db=openDb(':memory:');
  const store=createLiveStore(db.raw),task=store.createTask('恢复检查','restart');
  store.addMessage(task.taskId,'user','保留消息','msg');
  insertRun(db.raw,'old-run',task.taskId,Date.now());store.bindPending(task.taskId,'old-run');
  store.saveSource(task.taskId,'old-run',{url:'https://example.com',title:'原文',content:'保留原文'});
  const service=createLiveService(db.raw);
  try {const detail=service.detail(task.taskId);assert.equal(detail.runs[0]?.status,'failed');assert.equal(detail.messages.length,1);assert.equal(detail.sources.length,1);}
  finally{await service.close();db.close();}
});

test('所有 API 禁止跨站读取/写入；真实消息接口校验与幂等',async()=>{
  const db=openDb(':memory:'),fixture=createInvestigationService(db.raw,'unused');
  const live=createLiveService(db.raw,{model:{name:'test',async status(){return {connected:true,model:'test',models:['test']};},async decide(){return {decision:{action:'clarify',text:'请补充事件'},usage:{inputTokens:1,outputTokens:1,durationMs:1}};}}});
  const server=createApiServer(fixture,{port:0,live});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();assert.ok(address && typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  const post=(path:string,value:unknown)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  try {
    assert.equal((await fetch(`${base}/api/tasks`,{headers:{origin:'https://evil.example'}})).status,403);
    assert.equal((await fetch(`${base}/api/live/tasks`,{headers:{origin:'https://evil.example'}})).status,403);
    assert.equal((await post('/api/live/tasks',{})).status,400);
    const response=await post('/api/live/tasks',{title:'调查测试',clientId:'new'});
    assert.equal(response.status,201);
    const {task}=await response.json() as {task:{taskId:string}};
    for(let i=0;i<2;i++)assert.equal((await post(`/api/live/tasks/${task.taskId}/messages`,{content:'请调查',clientId:'same'})).status,202);
    assert.equal(live.detail(task.taskId).messages.filter(m=>m.role==='user').length,1);
    assert.equal((await post('/api/live/tasks/missing/messages',{content:'x',clientId:'m'})).status,404);
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await live.close();fixture.close();db.close();}
});
