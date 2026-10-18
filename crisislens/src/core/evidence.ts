// Source → Evidence → Claim 的可追溯链，以及结构化的冲突检测。
// 冲突不是让模型“感觉这两个材料矛盾”，而是同一 Claim 上同时存在 supports 与 contradicts。
import { createHash } from 'node:crypto';
import type {
  Claim,
  ClaimStatus,
  Conflict,
  Evidence,
  EvidenceRelation,
  InvestigationState,
} from './types.ts';
import type { ClaimView, EvidenceStore } from './ports.ts';

function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export function createEvidenceStore(): EvidenceStore & {
  readonly evidence: Evidence[];
  readonly claims: Claim[];
  readonly conflicts: Conflict[];
  registerClaim(claim: Claim): void;
  recomputeClaims(): void;
  detectConflicts(): Conflict[];
} {
  const evidence: Evidence[] = [];
  const claims: Claim[] = [];
  let conflicts: Conflict[] = [];
  let seq = 0;

  function recomputeClaims(): void {
    for (const claim of claims) {
      const relations = claim.links.map((l) => l.relation);
      if (claim.links.length === 0) {
        claim.status = 'unsupported';
        continue;
      }
      if (relations.includes('supports') && relations.includes('contradicts')) {
        claim.status = 'contested';
        continue;
      }
      if (relations.includes('supports')) {
        claim.status = 'confirmed';
        continue;
      }
      if (relations.includes('contradicts')) {
        // 只有反对意见、没有支持意见，不代表该主张被否证，只说明当前方向无支持。
        claim.status = 'inconclusive';
        continue;
      }
      claim.status = 'inconclusive';
    }
  }

  function detectConflicts(): Conflict[] {
    const found: Conflict[] = [];
    for (const claim of claims) {
      const supporting = claim.links.filter((l) => l.relation === 'supports').map((l) => l.evidenceId);
      const contradicting = claim.links.filter((l) => l.relation === 'contradicts').map((l) => l.evidenceId);
      if (supporting.length > 0 && contradicting.length > 0) {
        const existing = conflicts.find((c) => c.claimId === claim.claimId);
        if (existing) continue;
        found.push({
          conflictId: `CF${String(conflicts.length + found.length + 1).padStart(3, '0')}`,
          claimId: claim.claimId,
          supportingEvidenceIds: supporting,
          contradictingEvidenceIds: contradicting,
          status: 'unresolved',
        });
      }
    }
    conflicts = conflicts.concat(found);
    return found;
  }

  return {
    evidence,
    claims,
    get conflicts() {
      return conflicts;
    },
    addEvidence(input): Evidence {
      const item: Evidence = {
        evidenceId: `E${String(++seq).padStart(3, '0')}`,
        sourceId: input.sourceId,
        channel: input.channel,
        excerpt: input.excerpt,
        quote: input.quote,
        contentHash: hashContent(`${input.sourceId}::${input.quote}`),
        retrievedAt: Date.now(),
      };
      evidence.push(item);
      return item;
    },
    list(): Evidence[] {
      return evidence.slice();
    },
    findBySource(sourceId: string): Evidence[] {
      return evidence.filter((e) => e.sourceId === sourceId);
    },
    registerClaim(claim: Claim): void {
      if (!claims.some((c) => c.claimId === claim.claimId)) claims.push(claim);
    },
    linkEvidenceToClaim(claimId, evidenceId, relation): void {
      const claim = claims.find((c) => c.claimId === claimId);
      if (!claim) return;
      const existing = claim.links.find((l) => l.evidenceId === evidenceId);
      if (existing) {
        existing.relation = relation;
      } else {
        claim.links.push({ evidenceId, relation });
      }
      recomputeClaims();
    },
    getClaim(claimId): ClaimView | undefined {
      const claim = claims.find((c) => c.claimId === claimId);
      if (!claim) return undefined;
      return { claimId: claim.claimId, statement: claim.statement, status: claim.status, links: claim.links };
    },
    listClaims(): ClaimView[] {
      return claims.map((c) => ({ claimId: c.claimId, statement: c.statement, status: c.status, links: c.links }));
    },
    claimsFor(_state: InvestigationState): ClaimView[] {
      return claims.map((c) => ({ claimId: c.claimId, statement: c.statement, status: c.status, links: c.links }));
    },
    recomputeClaims,
    detectConflicts,
  };
}

export type { ClaimStatus, EvidenceRelation };

/**
 * 引文完整性校验：quote 必须是原文子串。
 * 对不上就拒绝进入证据链，避免“excerpt 与 source 对不上”这类伪造引用。
 */
export function quoteIsVerifiable(quote: string, content: string): boolean {
  if (quote.length === 0) return false;
  return content.includes(quote);
}

export function firstSentenceContaining(content: string, terms: string[], fallbackLength = 60): string {
  const sentences = content.split(/(?<=[。！？\n])/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const term of terms) {
    const hit = sentences.find((s) => s.includes(term));
    if (hit) return truncate(hit, 120);
  }
  return truncate(content.replace(/\s+/g, ' ').trim(), fallbackLength);
}

export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join('')}…`;
}
