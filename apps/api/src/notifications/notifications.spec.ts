import { billedPeriod, maskDestination, normaliseDestination, periodRange } from './notifications.service';
import { escapeHtml, render } from './templates';

const APP = 'https://app.livesell.africa';

describe('message templates', () => {
  it('escape everything a seller or customer typed', () => {
    const r = render('STAFF_INVITATION', { businessName: '<script>x</script>', inviterName: 'Ada "Boss"', roleName: 'Manager & co', token: 't', expiresAt: new Date('2026-11-10T10:00:00Z') }, APP);
    expect(r.html).not.toContain('<script>x</script>');
    expect(r.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(r.html).toContain('Ada &quot;Boss&quot;');
    expect(r.html).toContain('Manager &amp; co');
    expect(escapeHtml(`'`)).toBe('&#39;');
  });

  it('build links from APP_URL with the token encoded', () => {
    const r = render('EMAIL_VERIFICATION', { name: 'Ada', token: 'a b/c' }, APP);
    expect(r.html).toContain(`${APP}/verify-email?token=a%20b%2Fc`);
    expect(render('PASSWORD_RESET', { name: 'Ada', token: 'T' }, APP).text).toBe(`Reset your LiveSell password: ${APP}/reset-password?token=T`);
  });

  it('OTP SMS fits one segment and carries the code', () => {
    const r = render('PHONE_OTP', { code: '482913' }, APP);
    expect(r.text).toContain('482913');
    expect(r.text.length).toBeLessThanOrEqual(160);
  });

  it('billing messages show amounts from kobo exactly', () => {
    const r = render('BILLING_OVERDUE', { businessName: 'Ada', planName: 'Starter', invoiceNumber: 'INV-1', amountMinor: 1_250_050n, currency: 'NGN', accessEndsAt: new Date('2026-11-20T00:00:00Z') }, APP);
    expect(r.html).toContain('₦12,500.50');
    expect(render('BILLING_REMINDER', { businessName: 'A', planName: 'Pro', kind: 'trial_ending', daysLeft: 1, endsAt: new Date(), pricingModel: 'COMMISSION', commissionBps: 300 }, APP).html).toContain('3% of each verified sale');
  });
});

describe('notification helpers', () => {
  it('normalise Nigerian numbers to E.164 and reject bad destinations', () => {
    expect(normaliseDestination('SMS', '0803 123 4567')).toBe('+2348031234567');
    expect(normaliseDestination('WHATSAPP', '2348031234567')).toBe('+2348031234567');
    expect(normaliseDestination('SMS', '+44 7700 900123')).toBe('+447700900123');
    expect(normaliseDestination('SMS', '12345')).toBeNull();
    expect(normaliseDestination('EMAIL', ' Ada@Example.COM ')).toBe('ada@example.com');
    expect(normaliseDestination('EMAIL', 'not-an-email')).toBeNull();
  });

  it('mask destinations in lists', () => {
    expect(maskDestination('SMS', '+2348031234567')).toBe('+234803•••67');
    expect(maskDestination('EMAIL', 'ada.okafor@example.com')).toBe('ad••••••••@example.com');
  });

  it('bill by Lagos calendar month', () => {
    expect(billedPeriod(new Date('2026-11-30T23:30:00Z'))).toBe('2026-12'); // 00:30 in Lagos
    expect(billedPeriod(new Date('2026-11-30T22:30:00Z'))).toBe('2026-11');
    const [from, to] = periodRange('2026-12');
    expect(from.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    expect(to.toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });
});
