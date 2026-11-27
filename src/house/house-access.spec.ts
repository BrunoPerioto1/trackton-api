import { checkHouseAccess, houseAccessLine } from './house-access';

const user = (hasVpn: boolean, hasCrypto: boolean) => ({ hasVpn, hasCrypto });
const house = (requiresVpn: boolean | null, acceptsPix: boolean | null, acceptsCrypto: boolean | null) => ({
  requiresVpn,
  acceptsPix,
  acceptsCrypto,
});

describe('checkHouseAccess', () => {
  it('VPN + só cripto: libera quem tem os dois', () => {
    expect(checkHouseAccess(house(true, false, true), user(true, true))).toEqual({
      status: 'ok',
      missing: [],
      needs: ['VPN', 'Cripto'],
    });
  });

  it('VPN + só cripto: lista o que falta', () => {
    expect(checkHouseAccess(house(true, false, true), user(false, false))).toMatchObject({
      status: 'blocked',
      missing: ['VPN', 'Cripto'],
    });
    expect(checkHouseAccess(house(true, false, true), user(true, false)).missing).toEqual(['Cripto']);
  });

  it('PIX libera mesmo sem cripto', () => {
    expect(checkHouseAccess(house(false, true, true), user(false, false))).toMatchObject({
      status: 'ok',
      needs: [],
    });
  });

  it('só VPN (pagamento não informado) avalia só a VPN', () => {
    expect(checkHouseAccess(house(true, null, null), user(false, true))).toMatchObject({
      status: 'blocked',
      missing: ['VPN'],
    });
    expect(checkHouseAccess(house(true, null, null), user(true, false)).status).toBe('ok');
  });

  it('casa sem nada informado não opina', () => {
    expect(checkHouseAccess(house(null, null, null), user(false, false)).status).toBe('unknown');
  });

  it('sem casa cadastrada não opina', () => {
    expect(checkHouseAccess(null, user(true, true)).status).toBe('unknown');
  });
});

describe('houseAccessLine', () => {
  it('monta a linha da tip', () => {
    expect(houseAccessLine(checkHouseAccess(house(true, false, true), user(true, true)))).toBe(
      '✅ Pode acessar (VPN ✓ · Cripto ✓)',
    );
    expect(houseAccessLine(checkHouseAccess(house(true, false, true), user(false, true)))).toBe(
      '⚠️ Precisa de VPN pra acessar essa casa',
    );
    expect(houseAccessLine(checkHouseAccess(house(true, false, true), user(false, false)))).toBe(
      '⚠️ Precisa de VPN e Cripto pra acessar essa casa',
    );
    expect(houseAccessLine(checkHouseAccess(house(false, true, null), user(false, false)))).toBe(
      '✅ Pode acessar',
    );
    expect(houseAccessLine(checkHouseAccess(null, user(false, false)))).toBeNull();
  });
});
