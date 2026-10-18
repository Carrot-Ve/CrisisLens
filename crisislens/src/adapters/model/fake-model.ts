// 阶段 1 的确定性假模型。它存在的目的不是模拟语言能力，
// 而是在没有真实模型的前提下证明 Core/Runtime 的执行循环、预算、停止与引用链是通的。
// 它不会读取 Gold，也不会输出任何未经原文校验的内容。
import { firstSentenceContaining, truncate } from '../../core/evidence.ts';
import type { Decision, Interpretation, ModelInput, ModelPort } from '../../core/ports.ts';

const RESTRICTED_MARKERS = ['受限'];

function isRestricted(candidate: { title: string; snippet?: string }): boolean {
  return RESTRICTED_MARKERS.some(
    (m) => candidate.title.includes(m) || (candidate.snippet ?? '').includes(m),
  );
}

/**
 * 阶段 1 的检索夹具按标题／标识符匹配，不做全文检索。
 * 因此发现阶段用空查询浏览该通道的全部候选，而不是猜一个关键词。
 * 接真实检索 Provider 后，这里应换成从调查问题派生的查询词。
 */
function baseQuery(_input: ModelInput): string {
  return '';
}

/** 去掉 Markdown 文件头，只保留正文，避免把标题和说明文字当成原文摘录。 */
function bodyOf(content: string): string {
  const marker = content.lastIndexOf('## 原文');
  return marker >= 0 ? content.slice(marker + '## 原文'.length) : content;
}

export function createFakeModel(): ModelPort {
  return {
    name: 'fake-deterministic',

    async decide(input: ModelInput, signal: AbortSignal): Promise<Decision> {
      if (signal.aborted) {
        return { kind: 'escalate', question: '运行被取消', rationale: 'abort signal fired' };
      }

      const failedIds = new Set(input.failedSources.map((f) => f.resourceId));
      const unread = (channel: 'public' | 'internal') =>
        input.knownCandidates
          .filter((c) => c.channel === channel)
          .filter((c) => !input.readSourceIds.includes(c.sourceId))
          .filter((c) => !failedIds.has(c.sourceId))
          // 目录元数据已标明受限的材料不去尝试读取；这是元数据级的通用规则，不是 Gold。
          .filter((c) => !isRestricted(c));

      const query = baseQuery(input);

      // 冲突派生的待办步骤优先：用该问题的正向措辞再检索一次，产生可解释的新动作。
      const conflictStep = input.pendingPlanSteps.find((s) => s.triggeredBy.startsWith('conflict'));
      if (conflictStep) {
        const related = input.openQuestions.find((q) => conflictStep.text.includes(q.text));
        const term = related?.positiveTerms[0] ?? related?.text.slice(0, 8) ?? query;
        if (!input.triedQueries.includes(term)) {
          return {
            kind: 'call_tool',
            tool: 'search_sources',
            args: { query: term },
            rationale: `冲突待核验：${conflictStep.text}`,
          };
        }
      }

      if (!input.triedQueries.includes(query)) {
        return {
          kind: 'call_tool',
          tool: 'search_sources',
          args: { query },
          rationale: '尚未检索公开来源，先发现候选材料',
        };
      }

      const publicUnread = unread('public');
      if (publicUnread.length > 0) {
        const target = publicUnread[0]!;
        return {
          kind: 'call_tool',
          tool: 'fetch_source',
          args: { id: target.sourceId },
          rationale: `读取尚未取证的公开来源 ${target.sourceId}`,
        };
      }

      const internalKnown = input.knownCandidates.some((c) => c.channel === 'internal');
      if (!internalKnown) {
        return {
          kind: 'call_tool',
          tool: 'search_internal_docs',
          args: { query },
          rationale: '公开来源已读完，检索已授权内部材料',
        };
      }

      const internalUnread = unread('internal');
      if (internalUnread.length > 0) {
        const target = internalUnread[0]!;
        return {
          kind: 'call_tool',
          tool: 'read_internal_doc',
          args: { id: target.sourceId },
          rationale: `读取尚未取证的内部材料 ${target.sourceId}`,
        };
      }

      return { kind: 'report', rationale: '已知候选来源均已取证，无未读材料' };
    },

    async interpret(input, signal): Promise<Interpretation> {
      if (signal.aborted) return { evidence: [], judgements: [] };
      const { source, claims } = input;
      const allTerms = [
        ...claims.flatMap((c) => c.positiveTerms),
        ...claims.flatMap((c) => c.negativeTerms),
      ].filter((t) => t.length > 0);

      const quote = firstSentenceContaining(source.content, allTerms, 60);
      const evidence = [
        {
          sourceId: source.sourceId,
          channel: source.channel,
          // 正文抽取：优先取“## 原文”之后的内容，避免把文件头当成正文摘录。
          excerpt: truncate(bodyOf(source.content).replace(/\s+/g, ' ').trim(), 160),
          quote,
        },
      ];

      const judgements: Interpretation['judgements'] = [];
      for (const claim of claims) {
        // 先判反对措辞：否定式表述（"不覆盖批次 B"）必须先于正向子串命中，
        // 否则 "批次 B" 这类子串会在否定句中被误判为支持。
        const negative = claim.negativeTerms.find((t) => t.length > 0 && source.content.includes(t));
        if (negative) {
          judgements.push({ claimId: claim.claimId, relation: 'contradicts', basis: negative });
          continue;
        }
        const positive = claim.positiveTerms.find((t) => t.length > 0 && source.content.includes(t));
        if (positive) {
          judgements.push({ claimId: claim.claimId, relation: 'supports', basis: positive });
        }
      }

      return { evidence, judgements };
    },
  };
}
