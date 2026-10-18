import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApiModel} from '../src/live/api-model.ts';
import type {ModelContext} from '../src/live/types.ts';

test('模型约束推进读取、排除失败链接，引用只可选真实原文，最新问题保持明确',async()=>{
  const original=globalThis.fetch;
  const requests:any[]=[];
  globalThis.fetch=async (_url,init)=>{
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(requests.length===1?{action:'clarify',text:'能力说明'}:{action:'read',url:'https://example.com/b',text:'读取'})}}]}));
  };
  try {
    const model=createApiModel({baseUrl:'https://api.example.com/v1',apiKey:'test-key',model:'test-model'});
    const context:ModelContext={objective:'旧目标',messages:[{role:'user',content:'那可以查什么啊？'}],observations:[],sources:[],remainingSteps:8,date:'2026-10-15'};
    await model.decide(context,new AbortController().signal);
    assert.match(requests[0].messages.at(-1).content,/本轮真正需要回答的用户消息：那可以查什么啊/);
    assert.ok(!JSON.parse(requests[0].messages[0].content.split('输出必须符合以下 JSON Schema：')[1]).properties.action.enum.includes('answer'));
    context.observations=[JSON.stringify({search:'事件',results:[{url:'https://example.com/a',snippet:'网恋失败'},{url:'https://example.com/b',snippet:'调用失败事故调查'}]}),'读取 https://example.com/a 失败：超时'];
    await model.decide(context,new AbortController().signal);
    assert.deepEqual(JSON.parse(requests[1].messages[0].content.split('输出必须符合以下 JSON Schema：')[1]).properties.action.enum,['read']);
    assert.deepEqual(JSON.parse(requests[1].messages[0].content.split('输出必须符合以下 JSON Schema：')[1]).properties.url.enum,['https://example.com/b']);
    context.sources=[{id:'S1',runId:'r',url:'https://example.com/b',title:'来源',content:'此处是已经读取的真实连续原文。不得把改写的句子当成引文。',hash:'h',retrievedAt:1}];
    await model.decide(context,new AbortController().signal);
    for(const quote of JSON.parse(requests[2].messages[0].content.split('输出必须符合以下 JSON Schema：')[1]).properties.citations.items.anyOf[0].properties.quote.enum) assert.ok(context.sources[0]!.content.includes(quote));
  } finally {globalThis.fetch=original;}
});
