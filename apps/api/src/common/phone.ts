/** Nigerian-friendly E.164 normalisation: 0803… / 234803… / +234 803… → +234803…; null when it isn't a phone number. */
export function normalisePhone(raw: string): string | null {
  let p = raw.replace(/[^\d+]/g, '');
  if (/^0\d{10}$/.test(p)) p = `234${p.slice(1)}`;
  if (!p.startsWith('+')) p = `+${p}`;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
