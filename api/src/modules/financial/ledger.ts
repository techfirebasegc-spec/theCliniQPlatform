import { FinancialError } from './financial.js';

export interface LedgerEntryInput { accountId: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: bigint; currency: string; }
export function assertBalancedLedger(entries: readonly LedgerEntryInput[]): void {
  if (entries.length < 2 || entries.some((entry) => entry.amountMinor <= 0n || !/^[A-Z]{3}$/.test(entry.currency))) throw new FinancialError('INVALID_LEDGER_ENTRY');
  const currencies = new Set(entries.map((entry) => entry.currency)); if (currencies.size !== 1) throw new FinancialError('LEDGER_CURRENCY_MISMATCH');
  const debits = entries.filter((entry) => entry.direction === 'DEBIT').reduce((sum, entry) => sum + entry.amountMinor, 0n);
  const credits = entries.filter((entry) => entry.direction === 'CREDIT').reduce((sum, entry) => sum + entry.amountMinor, 0n);
  if (debits !== credits) throw new FinancialError('UNBALANCED_LEDGER');
}
