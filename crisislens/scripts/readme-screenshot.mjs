import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve('web/dist');
const server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+(req.url==='/'?'/index.html':req.url));if(!path.startsWith(root))throw Error();const body=await readFile(path);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(path)]||'application/octet-stream');res.end(body);}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(8799,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try {
const page=await browser.newPage({viewport:{width:1536,height:1000},deviceScaleFactor:1});
const now=new Date('2026-01-01T10:30:00+08:00').getTime();
const task={taskId:'demo',userTask:'演示 · 青禾产品反馈调查',createdAt:now,latestStatus:'completed',evidenceCount:2};
const markdown='## 初步调查结论\n\n**以下为合成演示数据，不涉及真实事件。**\n\n现有材料记录了产品反馈，但尚不足以判断问题是否涉及全部批次。建议把消费者反馈与企业披露分开核验。\n\n### 已获得的线索\n\n- 示例公告说明已启动批次核查。[S1]\n- 示例反馈记录提供了待核验线索。[S2]\n\n### 仍需核实\n\n补充独立检测材料，确认反馈时间、批次与处理范围。当前不能据此作出系统性质量问题的判断。';
const detail={task,messages:[{id:'u',role:'user',content:'这是一个演示任务：请整理青禾产品反馈的公开材料，区分已知信息与待核实问题。',createdAt:now,runId:'r1'},{id:'a',role:'assistant',content:markdown,createdAt:now+60000,runId:'r1'}],sources:[{id:'S1',runId:'r1',title:'示例企业公告 · 批次核查说明',url:'https://example.com/notice',content:'【合成演示材料】企业已启动批次核查。核查范围和结果仍需后续补充，不能由此推断所有产品均存在问题。',retrievedAt:now},{id:'S2',runId:'r1',title:'示例反馈记录 · 待核验线索',url:'https://example.com/feedback',content:'【合成演示材料】记录消费者反馈的时间、产品批次和处理进度。反馈陈述不等于独立检测结论。',retrievedAt:now}],runs:[{runId:'r1',status:'completed',startedAt:now,stopReason:'partial_delivery',errorMessage:null}],events:[],report:{markdown,status:'partial'}};
await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path.endsWith('/status')?{connected:true,model:'API 模型',models:['API 模型']}:path.endsWith('/tasks')?{tasks:[task]}:detail});});
await page.addInitScript(()=>localStorage.setItem('crisislens.task','demo'));
await page.goto('http://127.0.0.1:8799');await page.getByRole('heading',{name:'初步调查结论'}).waitFor();await page.getByText('示例企业公告 · 批次核查说明 ↗',{exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);
await page.screenshot({path:'../docs/images/workbench.png',fullPage:true});
} finally {await browser.close();server.close();}
