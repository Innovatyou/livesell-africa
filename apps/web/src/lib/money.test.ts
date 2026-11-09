import { describe, expect, it } from 'vitest';
import { formatBps, formatMoney, formatMoneyCompact, koboToNairaInput, nairaToKobo, toMinor } from './money';
import { normalisePhone, safeNext } from './nav';

describe('money formatting (BigInt only)', () => {
  it('formats kobo strings as naira', () => {
    expect(formatMoney('2500000')).toBe('₦25,000');
    expect(formatMoney('2500050')).toBe('₦25,000.50');
    expect(formatMoney('5', 'NGN', { decimals: 'always' })).toBe('₦0.05');
    expect(formatMoney('-120000')).toBe('−₦1,200');
    expect(formatMoney('0')).toBe('₦0');
    expect(formatMoney(null)).toBe('₦0');
    expect(formatMoney('770', 'USD')).toBe('$7.70');
  });

  it('keeps precision beyond Number.MAX_SAFE_INTEGER', () => {
    expect(formatMoney('900719925474099312')).toBe('₦9,007,199,254,740,993.12');
  });

  it('compacts without rounding up', () => {
    expect(formatMoneyCompact('95000')).toBe('₦950');
    expect(formatMoneyCompact('1250000')).toBe('₦12.5K');
    expect(formatMoneyCompact('199999900')).toBe('₦1.9M');
    expect(formatMoneyCompact('100000000')).toBe('₦1M');
  });

  it('formats commission rates from basis points without floats', () => {
    expect(formatBps(300)).toBe('3%');
    expect(formatBps(250)).toBe('2.5%');
    expect(formatBps(275)).toBe('2.75%');
    expect(formatBps(5)).toBe('0.05%');
    expect(formatBps(0)).toBe('0%');
    expect(formatBps(10_000)).toBe('100%');
    expect(() => formatBps(2.5)).toThrow();
  });

  it('turns typed naira into kobo strings and back, without floats', () => {
    expect(nairaToKobo('25,000')).toBe('2500000');
    expect(nairaToKobo('₦25000.5')).toBe('2500050');
    expect(nairaToKobo('0.07')).toBe('7');
    expect(nairaToKobo('12.')).toBe('1200');
    for (const bad of ['', '-1', '1.234', 'abc', '1e3']) expect(nairaToKobo(bad)).toBeNull();
    expect(koboToNairaInput('2500050')).toBe('25000.50');
    expect(koboToNairaInput('2500000')).toBe('25000');
    expect(koboToNairaInput(null)).toBe('');
  });

  it('rejects non-integer amounts', () => {
    expect(() => toMinor('12.5')).toThrow();
    expect(() => toMinor(1.5)).toThrow();
  });
});

describe('navigation and input helpers', () => {
  it('only allows same-site relative redirects', () => {
    expect(safeNext('/settings/team')).toBe('/settings/team');
    expect(safeNext('https://evil.example')).toBe('/dashboard');
    expect(safeNext('//evil.example')).toBe('/dashboard');
    expect(safeNext('/\\evil.example')).toBe('/dashboard');
    expect(safeNext(null)).toBe('/dashboard');
  });

  it('normalises Nigerian phone numbers to E.164', () => {
    expect(normalisePhone('0803 123 4567')).toBe('+2348031234567');
    expect(normalisePhone('8031234567')).toBe('+2348031234567');
    expect(normalisePhone('2348031234567')).toBe('+2348031234567');
    expect(normalisePhone('+2348031234567')).toBe('+2348031234567');
    expect(normalisePhone('+233241234567', 'GH')).toBe('+233241234567');
  });
});
