/**
 * Verificador de acesso: cruza o que a casa exige (VPN, forma de depósito)
 * com o que o usuário marcou no Perfil. Puro, sem banco, pra o fan-out e a
 * tela usarem a mesma resposta.
 *
 * Campo da casa null = não informado: não entra na conta. Casa sem nada
 * informado (ou tip sem casa cadastrada) fica 'unknown' e a tip sai sem aviso,
 * em vez de afirmar algo que ninguém conferiu.
 */
export type AccessRequirement = 'VPN' | 'Cripto';

export interface HouseAccessRules {
  requiresVpn: boolean | null;
  acceptsPix: boolean | null;
  acceptsCrypto: boolean | null;
}

export interface UserAccessProfile {
  hasVpn: boolean;
  hasCrypto: boolean;
}

export interface HouseAccessResult {
  status: 'ok' | 'blocked' | 'unknown';
  /** O que a casa exige e o usuário não tem. */
  missing: AccessRequirement[];
  /** O que a casa exige (tendo ou não), pra mostrar "VPN ✓ · Cripto ✓". */
  needs: AccessRequirement[];
}

export function checkHouseAccess(
  house: HouseAccessRules | null | undefined,
  user: UserAccessProfile,
): HouseAccessResult {
  if (!house) return { status: 'unknown', missing: [], needs: [] };

  const needs: AccessRequirement[] = [];
  const missing: AccessRequirement[] = [];
  let known = false;

  if (house.requiresVpn !== null) {
    known = true;
    if (house.requiresVpn) {
      needs.push('VPN');
      if (!user.hasVpn) missing.push('VPN');
    }
  }

  // Depósito: PIX resolve pra qualquer um; sem PIX e com cripto, cripto vira
  // exigência. Os dois null = forma de pagamento não informada.
  if (house.acceptsPix !== null || house.acceptsCrypto !== null) {
    known = true;
    if (house.acceptsPix !== true && house.acceptsCrypto === true) {
      needs.push('Cripto');
      if (!user.hasCrypto) missing.push('Cripto');
    }
  }

  if (!known) return { status: 'unknown', missing: [], needs: [] };
  return { status: missing.length ? 'blocked' : 'ok', missing, needs };
}

/** Linha que vai na tip entregue; null = não mostra nada. */
export function houseAccessLine(result: HouseAccessResult): string | null {
  if (result.status === 'unknown') return null;
  if (result.status === 'blocked') {
    return `⚠️ Precisa de ${result.missing.join(' e ')} pra acessar essa casa`;
  }
  return result.needs.length
    ? `✅ Pode acessar (${result.needs.map((n) => `${n} ✓`).join(' · ')})`
    : '✅ Pode acessar';
}
