import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('artifacts',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try {
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.UI_URL ?? 'http://127.0.0.1:8787/');
  await page.getByRole('heading',{name:/从一个问题开始/}).waitFor();
  await page.screenshot({path:'artifacts/ui-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.reload();
  await page.getByRole('textbox',{name:'调查消息'}).waitFor();
  await page.screenshot({path:'artifacts/ui-mobile.png',fullPage:true});
  console.log(JSON.stringify({errors,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)}));
} finally {await browser.close();}
