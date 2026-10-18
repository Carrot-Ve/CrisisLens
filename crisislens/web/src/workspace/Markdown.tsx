import { Fragment } from 'react';
import type { ReactNode } from 'react';

function inline(text:string):ReactNode[] {
  return text.split(/(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`|\[S\d+\])/g).map((part,i)=>{
    const link=/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if(link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]} ↗</a>;
    if(part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2,-2)}</strong>;
    if(part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1,-1)}</code>;
    if(/^\[S\d+\]$/.test(part)) return <span key={i} className="citation">{part}</span>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
// Text-only React rendering: model output never becomes executable HTML.
export function Markdown({text}:{text:string}) {
  const lines=text.split('\n');
  const blocks:ReactNode[]=[];
  for(let i=0;i<lines.length;i++) {
    const line=lines[i] ?? '';
    if(!line.trim()) continue;
    if(line.startsWith('```')) {
      const content:string[]=[];
      while(++i<lines.length && !lines[i]!.startsWith('```')) content.push(lines[i]!);
      blocks.push(<pre key={i}>{content.join('\n')}</pre>);continue;
    }
    if(line.includes('|') && /^\s*\|?\s*:?-{3}/.test(lines[i+1] ?? '')) {
      const cells=(row:string)=>row.replace(/^\s*\||\|\s*$/g,'').split('|');
      const headings=cells(line);i++;
      const rows:string[][]=[];
      while(lines[i+1]?.includes('|')) rows.push(cells(lines[++i]!));
      blocks.push(<div key={i} className="md-table"><table><thead><tr>{headings.map((c,j)=><th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.map((r,j)=><tr key={j}>{r.map((c,k)=><td key={k}>{inline(c)}</td>)}</tr>)}</tbody></table></div>);continue;
    }
    const heading=/^(#{1,4})\s+(.+)/.exec(line);
    if(heading) { blocks.push(<h3 key={i}>{inline(heading[2]!)}</h3>);continue; }
    if(/^>\s?/.test(line)) { blocks.push(<blockquote key={i}>{inline(line.replace(/^>\s?/,''))}</blockquote>);continue; }
    if(/^[-*]\s|^\d+\.\s/.test(line)) { blocks.push(<div key={i} className="md-bullet"><span>•</span><div>{inline(line.replace(/^[-*]\s|^\d+\.\s/,''))}</div></div>);continue; }
    blocks.push(<p key={i}>{inline(line)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
