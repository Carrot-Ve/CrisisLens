import type { ModelContext } from './types.ts';

/** A conservative complete-input character budget; latest user instructions are never sliced. */
export function boundedContext(input:ModelContext):ModelContext {
  const max=18000;
  const latest=input.messages.at(-1);
  const result:ModelContext={...input,objective:input.objective.slice(0,1200),messages:latest?[{...latest}]:[],sources:[],observations:[]};
  const fits=()=>JSON.stringify(result).length<=max;
  // Preserve recent revisions before spending budget on long web pages.
  let priorChars=0;
  for(const message of input.messages.slice(0,-1).reverse()) {
    if(priorChars+message.content.length>4500)continue;
    result.messages.unshift(message);
    if(!fits()){result.messages.shift();continue;}
    priorChars+=message.content.length;
  }
  for(const observation of input.observations.slice(-6).reverse()) {
    let bounded=observation.slice(0,1800);
    try {
      const search=JSON.parse(observation) as {search?:string;results?:{url:string;title:string;snippet:string}[]};
      if(search.search && Array.isArray(search.results)) {
        const results=search.results.map(h=>({...h,snippet:h.snippet.slice(0,120)}));
        while(results.length>1 && JSON.stringify({search:search.search,results}).length>5500) results.pop();
        bounded=JSON.stringify({search:search.search,results});
      }
    } catch { /* ordinary tool status */ }
    result.observations.unshift(bounded);
    if(!fits()){result.observations.shift();break;}
  }
  for(const source of input.sources.slice().reverse()) {
    const remaining=max-JSON.stringify(result).length-400;
    if(remaining<100)break;
    const copy={...source,content:source.content.slice(0,Math.min(5000,remaining))};
    result.sources.unshift(copy);
    while(!fits() && copy.content.length>100)copy.content=copy.content.slice(0,-200);
    if(!fits())result.sources.shift();
  }
  return result;
}
