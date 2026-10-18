import { chromium } from 'playwright';
import { mkdirSync,writeFileSync } from 'node:fs';
mkdirSync('artifacts',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try {
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8787/');
  await page.getByRole('textbox',{name:'调查消息'}).fill('接入验证：请读取 https://www.iana.org/help/example-domains ，核实 模型 API 是否支持工具调用，只用两句话回答并附原文引用。');
  await page.getByRole('button',{name:'发送消息'}).click();
  await page.locator('.message-assistant').waitFor({timeout:180000});
  const taskId=await page.evaluate(()=>localStorage.getItem('crisislens.task'));
  const first=await (await fetch(`http://127.0.0.1:8787/api/live/tasks/${taskId}`)).json();
  if(!first.report || !first.sources.length)throw new Error('首轮未产出真实来源与报告');
  console.log('首轮通过',taskId,first.sources.map(s=>s.url));
  await page.getByRole('textbox',{name:'调查消息'}).fill('根据刚才读取的原文，工具调用结果会用于什么？请用一句话回答，沿用原文引用。');
  await page.getByRole('button',{name:'发送消息'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.message-assistant').length>=2,{},{timeout:180000});
  await page.getByRole('tab',{name:'报告',exact:true}).click();
  await page.screenshot({path:'artifacts/ui-investigation.png',fullPage:true});
  await page.reload();
  await page.locator('.message-assistant').first().waitFor();
  const result=await (await fetch(`http://127.0.0.1:8787/api/live/tasks/${taskId}`)).json();
  writeFileSync('artifacts/live-ui-smoke.json',JSON.stringify({taskId,errors,...result},null,2));
  console.log(JSON.stringify({taskId,errors,runs:result.runs.map(r=>({status:r.status,reason:r.stopReason})),sources:result.sources.length,assistantMessages:result.messages.filter(m=>m.role==='assistant').length,report:result.report?.markdown}));
  if(errors.length || result.runs.some(r=>r.status!=='completed'))process.exitCode=1;
} finally {await browser.close();}
