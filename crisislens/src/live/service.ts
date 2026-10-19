import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createEvidenceStore } from '../core/evidence.ts';
import { finishRun, getReport, insertRun, listEvents, listRuns, listEvidence, replaceSnapshot, upsertReport } from '../storage/repos.ts';
import { createLiveStore } from './store.ts';
import { createApiModel } from './api-model.ts';
import { createWebTools } from './web.ts';
import { verifyCitations, validateDecision } from './validation.ts';
import type { LiveModel, WebTools, ModelContext } from './types.ts';
import { boundedContext } from './context.ts';
import { capabilityReply } from './help.ts';
import { createRunTrace } from './tracing.ts';
import {explicitEventSubject,sourceMatchesSubject} from './source-scope.ts';

export function createLiveService(db: DatabaseSync, deps: {model?:LiveModel;web?:WebTools}={}) {
  const store=createLiveStore(db), model=deps.model ?? createApiModel(), web=deps.web ?? createWebTools();
  const active=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  let closing=false;
  store.recover();

  async function run(taskId:string,runId:string,controller:AbortController) {
    const trace=createRunTrace(taskId,runId);
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(600000)]);
    let toolCalls=0;
    const observations:string[]=[];
    const searched=new Set<string>(),readUrls=new Set<string>();
    const event=(type:string,data:Record<string,unknown>)=>{store.event(runId,type,data);trace.event(type,data);};
    const counts=()=>({toolCalls,evidenceCount:listEvidence(db,runId).length,conflictCount:0});
    try {
      event('run_started',{text:'正在理解调查目标',model:model.name});
      if(trace.id)event('trace_started',{text:'已关联本地 Langfuse 追踪',traceId:trace.id});
      const task=store.requireTask(taskId);
      const history=store.messages(taskId).filter(m=>m.runId!==null && m.role!=='system');
      // An explicitly named event starts a fresh topic; keep only this topic's conversation.
      const topicStart=history.findLastIndex(m=>m.role==='user' && explicitEventSubject(m.content)!==null);
      const topicHistory=history.slice(Math.max(0,topicStart));
      const messages=topicHistory.slice(-16).map(m=>({role:m.role,content:m.content}));
      const currentRequest=history.filter(m=>m.role==='user' && m.runId===runId).map(m=>m.content).join('\n');
      const subject=explicitEventSubject(currentRequest) ?? (topicStart>=0 ? explicitEventSubject(history[topicStart]!.content) : null);
      trace.input({objective:currentRequest,messages});
      const help=capabilityReply(messages.filter(m=>m.role==='user').at(-1)?.content ?? '');
      if(help) {
        store.addMessage(taskId,'assistant',help,randomUUID(),runId);
        finishRun(db,runId,'completed',Date.now(),'awaiting_user',null,counts());
        event('run_completed',{text:'已说明调查能力和使用方式'});
        return;
      }
      const allowedUrls=new Set<string>();
      for(const match of currentRequest.matchAll(/https?:\/\/[^\s<>"'）)]+/g)) allowedUrls.add(match[0].replace(/[。，,;；]+$/,''));
      for(let step=0;step<8;step++) {
        signal.throwIfAborted();
        event('model_requested',{text:step===0?'分析目标与已有资料':'分析检索结果与证据',model:model.name});
        const sources=store.sources(taskId).filter(s=>s.runId===runId).slice(-8);
        const input:ModelContext=boundedContext({objective:currentRequest,messages,sources,observations,remainingSteps:8-step,date:new Date().toISOString().slice(0,10)});
        const response=await trace.observe('model.decide','generation',input,()=>model.decide(input,signal),model.name);
        signal.throwIfAborted();
        event('model_usage',{...response.usage,model:model.name});
        const decision=validateDecision(response.decision);
        if(decision.action==='clarify') {
          store.addMessage(taskId,'assistant',decision.text,randomUUID(),runId);
          finishRun(db,runId,'completed',Date.now(),'awaiting_user',null,counts());
          event('run_completed',{text:'等待补充调查信息'});
          return;
        }
        if(decision.action==='answer') {
          try {
            if(!sources.length || !decision.citations.length)throw new Error('本轮尚无可引用证据，必须先搜索并读取当前问题的来源，不能引用历史报告');
            verifyCitations(decision.citations,sources);
            const ids=new Set(decision.citations.map(c=>c.sourceId));
            for(const mention of decision.text.matchAll(/\[(S\d+)\]/g)) if(!ids.has(mention[1]!)) throw new Error(`正文引用未提供可核验摘录：${mention[1]}`);
            if(sources.length && !decision.citations.length) throw new Error('已有来源的调查回答必须提供原文引用');
          } catch(error) {
            observations.push(`引用校验失败，必须修正：${String(error)}`);
            event('validation_failed',{text:String(error)});
            continue;
          }
          const evidence=createEvidenceStore();
          for(const c of decision.citations) {
            evidence.addEvidence({sourceId:sources.find(s=>s.id===c.sourceId)!.url,channel:'public',quote:c.quote,excerpt:c.quote});
          }
          replaceSnapshot(db,runId,{evidence:evidence.evidence,claims:[],conflicts:[]});
          const used=sources.filter(s=>decision.citations.some(c=>c.sourceId===s.id));
          const references=used.map(s=>`- [${s.id}] [${s.title.replace(/[\[\]]/g,'')}](${s.url})`).join('\n');
          const warning=used.length?'\n\n> 本文为基于所列材料的模型分析；原文引用已校验，结论仍需人工复核。':'\n\n> 本轮没有取得可引用的网页原文，不能作为事实核验结论。';
          const markdown=decision.text+warning+(references?`\n\n## 来源\n${references}`:'');
          upsertReport(db,runId,{status:'partial',stopReason:'partial_delivery',markdown,missingMaterial:['模型分析仍需人工复核'],sections:[]},Date.now());
          store.addMessage(taskId,'assistant',markdown,randomUUID(),runId);
          finishRun(db,runId,'completed',Date.now(),'partial_delivery',null,{...counts(),evidenceCount:evidence.list().length});
          event('run_completed',{text:'已生成带来源的分析，保留待核实项'});
          return;
        }
        if(toolCalls>=12) throw new Error('达到网络工具预算，请缩小范围后继续');
        toolCalls++;
        if(decision.action==='search') {
          if(searched.has(decision.query)) { observations.push('该查询已经执行过，不要重复；请更换具体查询或如实说明受阻并请求用户提供链接。'); event('validation_failed',{text:'跳过重复查询，请求模型调整策略'});continue; }
          searched.add(decision.query);
          event('tool_started',{text:`搜索：${decision.query}`,tool:'search',query:decision.query});
          try {
            const hits=await trace.observe('web.search','tool',{query:decision.query},()=>web.search(decision.query,signal));
            signal.throwIfAborted();
            hits.forEach(h=>allowedUrls.add(h.url));
            observations.push(JSON.stringify({search:decision.query,results:hits}));
            event('tool_completed',{text:`找到 ${hits.length} 个候选来源`,tool:'search',count:hits.length,hits});
          } catch(error) { signal.throwIfAborted(); observations.push(`搜索失败：${String(error)}`); event('tool_failed',{text:`搜索失败：${String(error)}`}); }
        } else {
          if(readUrls.has(decision.url)) {observations.push(`禁止重复读取 ${decision.url}：已读取或失败过。必须选择其他链接，或改用事件名加“警方 通报”搜索。`);continue;}
          readUrls.add(decision.url);
          event('tool_started',{text:`读取：${decision.url}`,tool:'read',url:decision.url});
          try {
            if(!allowedUrls.has(decision.url)) throw new Error('只能读取搜索返回或用户提供的 URL，不允许猜测网址');
            const page=await trace.observe('web.read','tool',{url:decision.url},()=>web.read(decision.url,signal));
            signal.throwIfAborted();
            if(!sourceMatchesSubject(subject,page))throw new Error(`来源正文未提及本轮事件主体“${subject}”，拒绝作为本轮证据`);
            const source=store.saveSource(taskId,runId,page);
            observations.push(`已读取URL：${decision.url}`);
            observations.push(`已读取 ${source.id}：${source.title}。请引用 sources 中的连续原文。`);
            event('source_read',{text:`已读取 ${source.title}`,sourceId:source.id,url:source.url});
          } catch(error) { signal.throwIfAborted(); observations.push(`读取 ${decision.url} 失败：${String(error)}。不得再次读取此 URL，请选择其他来源。`); event('tool_failed',{text:`读取失败：${String(error)}`,url:decision.url}); }
        }
      }
      throw new Error('本轮达到 8 次模型决策上限，已保留来源；可缩小范围继续追问');
    } catch(error) {
      const message=controller.signal.aborted?'已停止本轮调查':signal.aborted?'调查超过时间限制':error instanceof Error?error.message:String(error);
      finishRun(db,runId,controller.signal.aborted?'cancelled':'failed',Date.now(),null,message,counts());
      store.addMessage(taskId,'system',message,randomUUID(),runId);
      event(controller.signal.aborted?'run_cancelled':'run_failed',{text:message});
    } finally {
      const result=listRuns(db,taskId).find(r=>r.runId===runId);
      const reply=store.messages(taskId).filter(m=>m.runId===runId && m.role!=='user').at(-1)?.content;
      trace.end({status:result?.status,reply,...counts()},result?.status==='failed');
    }
  }
  function kick(taskId:string) {
    if(closing || active.has(taskId) || !store.messages(taskId).some(m=>m.role==='user' && m.runId===null)) return;
    const runId=`run_${randomUUID()}`,controller=new AbortController();
    insertRun(db,runId,taskId,Date.now());
    store.bindPending(taskId,runId);
    // Defer work until the active lock is installed.
    const promise=Promise.resolve().then(()=>run(taskId,runId,controller)).finally(()=>{active.delete(taskId);kick(taskId);});
    active.set(taskId,{controller,promise});
  }
  return {
    createTask(title:string,clientId:string) { if(closing) throw new Error('服务正在关闭'); return store.createTask(title,clientId); },
    listTasks:()=>store.listTasks(),
    status:()=>model.status(),
    send(taskId:string,text:string,clientId:string) {
      if(closing) throw new Error('服务正在关闭');
      if(!text.trim() || text.length>12000) throw new Error('消息长度必须为 1–12000 字符');
      const message=store.addMessage(taskId,'user',text.trim(),clientId);
      kick(taskId);
      return message;
    },
    detail(taskId:string) {
      const task=store.requireTask(taskId),runs=listRuns(db,taskId);
      return {task,messages:store.messages(taskId),runs,sources:store.sources(taskId),events:runs[0]?listEvents(db,runs[0].runId):[],report:runs[0]?getReport(db,runs[0].runId):null};
    },
    cancel(taskId:string) { store.requireTask(taskId); const job=active.get(taskId); if(!job) return false; job.controller.abort(); return true; },
    async close() { closing=true; const jobs=[...active.values()]; jobs.forEach(j=>j.controller.abort()); await Promise.allSettled(jobs.map(j=>j.promise)); },
  };
}
export type LiveService=ReturnType<typeof createLiveService>;
