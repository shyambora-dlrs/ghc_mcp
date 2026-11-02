export const nowIso = (): string => new Date().toISOString();
export const todayUtc = (): string => nowIso().slice(0, 10);
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
