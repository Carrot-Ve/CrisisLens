import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.ts';
import { createLiveStore } from '../src/live/store.ts';
import { validateDecision, verifyCitations } from '../src/live/validation.ts';
import { isPublicAddress, extractPage, parseSearch, parseRss, parseSogou, relevantHits, decodeBody } from '../src/live/web.ts';
import { gzipSync } from 'node:zlib';
import { createLiveService } from '../src/live/service.ts';
import type { LiveModel, Decision, WebTools } from '../src/live/types.ts';
import {capabilityReply} from '../src/live/help.ts';

test('能力询问不被旧事件上下文误导，也不拦截具体调查请求',()=>{
  assert.match(capabilityReply('那可以查什么啊？') ?? '',/联网搜索公开新闻/);
  assert.equal(capabilityReply('调查2024年的胖猫事件'),null);
  assert.equal(capabilityReply('可以查什么导致了此次事故吗？'),null);
});

test('消息幂等、任务隔离、pending 与运行绑定', () => {
  const db = openDb(':memory:');
  try {
    const store = createLiveStore(db.raw);
    const a = store.createTask('调查甲', 'a');
    const b = store.createTask('调查乙', 'b');
    const m = store.addMessage(a.taskId, 'user', '补充范围', 'c');
    assert.equal(store.addMessage(a.taskId, 'user', '补充范围', 'c').id, m.id);
    assert.equal(store.messages(a.taskId).length, 1);
    assert.equal(store.messages(b.taskId).length, 0);
    assert.equal(store.createTask('调查甲', 'a').taskId, a.taskId);
    assert.throws(() => store.addMessage('missing', 'user', 'x', 'z'), /任务不存在/);
  } finally { db.close(); }
});

test('拒绝非法模型动作、超长查询和伪造引用', () => {
  const clean=validateDecision({action:'answer',text:"材料说明。[S1]'}]}}",citations:[]});
  assert.equal('text' in clean && clean.text,'材料说明。[S1]');
  assert.throws(() => validateDecision({ action: 'shell', text: 'run' }), /动作/);
  assert.throws(() => validateDecision({ action: 'search', query: 'a'.repeat(501) }), /query/);
  assert.deepEqual(validateDecision({ action: 'clarify', text: '调查哪家企业？' }), { action: 'clarify', text: '调查哪家企业？' });
  const source = { id: 'S1', url: 'https://example.com', title: '标题', content: '原文表示尚待核实。', retrievedAt: 1, hash: 'h', runId: 'r' };
  assert.throws(() => verifyCitations([{ sourceId: 'S2', quote: '尚待核实' }], [source]), /来源/);
  assert.throws(() => verifyCitations([{ sourceId: 'S1', quote: '已经证实' }], [source]), /引文/);
  assert.equal(verifyCitations([{ sourceId: 'S1', quote: '尚待核实' }], [source]).length, 1);
});

test('网络工具拒绝私网、IPv6 映射及保留地址，正文排除脚本', () => {
  for (const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','0.0.0.0','100.64.0.1','::1','fc00::1','::ffff:127.0.0.1','2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const page = extractPage('<title>测试</title><script>secret()</script><nav>菜单</nav><article><p>正文 &amp; 原文</p></article>');
  assert.equal(page.title, '测试');
  assert.equal(page.content, '正文 & 原文');
  assert.throws(() => parseSearch('<html>anomaly.js challenge-form</html>'), /验证|不可用/);
  assert.equal(parseSearch('<div class="no-results">No results found</div>').length, 0);
  assert.deepEqual(parseRss('<rss><channel><item><title>官方 &amp; 文档</title><link>https://example.com/a</link><description>摘要</description></item></channel></rss>'), [{title:'官方 & 文档',url:'https://example.com/a',snippet:'摘要'}]);
  assert.throws(()=>parseRss('<html>blocked</html>'),/RSS/);
});

const web: WebTools = {
  async search() { return [{ title: '来源', url: 'https://example.com', snippet: '线索' }]; },
  async read(url) { return { url, title: '来源', content: '真实原文尚待核实。' }; },
};
test('中文检索保留完整事件词，拒绝单字词典和无关热门页面', () => {
  const compressed=gzipSync(Buffer.from('警方发布事件调查情况'));
  assert.equal(decodeBody(compressed,'gzip').toString(),'警方发布事件调查情况');
  assert.equal(decodeBody(compressed,'').toString(),'警方发布事件调查情况');
  assert.throws(()=>decodeBody(gzipSync(Buffer.alloc(3*1024*1024)), 'gzip'));
  const hits = parseSogou('<h3 class="vr-title"><a href="/link?url=abc">重庆警方<em>通报</em>胖猫事件</a></h3>');
  assert.equal(hits[0]?.url, 'https://www.sogou.com/link?url=abc');
  assert.equal(relevantHits('2024年胖猫事件', hits).length, 1);
  assert.equal(relevantHits('胖猫跳江 2024', [{url:'https://example.com',title:'胖（汉语汉字）',snippet:'胖的拼音'}]).length, 0);
  assert.equal(relevantHits('青禾酥饼异物反馈事件', [{url:'https://example.com',title:'WhatsApp',snippet:'Download'}]).length, 0);
});
const model = (decide: LiveModel['decide']): LiveModel => ({ name: 'test', decide, async status() { return { connected: true, model: 'test', models: ['test'] }; } });
const waitUntil = async (fn: () => boolean) => {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('后台运行未结束');
};

test('真实模式工具链保存消息、来源、引用与报告；后续上下文包含历史', async () => {
  const db = openDb(':memory:');
  const actions: Decision[] = [{ action: 'search', query: '测试事件' }, { action: 'read', url: 'https://example.com' }, { action: 'answer', text: '材料尚待核实。[S1]', citations: [{ sourceId: 'S1', quote: '尚待核实' }] }];
  const contexts: string[] = [];
  const service = createLiveService(db.raw, { model: model(async input => { contexts.push(JSON.stringify(input)); return { decision: actions.shift() ?? { action: 'clarify', text: '希望补充哪个方面？' }, usage: { inputTokens: 10, outputTokens: 5, durationMs: 1 } }; }), web });
  try {
    const task = service.createTask('调查测试事件', 'task-client');
    service.send(task.taskId, '调查测试事件', 'm1');
    await waitUntil(() => service.detail(task.taskId).runs[0]?.status === 'completed');
    const detail = service.detail(task.taskId);
    assert.equal(detail.sources.length, 1, JSON.stringify(detail.events));
    assert.match(detail.report?.markdown ?? '', /example.com/);
    assert.equal(detail.messages.filter(m => m.role === 'assistant').length, 1);
    service.send(task.taskId, '只看召回范围', 'm2');
    await waitUntil(() => service.detail(task.taskId).messages.filter(m => m.role === 'assistant').length === 2);
    assert.match(contexts.at(-1) ?? '', /只看召回范围/);
    assert.match(contexts.at(-1) ?? '', /尚待核实/);
  } finally { await service.close(); db.close(); }
});

test('同任务排队、取消和重启不会冒充成功', async () => {
  const db = openDb(':memory:');
  const service = createLiveService(db.raw, { model: model(async (_input, signal) => {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 40); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
    return { decision: { action: 'clarify', text: '请补充时间范围' }, usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 } };
  }), web });
  try {
    const t = service.createTask('排队测试', 'q');
    service.send(t.taskId, '第一个问题', 'm1');
    service.send(t.taskId, '追加范围', 'm2');
    assert.equal(service.detail(t.taskId).runs.filter(r => r.status === 'running').length, 1);
    service.cancel(t.taskId);
    await waitUntil(() => service.detail(t.taskId).runs.some(r => r.status === 'cancelled'));
    await waitUntil(() => service.detail(t.taskId).messages.some(m => m.role === 'assistant'));
    assert.equal(service.detail(t.taskId).messages.filter(m => m.role === 'user' && m.runId === null).length, 0);
  } finally { await service.close(); db.close(); }
});
