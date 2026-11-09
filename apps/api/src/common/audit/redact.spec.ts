import { redact } from './audit.service';

describe('audit redaction', () => {
  it('redacts secrets at any depth without over-matching', () => {
    expect(redact({ email: 'a@b.c', password: 'x', company: 'Acme', nested: { secretKey: 'k', accountNumber: '012', pin: '1234' }, list: [{ refreshToken: 't' }] }))
      .toEqual({ email: 'a@b.c', password: '[REDACTED]', company: 'Acme', nested: { secretKey: '[REDACTED]', accountNumber: '[REDACTED]', pin: '[REDACTED]' }, list: [{ refreshToken: '[REDACTED]' }] });
  });
});
