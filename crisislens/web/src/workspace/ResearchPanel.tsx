import { useState } from 'react';
import type { Detail, Event, Report } from './api';
import { eventText } from './api';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

export function ResearchPanel({detail,events,report,runId,onRun,onClose}:{detail:Detail|null;events:Event[];report:Report|null;runId:string;onRun:(id:string)=>void;onClose:()=>void}) {
  const [tab,setTab]=useState<'sources'|'progress'|'report'>('sources');
  const [notice,setNotice]=useState('');
  const sources=detail?.sources ?? [];
  const progress=events.filter(e=>eventText(e));
  function download() {
    if(!report) return;
    const url=URL.createObjectURL(new Blob([report.markdown],{type:'text/markdown;charset=utf-8'}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download='CrisisLens-调查报告.md';anchor.click();URL.revokeObjectURL(url);
  }
  return <>
    <div className="rp-heading"><div><span className="eyebrow">RESEARCH DESK</span><h2>调查工作台</h2></div><button className="icon-btn" onClick={onClose} aria-label="收起工作台"><Icon name="panel"/></button></div>
    <div className="rp-tabs" role="tablist" aria-label="调查资料">
      <button role="tab" aria-selected={tab==='sources'} onClick={()=>setTab('sources')}>来源 <span>{sources.length}</span></button>
      <button role="tab" aria-selected={tab==='progress'} onClick={()=>setTab('progress')}>进度</button>
      <button role="tab" aria-selected={tab==='report'} onClick={()=>setTab('report')}>报告</button>
    </div>
    <div className="rp-body">
      {detail && detail.runs.length>0 && <label className="run-select">调查轮次<select aria-label="调查轮次" value={runId} onChange={e=>onRun(e.target.value)}>{detail.runs.map((r,i)=><option key={r.runId} value={r.runId}>第 {detail.runs.length-i} 轮 · {new Date(r.startedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} · {{running:'进行中',completed:'已结束',failed:'失败',cancelled:'已停止'}[r.status]}</option>)}</select></label>}
      {tab==='sources' && <>
        {sources.length===0?<div className="panel-empty"><div className="empty-orbit"><Icon name="globe" size={30}/></div><h3>让每个判断，都有出处</h3><p>调查开始后，实际读取的网页会出现在这里。搜索摘要不会被当作证据。</p><div className="source-skeleton"><i/><i/><i/></div></div>:<><p className="panel-note">本任务已读取 {sources.length} 个来源，跨轮次保留。来源存在不代表其说法已获证实。</p>{sources.map(s=><article className="source-card" key={s.id}><div className="source-meta"><span>{s.id}</span><span>{new URL(s.url).hostname}</span></div><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title} ↗</a><p>{s.content.slice(0,160)}{s.content.length>160?'…':''}</p><details><summary>查看已读取原文</summary><div className="source-full">{s.content}</div></details><time>获取于 {new Date(s.retrievedAt).toLocaleString('zh-CN')}</time></article>)}</>}
      </>}
      {tab==='progress' && <div className="timeline">{progress.length?progress.map(e=><div key={e.sequence} className={`timeline-item ${e.type.includes('fail')?'is-error':''}`}><i/><div><p>{eventText(e)}</p><time>{new Date(e.timestamp).toLocaleTimeString('zh-CN')}</time></div></div>):<div className="panel-empty"><Icon name="clock" size={30}/><h3>调查过程，清晰可见</h3><p>搜索、读取和分析的真实执行记录将在此展示。</p></div>}</div>}
      {tab==='report' && (report?<><div className="report-actions"><span className="review-badge">待人工复核</span><button className="icon-btn" aria-label="复制报告" onClick={()=>{void navigator.clipboard.writeText(report.markdown).then(()=>setNotice('已复制')).catch(()=>setNotice('复制失败，请下载报告'));}}><Icon name="copy"/></button><button className="icon-btn" aria-label="下载报告" onClick={download}><Icon name="download"/></button></div>{notice && <p role="status">{notice}</p>}<Markdown text={report.markdown}/></>:<div className="panel-empty"><Icon name="doc" size={30}/><h3>从资料到有依据的结论</h3><p>完成本轮分析后，这里会呈现报告、来源引用与仍待核实的问题。</p></div>)}
    </div>
    <div className="rp-footer"><Icon name="check" size={14}/> 原文可追溯 · 判断需复核</div>
  </>;
}
