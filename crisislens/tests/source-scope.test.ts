import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/storage/db.ts';
import {createLiveService} from '../src/live/service.ts';
import {explicitEventSubject,sourceMatchesSubject} from '../src/live/source-scope.ts';
import type {Decision,ModelContext} from '../src/live/types.ts';

test('明确事件主体不允许无关网页成为证据',()=>{
  assert.equal(explicitEventSubject('调查姜萍事件是否存在造假'),'姜萍');
  assert.equal(explicitEventSubject('调查2024年的胖猫事件'),'胖猫');
  assert.equal(explicitEventSubject('接着分析争议点'),null);
  assert.equal(sourceMatchesSubject('姜萍',{title:'胖猫事件',content:'警方通报胖猫事件详情'}),false);
});

test('同任务切换事件必须重新读取：旧来源引用和无关新网页都被拒绝',async()=>{
  const db=openDb(':memory:');
  const contexts:ModelContext[]=[];
  const actions:Decision[]=[
    {action:'search',query:'胖猫'}, {action:'read',url:'https://old.example/a'},
    {action:'answer',text:'胖猫材料。[S1]',citations:[{sourceId:'S1',quote:'胖猫事件原文'}]},
    {action:'answer',text:'姜萍材料。[S1]',citations:[{sourceId:'S1',quote:'胖猫事件原文'}]},
    {action:'search',query:'姜萍'}, {action:'read',url:'https://old.example/a'},
    {action:'read',url:'https://new.example/a'},
    {action:'answer',text:'姜萍材料。[S1]',citations:[{sourceId:'S1',quote:'胖猫事件原文'}]},
    {action:'answer',text:'姜萍材料。[S2]',citations:[{sourceId:'S2',quote:'姜萍事件原文'}]},
  ];
  const service=createLiveService(db.raw,{model:{name:'test',async status(){return {connected:true,model:'test',models:['test']};},async decide(input){contexts.push(input);return {decision:actions.shift()!,usage:{inputTokens:1,outputTokens:1,durationMs:1}};}},web:{async search(){return [{url:'https://old.example/a',title:'胖猫',snippet:''},{url:'https://new.example/a',title:'姜萍',snippet:''}];},async read(url){return {url,title:url.includes('old')?'胖猫事件':'姜萍事件',content:url.includes('old')?'胖猫事件原文':'姜萍事件原文'};}}});
  const wait=async(id:string)=>{for(let i=0;i<100;i++){if(service.detail(id).runs[0]?.status!=='running')return;await new Promise(r=>setTimeout(r,10));}assert.fail('timeout');};
  try {
    const t=service.createTask('调查胖猫事件','task');
    service.send(t.taskId,'调查胖猫事件','first');await wait(t.taskId);
    service.send(t.taskId,'调查姜萍事件是否存在造假','second');await wait(t.taskId);
    assert.equal(contexts[3]?.sources.length,0);
    assert.equal(contexts[3]?.objective,'调查姜萍事件是否存在造假');
    assert.deepEqual(contexts[3]?.messages,[{role:'user',content:'调查姜萍事件是否存在造假'}]);
    const d=service.detail(t.taskId);
    assert.equal(d.runs[0]?.status,'completed');
    assert.equal(d.sources.length,2);
    assert.match(d.report!.markdown,/new.example/);
    assert.doesNotMatch(d.report!.markdown,/old.example|胖猫/);
    assert.ok(d.events.some(e=>e.payload.includes('本轮尚无可引用证据')));
    assert.ok(d.events.some(e=>e.payload.includes('拒绝作为本轮证据')));
    assert.ok(d.events.filter(e=>e.type==='validation_failed').length>=2);
    actions.push({action:'search',query:'姜萍 后续'}, {action:'read',url:'https://old.example/a'}, {action:'read',url:'https://new.example/a'}, {action:'answer',text:'继续核验。[S3]',citations:[{sourceId:'S3',quote:'姜萍事件原文'}]});
    service.send(t.taskId,'继续核实争议点','third');await wait(t.taskId);
    const follow=service.detail(t.taskId);
    assert.equal(follow.runs[0]?.status,'completed');
    assert.ok(follow.events.some(e=>e.payload.includes('拒绝作为本轮证据')));
    assert.ok(contexts.filter(c=>c.objective==='继续核实争议点').every(c=>!JSON.stringify(c.messages).includes('胖猫')));
    assert.doesNotMatch(follow.report!.markdown,/old.example|胖猫/);
  } finally {await service.close();db.close();}
});
