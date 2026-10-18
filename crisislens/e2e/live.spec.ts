import { test, expect } from '@playwright/test';

test('对话创建、追问、刷新恢复与报告引用',async({page})=>{
  const messages:object[]=[];
  const task={taskId:'ui-live-task',userTask:'调查公开事件',createdAt:Date.now(),latestStatus:'completed',evidenceCount:1};
  let created=false;
  await page.route('**/api/live/**',async route=>{
    const url=new URL(route.request().url()),method=route.request().method();
    const detail={task,messages,sources:[{id:'S1',runId:'r1',title:'官方原文',url:'https://example.com',content:'官方公开原文待核实。',retrievedAt:Date.now()}],runs:[{runId:'r1',status:'completed',startedAt:Date.now(),stopReason:'partial_delivery'}],events:[],report:{markdown:'## 调查结果\n结论有待核验。[S1]\n\n[官方原文](https://example.com)',status:'partial'}};
    if(url.pathname.endsWith('/status'))return route.fulfill({json:{connected:true,model:'demo-model',models:['demo-model']}});
    if(url.pathname.endsWith('/messages')){const body=route.request().postDataJSON();messages.push({id:crypto.randomUUID(),role:'user',content:body.content,createdAt:Date.now(),runId:'r1'},{id:crypto.randomUUID(),role:'assistant',content:'已根据你的范围核实材料，保留未知项。[S1]',createdAt:Date.now(),runId:'r1'});return route.fulfill({status:202,json:{message:messages.at(-2)}});}
    if(url.pathname.endsWith('/tasks')){if(method==='POST'){created=true;return route.fulfill({status:201,json:{task}});}return route.fulfill({json:{tasks:created?[task]:[]}});}
    return route.fulfill({json:detail});
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:/从一个问题开始/})).toBeVisible();
  await page.getByRole('textbox',{name:'调查消息'}).fill('调查公开事件');
  await page.getByRole('button',{name:'发送消息'}).click();
  await expect(page.getByLabel('调查对话').getByText('已根据你的范围核实材料，保留未知项。')).toBeVisible();
  await page.getByRole('textbox',{name:'调查消息'}).fill('只关注官方回应');
  await page.getByRole('button',{name:'发送消息'}).click();
  await expect(page.getByLabel('调查对话').getByText('只关注官方回应')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('调查对话').getByText('只关注官方回应')).toBeVisible();
  await page.getByRole('tab',{name:'报告',exact:true}).click();
  await expect(page.getByRole('heading',{name:'调查结果'})).toBeVisible();
  await expect(page.getByRole('link',{name:'官方原文 ↗'})).toHaveAttribute('href','https://example.com');
});

test('窄屏任务栏和工作台可切换，输入框可见且无横向溢出',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await expect(page.getByRole('textbox',{name:'调查消息'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.getByRole('button',{name:'打开任务列表'}).click();
  await expect(page.getByRole('button',{name:'新建调查',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'关闭任务列表'}).click();
  await page.getByRole('button',{name:'打开调查工作台'}).click();
  await expect(page.getByRole('heading',{name:'调查工作台'})).toBeVisible();
  await page.getByRole('button',{name:'收起工作台'}).click();
  await expect(page.getByRole('textbox',{name:'调查消息'})).toBeVisible();
});

test('慢请求完成不会清除新输入的草稿',async({page})=>{
  let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  const task={taskId:'draft-test',userTask:'第一条消息',createdAt:Date.now()};
  await page.route('**/api/live/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/status'))return route.fulfill({json:{connected:true,model:'test',models:['test']}});
    if(path.endsWith('/messages')){await gate;return route.fulfill({status:202,json:{}});}
    if(path.endsWith('/tasks'))return route.fulfill({json:route.request().method()==='POST'?{task}:{tasks:[]}});
    return route.fulfill({json:{task,messages:[],runs:[],sources:[],events:[],report:null}});
  });
  await page.goto('/');
  const input=page.getByRole('textbox',{name:'调查消息'});
  await input.fill('第一条消息');
  const submitted=page.waitForRequest(r=>r.url().endsWith('/messages'));
  await page.getByRole('button',{name:'发送消息'}).click();
  await submitted;
  await input.fill('尚未发送的新草稿');
  release();
  await expect(page.getByRole('button',{name:'发送消息'})).toBeEnabled();
  await expect(input).toHaveValue('尚未发送的新草稿');
});
