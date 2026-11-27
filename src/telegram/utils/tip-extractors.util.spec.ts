import { extractLimitFromText } from './tip-extractors.util';

describe('extractLimitFromText', () => {
  it('usa o valor em R$ quando a linha traz US$ e R$', () => {
    expect(
      extractLimitFromText('🚦 Limite da aposta: US$8,70 (R$50,00)'),
    ).toBe(50);
    expect(
      extractLimitFromText('🚦 Limite da aposta: US$173,91 (R$999,00)'),
    ).toBe(999);
    expect(
      extractLimitFromText('🚦 Limite da aposta: US$1.739,10 (R$ 9.990,00)'),
    ).toBe(9990);
  });

  it('não chuta valor quando o limite em US$ vem sem R$', () => {
    expect(extractLimitFromText('🚦 Limite da aposta: US$??,00')).toBeNull();
    expect(extractLimitFromText('🚦 Limite da aposta: US$ 50,00')).toBeNull();
  });

  it('mantém o formato antigo só em R$', () => {
    expect(extractLimitFromText('🚦 Limite da aposta: R$ 500,00')).toBe(500);
    expect(extractLimitFromText('🚦 R$ 1.200,50')).toBe(1200.5);
    expect(extractLimitFromText('Limite: 300')).toBe(300);
  });

  it('pega o limite numa tip completa sem confundir com o 💰', () => {
    const tip = [
      '🏠 99play',
      '🏷 1.50',
      '🚦 Limite da aposta: US$8,70 (R$50,00)',
      '🛑 7,74%',
      '💰 US$8,70 (R$50,00)',
    ].join('\n');
    expect(extractLimitFromText(tip)).toBe(50);
  });
});
