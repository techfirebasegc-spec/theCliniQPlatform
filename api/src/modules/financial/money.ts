export type Currency = string;

export interface Money {
  amountMinor: bigint;
  currency: Currency;
}

export function money(amountMinor: bigint, currency: string): Money {
  if (amountMinor < 0n || !/^[A-Z]{3}$/.test(currency)) throw new FinancialMoneyError();
  return { amountMinor, currency };
}

export function addMoney(values: readonly Money[]): Money {
  const first = values[0];
  if (!first) throw new FinancialMoneyError();
  if (values.some((value) => value.currency !== first.currency)) throw new FinancialMoneyError();
  return money(values.reduce((total, value) => total + value.amountMinor, 0n), first.currency);
}

export class FinancialMoneyError extends Error {
  public constructor() { super('INVALID_MONEY'); this.name = 'FinancialMoneyError'; }
}
