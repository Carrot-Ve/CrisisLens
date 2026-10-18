import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApiModel} from '../src/live/api-model.ts';
const context={objective:'帮助',messages:[],sources:[],observations:[],remainingSteps:8,date:'2026-01-01'};
test('API adapter sends authentication and parses usage; status does not reveal model ID',async()=>{
 const original=globalThis.fetch;const calls:any[]=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json(String(url).endsWith('/models')?{data:[{id:'private-model'}]}:{choices:[{message:{content:'{"action":"clarify","text":"说明"}'}}],usage:{prompt_tokens:12,completion_tokens:7}});};
 try{const model=createApiModel({baseUrl:'https://api.example.com/v1',apiKey:'test-key',model:'private-model'});const r=await model.decide(context,new AbortController().signal);assert.equal(calls[0].url,'https://api.example.com/v1/chat/completions');assert.equal(calls[0].init.headers.Authorization,'Bearer test-key');assert.equal(JSON.parse(calls[0].init.body).model,'private-model');assert.equal(r.usage.inputTokens,12);assert.equal(r.usage.outputTokens,7);assert.equal((await model.status()).model,'API 模型');assert.equal(model.name,'API 模型');}finally{globalThis.fetch=original;}
});
test('missing settings fail before network; upstream error body never exposes credentials',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('private-key-and-model',{status:401});};
 try{const missing=createApiModel({baseUrl:'',apiKey:'',model:''});assert.equal((await missing.status()).connected,false);await assert.rejects(missing.decide(context,new AbortController().signal),/配置/);assert.equal(calls,0);const model=createApiModel({baseUrl:'https://api.example.com/v1',apiKey:'private-key',model:'private-model'});await assert.rejects(model.decide(context,new AbortController().signal),e=>e instanceof Error&&e.message==='模型 API HTTP 401');}finally{globalThis.fetch=original;}
});
