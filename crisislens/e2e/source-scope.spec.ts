import {test,expect} from '@playwright/test';
test('来源与报告随轮次切换，加载历史报告时不显示上一轮内容',async({page})=>{
 const task={taskId:'scope-ui',userTask:'调查甲事件',createdAt:1};
 const sources=[{id:'S1',runId:'r1',title:'甲事件原文',url:'https://example.com/a',content:'甲事件资料',retrievedAt:1},{id:'S2',runId:'r2',title:'乙事件原文',url:'https://example.com/b',content:'乙事件资料',retrievedAt:2}];
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/runs/r1/detail'){await gate;return route.fulfill({json:{events:[],report:{markdown:'历史甲事件报告',status:'partial'}}});}
  if(path.endsWith('/status'))return route.fulfill({json:{connected:true,model:'test',models:['test']}});
  if(path.endsWith('/tasks'))return route.fulfill({json:{tasks:[task]}});
  return route.fulfill({json:{task,messages:[],sources,runs:[{runId:'r2',status:'completed',startedAt:2},{runId:'r1',status:'completed',startedAt:1}],events:[],report:{markdown:'最新乙事件报告',status:'partial'}}});
 });
 await page.addInitScript(()=>localStorage.setItem('crisislens.task','scope-ui'));
 await page.goto('/');
 await expect(page.getByRole('link',{name:'乙事件原文 ↗',exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'甲事件原文 ↗',exact:true})).toHaveCount(0);
 await page.getByRole('tab',{name:'报告',exact:true}).click();
 await expect(page.getByText('最新乙事件报告',{exact:true})).toBeVisible();
 await page.getByLabel('调查轮次',{exact:true}).selectOption('r1');
 await expect(page.getByText('最新乙事件报告',{exact:true})).toHaveCount(0);
 release();await expect(page.getByText('历史甲事件报告',{exact:true})).toBeVisible();
 await page.getByRole('tab',{name:/^来源/}).click();
 await expect(page.getByRole('link',{name:'甲事件原文 ↗',exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'乙事件原文 ↗',exact:true})).toHaveCount(0);
 await page.getByLabel('调查轮次',{exact:true}).selectOption('r2');
 await expect(page.getByRole('link',{name:'乙事件原文 ↗',exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'报告',exact:true}).click();
 await expect(page.getByText('最新乙事件报告',{exact:true})).toBeVisible();
 await expect(page.getByText('历史甲事件报告',{exact:true})).toHaveCount(0);
});
