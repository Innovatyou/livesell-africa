/** Only same-site relative paths are allowed as post-login destinations (prevents open redirects). */
export function safeNext(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}

export const E164 = /^\+[1-9]\d{7,14}$/;
export const PASSWORD = /^(?=.*[A-Za-z])(?=.*\d).{10,128}$/;
export const PASSWORD_HINT = 'At least 10 characters, with a letter and a number.';

/** Accepts 0803…, 803… or +234803… and returns E.164 for Nigerian numbers; other formats pass through trimmed. */
export function normalisePhone(raw: string, country = 'NG'): string {
  const v = raw.replace(/[\s()-]/g, '');
  if (country === 'NG') {
    if (/^0[789][01]\d{8}$/.test(v)) return `+234${v.slice(1)}`;
    if (/^[789][01]\d{8}$/.test(v)) return `+234${v}`;
    if (/^234[789][01]\d{8}$/.test(v)) return `+${v}`;
  }
  return v;
}
