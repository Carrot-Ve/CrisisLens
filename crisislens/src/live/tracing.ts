import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { startObservation, setLangfuseTracerProvider, type LangfuseSpan } from '@langfuse/tracing';

let provider:NodeTracerProvider|undefined;
const safely=(work:()=>void)=>{try{work();}catch{console.warn('Langfuse observation could not be recorded');}};
export function initializeTracing() {
  if(provider || !process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)return;
  const baseUrl=process.env.LANGFUSE_BASE_URL;
  if(!baseUrl)throw new Error('LANGFUSE_BASE_URL is required; no cloud fallback');
  provider=new NodeTracerProvider({spanProcessors:[new LangfuseSpanProcessor({baseUrl,publicKey:process.env.LANGFUSE_PUBLIC_KEY,secretKey:process.env.LANGFUSE_SECRET_KEY})]});
  setLangfuseTracerProvider(provider);
}
export async function flushTracing(){await provider?.forceFlush();}
export async function shutdownTracing(){await provider?.shutdown();provider=undefined;setLangfuseTracerProvider(null);}

export function createRunTrace(taskId:string,runId:string,enabled=Boolean(provider)) {
  let root:LangfuseSpan|undefined;
  if(enabled)safely(()=>{root=startObservation('crisislens.investigation',{metadata:{taskId,runId}});root.otelSpan.setAttribute('session.id',taskId);});
  return {
    id:root?.traceId,
    input(value:unknown){safely(()=>{root?.update({input:value});});},
    event(name:string,value:Record<string,unknown>){safely(()=>{root?.startObservation(name,{input:value,level:/failed/.test(name)?'ERROR':'DEFAULT'},{asType:'event'});});},
    async observe<T>(name:string,kind:'generation'|'tool',input:unknown,operation:()=>Promise<T>,model?:string):Promise<T> {
      let child:ReturnType<LangfuseSpan['startObservation']>|undefined;
      safely(()=>{child=kind==='generation'?root?.startObservation(name,{input,model,metadata:{taskId,runId}},{asType:'generation'}):root?.startObservation(name,{input,metadata:{taskId,runId}},{asType:'tool'});child?.otelSpan.setAttribute('session.id',taskId);});
      try {
        const result=await operation();
        safely(()=>{
          child?.update({output:result});
          const usage=(result as {usage?:{inputTokens:number;outputTokens:number}})?.usage;
          if(kind==='generation' && usage)child?.otelSpan.setAttribute('langfuse.observation.usage_details',JSON.stringify({input:usage.inputTokens,output:usage.outputTokens}));
        });
        return result;
      } catch(error){safely(()=>{child?.update({level:'ERROR',statusMessage:error instanceof Error?error.message:String(error)});});throw error;}
      finally{safely(()=>{child?.end();});}
    },
    end(output:unknown,failed=false){safely(()=>{root?.update({output,level:failed?'ERROR':'DEFAULT'});root?.end();});},
  };
}
