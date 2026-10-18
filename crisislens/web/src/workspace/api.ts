export interface Task { taskId:string; userTask:string; createdAt:number; latestStatus:string|null; evidenceCount:number }
export interface Message { id:string; role:'user'|'assistant'|'system'; content:string; createdAt:number; runId:string|null }
export interface Source { id:string;runId:string;url:string;title:string;content:string;retrievedAt:number }
export interface Run { runId:string;status:string;errorMessage:string|null;startedAt:number;stopReason:string|null }
export interface Event { sequence:number;type:string;timestamp:number;payload:string }
export interface Report { markdown:string;status:string }
export interface Detail { task:Task;messages:Message[];sources:Source[];runs:Run[];events:Event[];report:Report|null }
export interface Status { connected:boolean;model:string;models:string[];error?:string }
export async function api<T>(path:string,body?:unknown):Promise<T> {
  const response=await fetch(`/api/live${path}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error ?? `请求失败 ${response.status}`);
  return data as T;
}
export function eventText(event:Event):string {
  try { return (JSON.parse(event.payload) as {text?:string}).text ?? ''; } catch { return ''; }
}
