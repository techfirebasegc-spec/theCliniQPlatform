export class TimezoneError extends Error {
  public constructor() { super('The availability timezone or local time is invalid.'); }
}

export function validateIanaTimezone(value: string): string {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return value; } catch { throw new TimezoneError(); }
}

export function localToUtcEarlier(local: string, timezone: string): Date {
  validateIanaTimezone(timezone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local)) throw new TimezoneError();
  const baseline = Date.parse(`${local}Z`);
  if (Number.isNaN(baseline)) throw new TimezoneError();
  const offsets = new Set<number>();
  for (let hour = -18; hour <= 18; hour += 1) offsets.add(offsetMinutes(new Date(baseline + hour * 3_600_000), timezone));
  const matches = [...offsets].map((offset) => new Date(baseline - offset * 60_000)).filter((candidate) => localParts(candidate, timezone) === local).sort((left, right) => left.getTime() - right.getTime());
  if (!matches[0]) throw new TimezoneError();
  return matches[0];
}

function offsetMinutes(value: Date, timezone: string): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(value).find((item) => item.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part ?? '');
  if (!match) throw new TimezoneError();
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

function localParts(value: Date, timezone: string): string {
  const values = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value).reduce<Record<string, string>>((result, item) => ({ ...result, [item.type]: item.value }), {});
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}
