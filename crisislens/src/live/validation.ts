import { quoteIsVerifiable } from '../core/evidence.ts';
import type { Citation, Decision, WebSource } from './types.ts';

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`模型 ${name} 格式不合法`);
  return value.trim();
}
export function validateDecision(value: unknown): Decision {
  if (!value || typeof value !== 'object') throw new Error('模型动作不是对象');
  const d = value as Record<string, unknown>;
  switch (d.action) {
    case 'search': return { action: 'search', query: text(d.query, 'query', 500), ...(typeof d.text === 'string' ? { text: d.text.slice(0, 300) } : {}) };
    case 'read': {
      const url = text(d.url, 'url', 2048);
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('模型 url 协议不合法');
      return { action: 'read', url, ...(typeof d.text === 'string' ? { text: d.text.slice(0, 300) } : {}) };
    }
    case 'clarify': return { action: 'clarify', text: text(d.text, 'text', 12000) };
    case 'answer': {
      if (!Array.isArray(d.citations) || d.citations.length > 20) throw new Error('模型 citations 必须是数组');
      return { action: 'answer', text: text(d.text, 'text', 16000).replace(/(\[S\d+\])[\s'"`{}\[\]]+$/, '$1'), citations: d.citations.map((c: unknown) => {
        if (!c || typeof c !== 'object') throw new Error('引用格式错误');
        const record = c as Record<string, unknown>;
        return { sourceId: text(record.sourceId, 'sourceId', 40), quote: text(record.quote, 'quote', 800) };
      }) };
    }
    default: throw new Error('模型动作只允许 search/read/clarify/answer');
  }
}
export function verifyCitations(citations: Citation[], sources: WebSource[]): Citation[] {
  for (const citation of citations) {
    const source = sources.find(s => s.id === citation.sourceId);
    if (!source) throw new Error(`引用来源不存在：${citation.sourceId}`);
    if (!quoteIsVerifiable(citation.quote, source.content)) throw new Error(`引文与原文不符：${citation.sourceId}`);
  }
  return citations;
}
