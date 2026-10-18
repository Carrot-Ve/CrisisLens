import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LiveService } from './service.ts';

function json(res:ServerResponse,status:number,data:unknown) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(data));
}
async function body(req:IncomingMessage):Promise<Record<string,unknown>> {
  const chunks:Buffer[]=[];
  let size=0;
  for await(const chunk of req) {
    size+=(chunk as Buffer).length;
    if(size>64000) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('请求体需要 JSON 对象');
  return value as Record<string,unknown>;
}
function field(b:Record<string,unknown>,key:string,max:number):string {
  const value=b[key];
  if(typeof value!=='string' || !value.trim() || value.length>max) throw new Error(`${key} 长度需为 1–${max}`);
  return value.trim();
}
export async function liveRoute(req:IncomingMessage,res:ServerResponse,url:URL,service:LiveService):Promise<void> {
  const parts=url.pathname.split('/').filter(Boolean).slice(2);
  const method=req.method;
  // No wildcard CORS on live endpoints. Browser writes require a local same-origin UI.
  const origin=req.headers.origin;
  if(method==='POST' && origin) {
    const allowed=new Set([`http://${req.headers.host}`, 'http://127.0.0.1:5173','http://localhost:5173']);
    if(!allowed.has(origin)) { json(res,403,{error:'禁止跨站写入'}); return; }
  }
  try {
    if(parts[0]==='status' && method==='GET') { json(res,200,await service.status()); return; }
    if(parts[0]==='tasks' && parts.length===1) {
      if(method==='GET') { json(res,200,{tasks:service.listTasks()}); return; }
      if(method==='POST') { const b=await body(req); json(res,201,{task:service.createTask(field(b,'title',12000),field(b,'clientId',128))}); return; }
    }
    if(parts[0]==='tasks' && parts[1]) {
      const id=parts[1];
      if(parts.length===2 && method==='GET') { json(res,200,service.detail(id)); return; }
      if(parts.length===3 && method==='POST') {
        if(parts[2]==='messages') { const b=await body(req); json(res,202,{message:service.send(id,field(b,'content',12000),field(b,'clientId',128))}); return; }
        if(parts[2]==='cancel') { const cancelled=service.cancel(id); json(res,cancelled?200:409,cancelled?{cancelled}:{error:'没有进行中的调查'}); return; }
      }
    }
    json(res,404,{error:'未知接口'});
  } catch(error) {
    const message=error instanceof Error?error.message:String(error);
    json(res,message==='任务不存在'?404:400,{error:message});
  }
}
