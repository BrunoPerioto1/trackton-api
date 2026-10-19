import { ForbiddenException } from '@nestjs/common';
import { frontUrl } from '../common/utils/front-url';
import { isPro, proPrice } from './plan';

type AccessFields = {
  isActive: boolean | null;
  accessUntil: Date | null;
};

// Só a conta desativada fica de fora. Vencer não tranca mais nada: a conta
// cai no Grátis (plan.ts), e o que é do Pro é barrado recurso a recurso.
export function assertAccess(user: AccessFields): void {
  if (user.isActive === false) {
    throw new ForbiddenException('Conta desativada');
  }
}

// Ativa e no Pro: é o que vale pro grupo Tips (entrar, ser convidado de volta)
// e pra receber tip no privado.
export function hasAccess(user: AccessFields): boolean {
  return user.isActive !== false && isPro(user);
}

// Vencido conta a partir de agora; em dia, soma no vencimento atual — quem paga
// adiantado não perde os dias que ainda tinha.
export function extendAccess(current: Date | null, days: number): Date {
  const base =
    current && new Date(current).getTime() > Date.now()
      ? new Date(current)
      : new Date();
  return new Date(base.getTime() + days * 86_400_000);
}

const spDate = (d: Date) =>
  d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

// Dias de calendário (fuso SP) entre hoje e o vencimento: 0 = vence hoje.
export function daysUntil(date: Date, now = new Date()): number {
  return Math.round(
    (Date.parse(spDate(new Date(date))) - Date.parse(spDate(now))) / 86_400_000,
  );
}

// Convite pra assinar: vai no lembrete do cron e nos avisos do grupo Tips.
export function subscribeLine(): string {
  return (
    `⭐ Assine o Pro por R$ ${proPrice().toFixed(2).replace('.', ',')}/mês pelo site, no cartão, Pix ou boleto.\n` +
    'Sem assinar, a conta continua no Grátis: aposta digitada à vontade e 5 leituras de print ou áudio por dia.'
  );
}

export function subscribeKeyboard() {
  return { inline_keyboard: [[{ text: '⭐ Assinar o Pro', url: frontUrl('/plano') }]] };
}

// Botão "Já paguei" que ficou nas mensagens antigas do bot, da época do PIX
// manual. O porteiro responde com o caminho novo.
export const LEGACY_PAYMENT_CLAIM_CALLBACK = 'ja_paguei';

export type AccessBlock = 'inactive' | 'expired' | null;

// Motivo do bloqueio sem exceção HTTP — o bot responde diferente para cada um.
// 'expired' = fora do Pro (vale pro grupo Tips).
export function accessBlock(user: AccessFields): AccessBlock {
  if (user.isActive === false) return 'inactive';
  if (!isPro(user)) return 'expired';
  return null;
}
