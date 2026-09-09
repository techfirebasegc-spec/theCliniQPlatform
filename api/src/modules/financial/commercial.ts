import { money, type Money } from './money.js';

export type CommercialRuleType = 'PERCENTAGE' | 'FIXED' | 'FIXED_PLUS_PERCENTAGE' | 'TIERED_CONTEXTUAL' | 'DOCTOR_SPECIFIC' | 'CLINIC_SPECIFIC' | 'SERVICE_SPECIFIC' | 'PROMOTIONAL' | 'ZERO_COMMISSION' | 'OTHER_APPROVED';
export type CommercialScopeKind = 'GLOBAL' | 'DOCTOR' | 'CLINIC' | 'SERVICE' | 'BOOKING_CONTEXT' | 'PROMOTION' | 'OTHER_APPROVED';
export interface CommercialRuleVersion {
  id: string;
  ruleType: CommercialRuleType;
  priority: number;
  effectiveFrom: Date;
  effectiveUntil?: Date;
  scopes: readonly { kind: CommercialScopeKind; value?: string }[];
  policy: { fixedAmountMinor?: bigint; percentageBasisPoints?: bigint; tiers?: readonly { upToMinor: bigint; fixedAmountMinor?: bigint; percentageBasisPoints?: bigint }[] };
}
export interface CommercialContext { at: Date; currency: string; grossAmountMinor: bigint; scopes: Readonly<Record<string, string | undefined>>; }
export interface CommercialEvaluation { rule: CommercialRuleVersion; platformCommission: Money; calculationBasis: string; }

export function evaluateCommercialRule(rules: readonly CommercialRuleVersion[], context: CommercialContext): CommercialEvaluation {
  const applicable = rules.filter((rule) => active(rule, context.at) && matches(rule, context));
  if (applicable.length === 0) throw new CommercialRuleError('NO_APPLICABLE_RULE');
  const ordered = [...applicable].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  if (ordered.length > 1 && ordered[0]!.priority === ordered[1]!.priority) throw new CommercialRuleError('AMBIGUOUS_RULE');
  const rule = ordered[0]!;
  return { rule, platformCommission: money(calculate(rule, context.grossAmountMinor), context.currency), calculationBasis: rule.ruleType };
}

function active(rule: CommercialRuleVersion, at: Date): boolean { return rule.effectiveFrom <= at && (!rule.effectiveUntil || rule.effectiveUntil > at); }
function matches(rule: CommercialRuleVersion, context: CommercialContext): boolean {
  return rule.scopes.every((scope) => scope.kind === 'GLOBAL' || context.scopes[scope.kind] === scope.value);
}
function calculate(rule: CommercialRuleVersion, gross: bigint): bigint {
  const policy = rule.policy;
  if (rule.ruleType === 'ZERO_COMMISSION') return 0n;
  if (rule.ruleType === 'TIERED_CONTEXTUAL') {
    const tier = policy.tiers?.find((candidate) => gross <= candidate.upToMinor);
    if (!tier) throw new CommercialRuleError('RULE_POLICY_INVALID');
    return (tier.fixedAmountMinor ?? 0n) + ((gross * (tier.percentageBasisPoints ?? 0n)) / 10_000n);
  }
  const fixed = policy.fixedAmountMinor ?? 0n;
  const percentage = (gross * (policy.percentageBasisPoints ?? 0n)) / 10_000n;
  if (fixed < 0n || percentage < 0n) throw new CommercialRuleError('RULE_POLICY_INVALID');
  return rule.ruleType === 'FIXED' ? fixed : rule.ruleType === 'PERCENTAGE' ? percentage : fixed + percentage;
}
export class CommercialRuleError extends Error { public constructor(public readonly code: string) { super(code); this.name = 'CommercialRuleError'; } }
