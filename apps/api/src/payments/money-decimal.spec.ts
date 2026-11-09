import { DecimalAmountError, decimalToMinor, minorToDecimal } from './money-decimal';

describe('decimal ↔ minor units', () => {
  it('formats kobo as a 2-decimal string', () => {
    expect([minorToDecimal(250050n), minorToDecimal(5n), minorToDecimal(0n), minorToDecimal(2_500_000n), minorToDecimal(-150n)]).toEqual(['2500.50', '0.05', '0.00', '25000.00', '-1.50']);
  });
  it('parses strings and JSON numbers exactly', () => {
    expect(decimalToMinor('2500.00')).toBe(250000n);
    expect(decimalToMinor('2500.5')).toBe(250050n);
    expect(decimalToMinor(7500)).toBe(750000n);
    expect(decimalToMinor(1.4)).toBe(140n);
    expect(decimalToMinor(0.1 + 0.2, { round: true })).toBe(30n); // 0.30000000000000004
    expect(decimalToMinor('19.990')).toBe(1999n); // trailing zeros are fine
  });
  it('refuses sub-kobo amounts unless asked to round (fees)', () => {
    expect(() => decimalToMinor('10.005')).toThrow(DecimalAmountError);
    expect(decimalToMinor('10.005', { round: true })).toBe(1001n);
    expect(decimalToMinor('10.004', { round: true })).toBe(1000n);
    expect(() => decimalToMinor('1e3')).toThrow(DecimalAmountError);
    expect(() => decimalToMinor('abc')).toThrow(DecimalAmountError);
    expect(() => decimalToMinor(Number.NaN)).toThrow(DecimalAmountError);
  });
  it('round-trips', () => {
    for (const v of [0n, 1n, 99n, 100n, 123456789n]) expect(decimalToMinor(minorToDecimal(v))).toBe(v);
  });
});
