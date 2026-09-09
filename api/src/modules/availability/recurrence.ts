const weekdays = new Map([['MO', 1], ['TU', 2], ['WE', 3], ['TH', 4], ['FR', 5], ['SA', 6], ['SU', 7]]);

export type WeeklyRecurrence = { canonical: string; identity: string; weekdays: number[] };

export function canonicalizeWeeklyRecurrence(value: string): WeeklyRecurrence {
  const parts = value.split(';').map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) throw new RecurrenceError();
  const fields = new Map(parts.map((part) => { const [key, fieldValue, ...rest] = part.split('='); if (!key || !fieldValue || rest.length) throw new RecurrenceError(); return [key.toUpperCase(), fieldValue.toUpperCase()] as const; }));
  if (fields.get('FREQ') !== 'WEEKLY' || fields.size !== 2 || !fields.has('BYDAY')) throw new RecurrenceError();
  const selected = [...new Set(fields.get('BYDAY')!.split(',').map((day) => weekdays.get(day)))];
  if (!selected.length || selected.some((day) => day === undefined)) throw new RecurrenceError();
  const ordered = selected as number[]; ordered.sort((left, right) => left - right);
  const names = ordered.map((day) => [...weekdays.entries()].find(([, number]) => number === day)![0]);
  const canonical = `FREQ=WEEKLY;BYDAY=${names.join(',')}`;
  return { canonical, identity: canonical, weekdays: ordered };
}

export class RecurrenceError extends Error {
  public constructor() { super('The availability recurrence is not supported.'); }
}
