import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, eventText } from './api';
import type { Detail, Task, Status, Event, Report } from './api';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ResearchPanel } from './ResearchPanel';
import './workspace.css';

const suggestions=[{icon:'globe',title:'核实一则事件',description:'梳理时间线，区分事实与传言',prompt:'我想调查一个舆情事件，请先帮我明确调查范围。'}, {icon:'doc',title:'分析已有材料',description:'提供链接，提取事实与证据',prompt:'我有一些公开网页材料，需要你分析其中的事实、冲突和未知项。'}, {icon:'search',title:'追踪企业动态',description:'查找近期报道与官方回应',prompt:'我想了解一家企业近期的舆情和官方回应。'}];
function storedTask() { try { return localStorage.getItem('crisislens.task') ?? ''; } catch { return ''; } }
function saveTask(id:string) { try { localStorage.setItem('crisislens.task',id); } catch { /* storage unavailable */ } }

export function Workspace() {
  const [tasks,setTasks]=useState<Task[]>([]),[taskId,setTaskId]=useState(storedTask);
  const [detail,setDetail]=useState<Detail|null>(null),[status,setStatus]=useState<Status|null>(null);
  const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[error,setError]=useState('');
  const [sending,setSending]=useState(false),[sidebar,setSidebar]=useState(false),[panel,setPanel]=useState(()=>window.innerWidth>960);
  const [selectedRun,setSelectedRun]=useState(''),[past,setPast]=useState<{events:Event[];report:Report|null}|null>(null);
  const bottom=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),viewId=useRef(taskId);
  const requestId=useRef<{text:string;id:string}|null>(null),createId=useRef(crypto.randomUUID());
  const busy=detail?.runs.some(r=>r.status==='running') ?? false;
  const latest=detail?.runs[0];
  const runId=selectedRun || latest?.runId || '';
  const progress=(detail?.events ?? []).filter(e=>eventText(e));
  const pending=detail?.messages.filter(m=>m.role==='user' && m.runId===null).length ?? 0;
  const activeRun=detail?.runs.find(r=>r.status==='running');
  useEffect(()=>{
    let alive=true;
    const load=()=>{void api<{tasks:Task[]}>('/tasks').then(d=>{if(alive)setTasks(d.tasks);}).catch(e=>{if(alive)setError(String(e.message));});};
    load();const timer=setInterval(load,3500);
    void api<Status>('/status').then(s=>{if(alive)setStatus(s);}).catch(e=>{if(alive)setStatus({connected:false,model:'模型 API',models:[],error:String(e.message)});});
    return ()=>{alive=false;clearInterval(timer);};
  },[]);
  useEffect(()=>{
    viewId.current=taskId;saveTask(taskId);setDetail(null);setSelectedRun('');setPast(null);setError('');
    if(!taskId)return;
    let alive=true,timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try {const next=await api<Detail>(`/tasks/${taskId}`);if(alive)setDetail(next);}
      catch(e){if(alive)setError(e instanceof Error?e.message:String(e));}
      finally {if(alive)timer=setTimeout(()=>void load(),1200);}
    };
    void load();return()=>{alive=false;clearTimeout(timer);};
  },[taskId]);
  useEffect(()=>{
    let alive=true;setPast(null);
    if(selectedRun && selectedRun!==latest?.runId) void fetch(`/api/runs/${selectedRun}/detail`).then(async r=>{if(!r.ok)throw new Error('无法加载历史轮次');return r.json();}).then(d=>{if(alive)setPast(d);}).catch(e=>{if(alive)setError(e.message);});
    return()=>{alive=false;};
  },[selectedRun,latest?.runId]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:'smooth',block:'end'});},[detail?.messages.length,taskId]);
  function select(id:string) {viewId.current=id;setTaskId(id);setSidebar(false);setDraft('');requestId.current=null;}
  function fresh() {select('');createId.current=crypto.randomUUID();input.current?.focus();}
  async function send(event:FormEvent) {
    event.preventDefault();const text=draft.trim();if(!text || sending)return;
    setSending(true);setError('');let id=taskId;
    if(requestId.current?.text!==text)requestId.current={text,id:crypto.randomUUID()};
    const messageId=requestId.current.id;
    try {
      if(!id) {const result=await api<{task:Task}>('/tasks',{title:text,clientId:createId.current});id=result.task.taskId;viewId.current=id;setTaskId(id);saveTask(id);}
      await api(`/tasks/${id}/messages`,{content:text,clientId:messageId});
      const next=await api<Detail>(`/tasks/${id}`);
      if(viewId.current===id) {setDraft(current=>current.trim()===text?'':current);requestId.current=null;setDetail(next);}
      setTasks((await api<{tasks:Task[]}>('/tasks')).tasks);
    } catch(e) {setError(e instanceof Error?e.message:String(e));}
    finally {setSending(false);input.current?.focus();}
  }
  async function stop() {const id=taskId;try {await api(`/tasks/${id}/cancel`,{});const next=await api<Detail>(`/tasks/${id}`);if(viewId.current===id)setDetail(next);}catch(e){setError(e instanceof Error?e.message:String(e));}}
  return <div className={`workspace ${sidebar?'sidebar-open':''} ${panel?'':'panel-hidden'}`}>
    {sidebar && <button className="sidebar-scrim" aria-label="关闭任务列表" onClick={()=>setSidebar(false)}/>}
    <aside className="task-sidebar">
      <a className="brand" href="/" aria-label="CrisisLens 首页"><span className="brand-mark"><Icon name="spark" size={23}/></span><span>CrisisLens<small>让调查有据可循</small></span></a>
      <button className="new-investigation" onClick={fresh} disabled={sending}><Icon name="plus"/>新建调查<span aria-hidden="true">↗</span></button>
      <label className="task-search"><Icon name="search" size={16}/><input aria-label="搜索调查任务" placeholder="搜索调查任务" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <div className="sidebar-label">我的调查 <span>{tasks.length}</span></div>
      <nav className="task-nav" aria-label="调查任务列表">{tasks.filter(t=>t.userTask.toLowerCase().includes(query.toLowerCase())).map(t=><button key={t.taskId} disabled={sending} className={`task-item ${taskId===t.taskId?'selected':''}`} onClick={()=>select(t.taskId)} title={t.userTask}><Icon name="doc" size={16}/><span><strong>{t.userTask}</strong><small><i className={t.latestStatus==='running'?'live-dot':''}/>{t.latestStatus==='running'?'调查中':t.latestStatus==='failed'?'需要处理':new Date(t.createdAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}</small></span></button>)}{tasks.length===0 && <p className="sidebar-empty">第一份调查，从一个问题开始。</p>}</nav>
      <div className="sidebar-bottom"><div className="local-model"><span className={`connection-dot ${status?.connected?'connected':''}`}/><div><strong>{status?.model ?? '正在检查模型'}</strong><small>{status?.connected?'API 模型已连接':status?.error ?? '连接 模型 API…'}</small></div><button className="icon-btn" aria-label="刷新模型连接" onClick={()=>void api<Status>('/status').then(setStatus).catch(e=>setError(e.message))}>↻</button></div><a className="demo-link" href="/?demo=1">查看合成案例演示 ↗</a></div>
    </aside>
    <main className="conversation">
      <header className="conversation-header"><div className="header-left"><button className="icon-btn mobile-menu" aria-label="打开任务列表" onClick={()=>setSidebar(true)}><Icon name="menu"/></button><span className="breadcrumb">调查空间</span><span className="header-slash">/</span><h1>{detail?.task.userTask ?? (taskId?'正在加载调查…':'新建调查')}</h1></div><div className="header-actions"><span className="web-enabled"><Icon name="globe" size={14}/>联网调查</span><button className="icon-btn" aria-label={panel?'收起调查工作台':'打开调查工作台'} onClick={()=>setPanel(!panel)}><Icon name="panel"/></button></div></header>
      <div className="conversation-scroll">
        {!taskId?<section className="welcome"><div className="welcome-symbol"><Icon name="spark" size={32}/></div><span className="eyebrow">YOUR RESEARCH, GROUNDED.</span><h2>从一个问题开始，<br/><span>看清事件的全貌。</span></h2><p>告诉我你想调查的事件。我们一起寻找线索、核对来源，<br className="desktop-break"/>把零散的信息，整理成有依据的判断。</p><div className="suggestions">{suggestions.map(s=><button key={s.title} onClick={()=>{setDraft(s.prompt);input.current?.focus();}}><Icon name={s.icon} size={21}/><strong>{s.title}</strong><small>{s.description}</small><span>↗</span></button>)}</div><div className="welcome-method"><span>01 明确问题</span><i/><span>02 查找证据</span><i/><span>03 形成判断</span></div></section>:<div className="messages" aria-label="调查对话">{detail?.messages.map(m=><article key={m.id} className={`message message-${m.role}`}><div className="message-avatar">{m.role==='user'?'你':m.role==='system'?'!':<Icon name="spark" size={18}/>}</div><div className="message-content"><div className="message-meta"><strong>{m.role==='user'?'你':m.role==='system'?'运行提示':'CrisisLens'}</strong><time>{new Date(m.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>{m.role==='user' && !m.runId && <span className="queued">待处理</span>}</div>{m.role==='assistant'?<Markdown text={m.content}/>:<p className="plain-message">{m.content}</p>}</div></article>)}{busy && <div className="activity-card" role="status"><span className="pulse-dot"/><div><strong>{progress.at(-1)?eventText(progress.at(-1)!):'正在开始调查'}</strong><small>API 模型正在工作 · 可随时停止或补充范围{pending>0?` · ${pending} 条消息待处理`:''}</small></div><button onClick={()=>setPanel(true)} aria-label="查看调查进度"><Icon name="panel" size={16}/></button></div>}<div ref={bottom}/></div>}
      </div>
      <div className="composer-area">{error && <div className="workspace-error" role="alert">{error}<button aria-label="关闭错误提示" onClick={()=>setError('')}><Icon name="close" size={15}/></button></div>}{status && !status.connected && <div className="connection-warning">API 模型未连接：{status.error}。请配置 API 后刷新连接。</div>}<form className="composer" onSubmit={e=>void send(e)}><textarea ref={input} aria-label="调查消息" placeholder={taskId?'继续追问、补充链接，或调整调查方向…':'描述你想调查的事件，或粘贴公开网页链接…'} value={draft} maxLength={12000} rows={3} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/><div className="composer-toolbar"><span><Icon name="globe" size={15}/>公开网络<span className="toolbar-separator">·</span><Icon name="spark" size={15}/>{status?.model ?? '模型 API'}</span><div>{activeRun && <button type="button" className="stop-button" onClick={()=>void stop()}><Icon name="stop" size={13}/>停止</button>}<button type="submit" className="send-button" aria-label="发送消息" disabled={sending||!draft.trim()}><Icon name="arrow" size={19}/></button></div></div></form><div className="composer-caption"><span>对话与证据将发送至配置的模型 API，检索词发送至搜索服务。</span><span>Shift + Enter 换行</span></div></div>
    </main>
    {panel && <aside className="research-panel"><ResearchPanel detail={detail} events={past?.events ?? detail?.events ?? []} report={past?past.report:detail?.report ?? null} runId={runId} onRun={setSelectedRun} onClose={()=>setPanel(false)}/></aside>}
  </div>;
}
