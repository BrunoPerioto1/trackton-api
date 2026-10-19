import { ForbiddenException } from '@nestjs/common';

// Os dois planos num lugar só. O vencimento (accessUntil) virou "Pro até":
// em dia (ou sem prazo, NULL) é Pro; vencido cai no Grátis em vez de perder a
// conta. Teste grátis, PIX liberado pelo admin e assinatura empurram a mesma
// coluna.
export type Plan = 'free' | 'pro';

// Leituras por IA (print e áudio) por dia no Grátis. O registro digitado não
// conta: é ele que segue ilimitado.
export const FREE_AI_PER_DAY = 5;

// O que só o Pro usa. O backend barra; o site só lê isto pra mostrar o cadeado.
export const PRO_FEATURES = ['csvExport', 'settlement', 'tipsPlanilhar'] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

// Mensalidade do Pro (a mesma ACCESS_PRICE da época do PIX).
export function proPrice(): number {
  return Number(process.env.ACCESS_PRICE || 40);
}

type PlanFields = { accessUntil: Date | null; subscriptionStatus?: string | null };

export function isPro(user: PlanFields, now = Date.now()): boolean {
  return !user.accessUntil || new Date(user.accessUntil).getTime() > now;
}

export function planOf(user: PlanFields, now = Date.now()): Plan {
  return isPro(user, now) ? 'pro' : 'free';
}

/** Resumo que vai no /users/me: plano, até quando, o que libera e o gasto de IA do dia. */
export function planSummary(user: PlanFields, aiUsedToday: number, now = Date.now()) {
  const pro = isPro(user, now);
  return {
    plan: pro ? ('pro' as const) : ('free' as const),
    proUntil: pro && user.accessUntil ? new Date(user.accessUntil).toISOString() : null,
    features: Object.fromEntries(PRO_FEATURES.map((feature) => [feature, pro])) as Record<ProFeature, boolean>,
    // null = sem limite diário (Pro).
    aiDaily: pro ? null : { used: Math.min(aiUsedToday, FREE_AI_PER_DAY), limit: FREE_AI_PER_DAY },
    // Status da assinatura no Mercado Pago (pending, authorized, paused,
    // cancelled); null = nunca assinou. Pro sem assinatura = teste ou admin.
    subscription: user.subscriptionStatus ?? null,
    price: proPrice(),
  };
}

export type PlanSummary = ReturnType<typeof planSummary>;

// 403 com código: o site diferencia "recurso do Pro" de "sem permissão".
export class ProRequiredException extends ForbiddenException {
  constructor(message = 'Recurso do plano Pro.') {
    super({ message, code: 'PRO_REQUIRED' });
  }
}

export class AiDailyLimitException extends ForbiddenException {
  constructor() {
    super({
      message: `Você já usou as ${FREE_AI_PER_DAY} leituras por IA de hoje. Registre digitando ou assine o Pro para leituras ilimitadas.`,
      code: 'AI_DAILY_LIMIT',
      limit: FREE_AI_PER_DAY,
    });
  }
}
