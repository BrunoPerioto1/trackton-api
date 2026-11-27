import { normalizeHouseUrl } from './house-url.util';

describe('normalizeHouseUrl', () => {
  it('federal só aceita .bet.br (e as judiciais)', () => {
    expect(normalizeHouseUrl('betano.bet.br', 'federal')).toBe('https://betano.bet.br');
    expect(normalizeHouseUrl('https://zeroum.bet', 'federal')).toBe('https://zeroum.bet');
    expect(() => normalizeHouseUrl('cloudbet.com', 'federal')).toThrow();
  });

  it('offshore aceita domínio estrangeiro e grava https', () => {
    expect(normalizeHouseUrl('cloudbet.com', 'offshore')).toBe('https://cloudbet.com');
    expect(normalizeHouseUrl('http://www.betonline.ag/', 'offshore')).toBe('https://www.betonline.ag');
  });

  it('offshore recusa .bet.br, host sem domínio e protocolo estranho', () => {
    expect(() => normalizeHouseUrl('stake.bet.br', 'offshore')).toThrow();
    expect(() => normalizeHouseUrl('localhost', 'offshore')).toThrow();
    expect(() => normalizeHouseUrl('ftp://cloudbet.com', 'offshore')).toThrow();
  });

  it('vazio apaga o link', () => {
    expect(normalizeHouseUrl('  ', 'offshore')).toBeNull();
    expect(normalizeHouseUrl(null, 'federal')).toBeNull();
  });
});
