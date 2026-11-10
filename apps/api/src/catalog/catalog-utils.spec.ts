import {
  codePrefix, csvCell, formatAttributes, koboToNaira, nextProductCode, normaliseCode, parseAttributes, parseCsv,
  parseNairaToKobo, skuFor, slugify, toCsv, variantName,
} from './catalog-utils';

describe('catalogue utils', () => {
  it('slugifies names safely', () => {
    expect(slugify("Women's Evening Dress")).toBe('women-s-evening-dress');
    expect(slugify('Café & Crème  ')).toBe('cafe-and-creme');
    expect(slugify('!!!')).toBe('item');
    expect(slugify('a'.repeat(100)).length).toBe(80);
  });

  it('generates live-session product codes like BAG001 that never reuse a number', () => {
    expect(codePrefix('Premium Leather Bag')).toBe('BAG');
    expect(codePrefix("Men's Sneakers")).toBe('SNEAK');
    expect(codePrefix('Ankara dress', 'Dresses & Gowns')).toBe('DRESS');
    expect(codePrefix('123')).toBe('ITEM');
    // Phase 14: the head noun, not the last word; familiar codes for common items.
    expect(codePrefix('Red Leather Handbag')).toBe('BAG');
    expect(codePrefix('Ladies Block Heels Size 39')).toBe('HEEL');
    expect(codePrefix('Set of 3 Wigs')).toBe('WIG');
    expect(codePrefix('Bone Straight Human Hair Wig 22 inches')).toBe('WIG');
    expect(codePrefix('Ankara Maxi Gown with Belt')).toBe('GOWN');
    expect(codePrefix('Vitamin C Face Serum 30ml')).toBe('SERUM');
    expect(codePrefix('Oud Perfume for Men')).toBe('PERF');
    expect(codePrefix('Wireless Earbuds Black')).toBe('BUDS');
    expect(codePrefix('Classic Red', 'Shoes')).toBe('SHOE');
    expect(codePrefix('Zobo Drink Pack')).toBe('DRINK');
    expect(codePrefix('Chin Chin')).toBe('CHIN');
    expect(nextProductCode('BAG', [])).toBe('BAG001');
    expect(nextProductCode('SHOE', ['BAG001'])).toBe('SHOE002');
    expect(nextProductCode('DRESS', ['BAG001', 'SHOE002', 'WIG-X'])).toBe('DRESS003');
    expect(nextProductCode('BAG', ['BAG999'])).toBe('BAG1000');
    expect(normaliseCode(' bag 001 ')).toBe('BAG001');
  });

  it('names and SKUs variants from their attributes', () => {
    expect(variantName({ Colour: 'Black', Size: 'L' })).toBe('Black / L');
    expect(variantName({})).toBe('Default');
    expect(skuFor('BAG001', { Colour: 'Black', Size: 'L' })).toBe('BAG001-BLAC-L');
    expect(skuFor('BAG001', {})).toBe('BAG001');
  });

  it('parses naira amounts to kobo without floats', () => {
    expect(parseNairaToKobo('25,000.50')).toBe(2_500_050n);
    expect(parseNairaToKobo('₦25000')).toBe(2_500_000n);
    expect(parseNairaToKobo('0.5')).toBe(50n);
    expect(parseNairaToKobo('0.07')).toBe(7n);
    expect(parseNairaToKobo('9999999999999.99')).toBe(999_999_999_999_999n);
    for (const bad of ['-5', '1.234', 'abc', '', '1e5', '12.']) expect(() => parseNairaToKobo(bad)).toThrow();
    expect(koboToNaira(2_500_050n)).toBe('25000.50');
    expect(koboToNaira(7n)).toBe('0.07');
  });

  it('round-trips attributes', () => {
    expect(parseAttributes('Colour=Black; Size=L')).toEqual({ Colour: 'Black', Size: 'L' });
    expect(parseAttributes('')).toEqual({});
    expect(() => parseAttributes('Colour')).toThrow();
    expect(formatAttributes({ Colour: 'Black', Size: 'L' })).toBe('Colour=Black; Size=L');
  });

  it('parses RFC 4180 CSV including quotes, commas, newlines and CRLF', () => {
    const csv = '﻿name,description,price\r\n"Bag, leather","Line 1\nLine ""2""",25000\r\n\r\nShoe,,1500.50\n';
    expect(parseCsv(csv)).toEqual([['name', 'description', 'price'], ['Bag, leather', 'Line 1\nLine "2"', '25000'], ['Shoe', '', '1500.50']]);
    expect(() => parseCsv('a,"unterminated')).toThrow();
  });

  it('neutralises spreadsheet formulas in exports', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+234')).toBe("'+234");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('﻿a,b\r\n1,"x,y"\r\n');
  });
});
