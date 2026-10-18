import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NodeTracerProvider,SimpleSpanProcessor,InMemorySpanExporter} from '@opentelemetry/sdk-trace-node';
import {setLangfuseTracerProvider} from '@langfuse/tracing';
import {createRunTrace} from '../src/live/tracing.ts';

test('调查追踪保存父子关系、用量、错误，并原样传播业务结果',async()=>{
  const exporter=new InMemorySpanExporter();
  const provider=new NodeTracerProvider({spanProcessors:[new SimpleSpanProcessor(exporter)]});
  setLangfuseTracerProvider(provider);
  try {
    const trace=createRunTrace('task-test','run-test',true);
    trace.input('调查目标');
    const result=await trace.observe('model','generation','问题',async()=>({usage:{inputTokens:12,outputTokens:8},text:'回答'}),'demo-model');
    assert.equal(result.text,'回答');
    await assert.rejects(trace.observe('search','tool','查询',async()=>{throw new Error('network failed');}),/network failed/);
    trace.event('validation_failed',{text:'引用不符'});
    trace.end({status:'completed'});
    await provider.forceFlush();
    const spans=exporter.getFinishedSpans();
    const root=spans.find(s=>s.name==='crisislens.investigation')!;
    assert.ok(root);
    assert.equal(root.attributes['session.id'],'task-test');
    const model=spans.find(s=>s.name==='model')!;
    assert.equal(model.attributes['session.id'],'task-test');
    assert.equal(model.parentSpanContext?.spanId,root.spanContext().spanId);
    assert.match(String(model.attributes['langfuse.observation.usage_details']),/12/);
    assert.equal(spans.find(s=>s.name==='search')?.attributes['langfuse.observation.level'],'ERROR');
    assert.ok(spans.some(s=>s.name==='validation_failed'));
  } finally {await provider.shutdown();setLangfuseTracerProvider(null);}
});

test('未启用 Langfuse 时调查工具仍正常运行',async()=>{
  const trace=createRunTrace('t','r',false);
  assert.equal(trace.id,undefined);
  assert.equal(await trace.observe('read','tool',{},async()=>42),42);
  trace.end('done');
});
