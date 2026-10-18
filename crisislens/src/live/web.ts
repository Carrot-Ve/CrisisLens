import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import type { SearchHit, WebTools } from './types.ts';

export function decodeBody(bytes:Buffer, encoding:string):Buffer {
  const options={maxOutputLength:2*1024*1024};
  if(encoding==='gzip' || (bytes[0]===31 && bytes[1]===139)) return gunzipSync(bytes,options);
  if(encoding==='br') return brotliDecompressSync(bytes,options);
  if(encoding==='deflate') return inflateSync(bytes,options);
  if(encoding && encoding!=='identity') throw new Error(`不支持的正文压缩格式：${encoding}`);
  return bytes;
}

export function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a = 0,b = 0,c = 0] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a===100 && b>=64 && b<=127) ||
      (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99))) ||
      (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
  }
  if (isIP(ip) === 6) {
    // Only globally routable 2000::/3, excluding documentation / transition ranges.
    return /^[23][0-9a-f]{3}:/.test(ip) && !/^2001:(?:0:|db8:|[12][0-9a-f]:)/.test(ip) && !ip.startsWith('2002:');
  }
  return false;
}

export async function publicText(raw: string, signal: AbortSignal, redirects = 0, allowXml = false): Promise<{text:string;url:string;type:string}> {
  signal.throwIfAborted();
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('仅允许公开 HTTP(S) 网页');
  if (redirects > 4) throw new Error('网页重定向过多');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const combined = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const addresses = await abortable(lookup(hostname, { all: true, verbatim: true }),combined);
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('拒绝访问内网或保留地址');
  const chosen = addresses.find(a => a.family === 4) ?? addresses[0]!;
  const result = await new Promise<{text:string;location?:string;status:number;type:string}>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal: combined,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; CrisisLens/1.0)', accept: 'text/html,text/plain,application/xhtml+xml', 'accept-encoding': 'identity' },
      // Pin the checked address: no second DNS lookup / rebinding window.
      lookup: (_host, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [chosen]);
        else callback(null, chosen.address, chosen.family);
      },
    }, response => {
      const status = response.statusCode ?? 0;
      const type = String(response.headers['content-type'] ?? '').toLowerCase();
      if (status>=300 && status<400) { response.destroy(); resolve({text:'',location:response.headers.location,status,type}); return; }
      if (status !== 200) { response.destroy(); reject(new Error(`网页 HTTP ${status}`)); return; }
      if (!/text\/(html|plain)|application\/xhtml\+xml/.test(type) && !(allowXml && /(?:text|application)\/(?:rss\+)?xml/.test(type))) { response.destroy(); reject(new Error(`暂不支持的网页类型：${type || '未知'}（支持 HTML / 纯文本）`)); return; }
      let size=0;
      const chunks: Buffer[]=[];
      response.on('data', (chunk:Buffer) => {
        size+=chunk.length;
        if (size>2*1024*1024) { response.destroy(new Error('网页超过 2MB 限制')); return; }
        chunks.push(chunk);
      });
      response.on('error',reject);
      response.on('end', () => {
        let bytes:Buffer;
        try { bytes=decodeBody(Buffer.concat(chunks),String(response.headers['content-encoding'] ?? '').toLowerCase()); }
        catch(error) {reject(error);return;}
        const charset=/charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1] ?? /charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0,1500).toString())?.[1] ?? 'utf-8';
        try { resolve({text:new TextDecoder(charset).decode(bytes),status,type}); }
        catch { resolve({text:bytes.toString('utf8'),status,type}); }
      });
    });
    request.on('error',reject);
    request.end();
  });
  if (result.status>=300 && result.status<400) {
    if (!result.location) throw new Error('网页重定向缺少地址');
    return publicText(new URL(result.location,url).href,combined,redirects+1,allowXml);
  }
  return {text:result.text,url:url.href,type:result.type};
}

export function decodeHtml(value:string):string {
  return value.replace(/&#(x[\da-f]+|\d+);/gi, (_,code:string) => {
    const number=code[0]?.toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);
    return number>0 && number<=0x10ffff?String.fromCodePoint(number):'';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_,key:string) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[key] ?? ''));
}
function plain(html:string):string { return decodeHtml(html.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim(); }
export function extractPage(html:string):{title:string;content:string} {
  const title=plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '网页来源');
  const cleaned=html.replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  const body=/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i.exec(cleaned)?.[1] ?? cleaned;
  return {title,content:plain(body).slice(0,14000)};
}
export function parseSearch(html:string):SearchHit[] {
  if (/anomaly\.js|challenge-form|Unfortunately, bots|captcha/i.test(html)) throw new Error('搜索服务要求验证，当前不可用；可提供公开网页链接继续调查');
  const hits:SearchHit[]=[];
  const regex=/<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    const href=/href=["']([^"']+)["']/i.exec(match[1] ?? '')?.[1];
    if (!href) continue;
    try {
      const link=new URL(decodeHtml(href),'https://duckduckgo.com');
      const url=link.searchParams.get('uddg') ?? link.href;
      if (!/^https?:\/\//.test(url) || hits.some(h=>h.url===url)) continue;
      hits.push({url,title:plain(match[2] ?? ''),snippet:''});
      if(hits.length>=6) break;
    } catch { /* skip malformed external result */ }
  }
  if (!hits.length && !/no-results|No results found|没有找到/i.test(html)) throw new Error('搜索响应无法解析，服务可能受限；未将其当作零命中');
  return hits;
}
export function parseRss(xml:string):SearchHit[] {
  if(!/<rss\b/i.test(xml)) throw new Error('搜索 RSS 响应无效');
  const out:SearchHit[]=[];
  for(const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const tag=(name:string)=>decodeHtml(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`,'i').exec(match[1] ?? '')?.[1] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1');
    const url=tag('link').trim();
    if(!/^https?:\/\//.test(url) || out.some(h=>h.url===url)) continue;
    out.push({url,title:plain(tag('title')),snippet:plain(tag('description')).slice(0,350)});
    if(out.length>=6)break;
  }
  return out;
}
export function parseSogou(html:string):SearchHit[] {
  if (/访问过于频繁|请输入验证码|antispider/i.test(html)) throw new Error('搜狗要求验证');
  html=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  const hits:SearchHit[]=[];
  for(const match of html.matchAll(/<h3\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi)) {
    const url=new URL(decodeHtml(match[1]!), 'https://www.sogou.com').href;
    if(!/^https?:/.test(url) || hits.some(h=>h.url===url)) continue;
    const tail=html.slice((match.index ?? 0)+match[0].length,(match.index ?? 0)+match[0].length+3500).split(/<h3\b/i)[0]!;
    hits.push({url,title:plain(match[2]!),snippet:plain(tail).replace(/<[^>]*$/,'').split('推荐您搜索')[0]!.slice(0,350)});
    if(hits.length>=10) break;
  }
  if(!hits.length) throw new Error('搜狗未返回可解析的候选来源');
  const score=(h:SearchHit)=>{
    const text=h.title+' '+h.snippet;
    return (/新华社|中新网|中国经济网|央视|澎湃|政府|人民网/.test(text)?8:0)
      + (/通报|公告|调查情况/.test(h.title)?2:0)
      - (/真相大白|吃瓜|反转|震惊|大结局|战争远未|出乎所有人/.test(h.title)?8:0)
      - (/哔哩哔哩|视频播放量|mp.weixin.qq.com/.test(text+' '+h.url)?10:0);
  };
  return hits.sort((a,b)=>score(b)-score(a));
}
// A conservative lexical guard, not a claim that surviving results are evidence.
export function relevantHits(query:string,hits:SearchHit[]):SearchHit[] {
  const terms=query.toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z]{3,}/gu) ?? [];
  const grams=terms.flatMap(t=>/\p{Script=Han}/u.test(t)?Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2)):[t]);
  const meaningful=grams.filter(t=>!['事件','调查','官方','通报','情况','新闻','最新'].includes(t));
  if(!meaningful.length) return hits;
  return hits.filter(h=>meaningful.some(t=>(h.title+' '+h.snippet).toLowerCase().includes(t)));
}
export function createWebTools():WebTools {
  return {
    async search(query,signal) {
      if(!query.trim() || query.length>500) throw new Error('搜索词长度必须在 1–500 字符');
      const providers=[
        {url:'https://www.sogou.com/web?query=',parse:parseSogou,xml:false},
        {url:'https://html.duckduckgo.com/html/?q=',parse:parseSearch,xml:false},
        {url:'https://www.bing.com/search?format=rss&q=',parse:parseRss,xml:true},
      ];
      if(!/\p{Script=Han}/u.test(query)) providers.push(providers.shift()!);
      const errors:string[]=[];
      for(const provider of providers) {
        try {
          const page=await publicText(provider.url+encodeURIComponent(query),signal,0,provider.xml);
          const hits=relevantHits(query,provider.parse(page.text));
          if(hits.length) return hits;
          errors.push(`${new URL(provider.url).hostname}：结果为空或与查询无关`);
        } catch(error) {signal.throwIfAborted();errors.push(`${new URL(provider.url).hostname}：${String(error)}`);}
      }
      throw new Error(`检索未取得相关来源，不能据此判断事件不存在。${errors.join('；')}`);
    },
    async read(url,signal) {
      let page=await publicText(url,signal);
      // Sogou uses a literal JS redirect. Extract its URL as data; never execute scripts.
      if(new URL(page.url).hostname==='www.sogou.com' && new URL(page.url).pathname==='/link') {
        const target=/window\.location\.replace\("(https?:\/\/[^"\r\n]+)"\)/.exec(page.text)?.[1];
        if(!target) throw new Error('搜索结果跳转无法解析');
        page=await publicText(decodeHtml(target),signal);
      }
      if(/(^|\.)bilibili\.com$/.test(new URL(page.url).hostname) && new URL(page.url).pathname.startsWith('/video/')) throw new Error('视频页面不等于视频逐字稿，请选择文字报道来源');
      const extracted=page.type.includes('text/plain')?{title:new URL(page.url).hostname,content:page.text.slice(0,14000)}:extractPage(page.text);
      if(extracted.content.length<30) throw new Error('未能读取足够正文，可能需要登录或 JavaScript');
      if((extracted.content.match(/\uFFFD/g)?.length ?? 0)>extracted.content.length*.01) throw new Error('正文编码异常，拒绝作为证据');
      return {...extracted,url:page.url};
    },
  };
}
