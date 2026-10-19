import { windowStart } from '../common/rate-limit/rate-limit.service';
import { AiQuotaService } from './ai-quota.service';
import { AiDailyLimitException, FREE_AI_PER_DAY, isPro, planSummary } from './plan';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-19T15:00:00Z');

describe('plano', () => {
  it('em dia ou sem prazo é Pro; vencido é Grátis', () => {
    expect(isPro({ accessUntil: new Date(NOW + DAY) }, NOW)).toBe(true);
    expect(isPro({ accessUntil: null }, NOW)).toBe(true);
    expect(isPro({ accessUntil: new Date(NOW - 1) }, NOW)).toBe(false);
  });

  it('resumo do Grátis: recursos travados e contador do dia', () => {
    const summary = planSummary({ accessUntil: new Date(NOW - DAY) }, 3, NOW);
    expect(summary).toEqual({
      plan: 'free',
      proUntil: null,
      features: { csvExport: false, settlement: false, tipsPlanilhar: false },
      aiDaily: { used: 3, limit: FREE_AI_PER_DAY },
      subscription: null,
      price: 40,
    });
  });

  it('resumo do Pro: tudo liberado, sem contador', () => {
    const until = new Date(NOW + DAY);
    const summary = planSummary({ accessUntil: until }, 0, NOW);
    expect(summary.plan).toBe('pro');
    expect(summary.proUntil).toBe(until.toISOString());
    expect(summary.features).toEqual({ csvExport: true, settlement: true, tipsPlanilhar: true });
    expect(summary.aiDaily).toBeNull();
  });
});

describe('janela do dia de SP', () => {
  const rule = { limit: 5, windowMs: DAY, offsetMs: 3 * 3_600_000 };

  it('vira à meia-noite de SP (03:00 UTC), não à meia-noite UTC', () => {
    // 23h de SP do dia 18 e 01h de SP do dia 19: janelas diferentes.
    const before = windowStart(rule, Date.parse('2026-10-19T02:00:00Z'));
    const after = windowStart(rule, Date.parse('2026-10-19T04:00:00Z'));
    expect(new Date(after).toISOString()).toBe('2026-10-19T03:00:00.000Z');
    expect(after - before).toBe(DAY);
    // 21h de SP (00h UTC) ainda é o mesmo dia de SP.
    expect(windowStart(rule, Date.parse('2026-10-20T00:30:00Z'))).toBe(after);
  });
});

describe('AiQuotaService', () => {
  function setup(used: number) {
    const rateLimit = {
      used: jest.fn().mockResolvedValue(used),
      record: jest.fn().mockResolvedValue(used + 1),
    };
    return { quota: new AiQuotaService(rateLimit as any), rateLimit };
  }

  it('Grátis abaixo do limite passa; no limite, barra com AI_DAILY_LIMIT', async () => {
    await expect(setup(FREE_AI_PER_DAY - 1).quota.assertAvailable(7, false)).resolves.toBeUndefined();
    await expect(setup(FREE_AI_PER_DAY).quota.assertAvailable(7, false)).rejects.toBeInstanceOf(
      AiDailyLimitException,
    );
  });

  it('Pro nem consulta nem conta', async () => {
    const { quota, rateLimit } = setup(99);
    await quota.assertAvailable(7, true);
    await quota.record(7, true);
    expect(rateLimit.used).not.toHaveBeenCalled();
    expect(rateLimit.record).not.toHaveBeenCalled();
  });

  it('conta por conta, somando site e bot', async () => {
    const { quota, rateLimit } = setup(0);
    await quota.record(7, false);
    expect(rateLimit.record).toHaveBeenCalledWith('ai-day:user:7', expect.objectContaining({ limit: FREE_AI_PER_DAY }));
  });
});
