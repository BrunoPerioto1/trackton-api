import { BadRequestException } from '@nestjs/common';
import type { HouseRegulation } from '../../db_types/BettingHouse';

/**
 * Casas que operam por decisão judicial em vez de portaria: a SPA/MF dá a elas
 * os mesmos direitos de uma autorizada, mas elas não recebem domínio .bet.br.
 * Lista fechada de propósito — liberar qualquer domínio abriria espaço pra site
 * clone. Entra aqui só domínio conferido à mão.
 */
export const JUDICIAL_HOUSE_HOSTS = ['zeroum.bet', 'www.zeroum.bet'];

/**
 * Link do site de uma casa. Só entra domínio `.bet.br`: é o domínio que a
 * SPA/MF reserva pras casas com autorização federal — "betano.com" ou
 * "vbet.bet" seriam sites fora da regulamentação (ou golpe se passando por ela).
 * A exceção são as casas de JUDICIAL_HOUSE_HOSTS.
 *
 * Aceita digitar sem protocolo ("betano.bet.br") e sempre grava https.
 * Vazio/null devolve null, que apaga o link.
 */
export function normalizeFederalHouseUrl(raw: string | null | undefined): string | null {
  return normalizeHouseUrl(raw, 'federal');
}

/**
 * Casa offshore (estrangeira, liberada pelo admin depois da MP) aceita
 * qualquer domínio público — quem cadastra confere à mão. Só não aceita
 * .bet.br: aí a casa é federal e está com a regulação errada.
 */
export function normalizeHouseUrl(
  raw: string | null | undefined,
  regulation: HouseRegulation,
): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new BadRequestException('Link inválido');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('Link inválido');

  const host = url.hostname.toLowerCase();
  const federal = host.endsWith('.bet.br') && host !== 'bet.br';
  if (regulation === 'offshore') {
    if (federal) throw new BadRequestException('Domínio .bet.br é de casa federal, não offshore');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new BadRequestException('Link inválido');
  } else if (!(federal || JUDICIAL_HOUSE_HOSTS.includes(host))) {
    throw new BadRequestException('Só casas federais: o link precisa ser um domínio .bet.br');
  }

  url.protocol = 'https:';
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.host}${path}${url.search}`;
}
