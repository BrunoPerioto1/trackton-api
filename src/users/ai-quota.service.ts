import { Injectable } from '@nestjs/common';
import { RateLimitService, type RateLimitRule } from '../common/rate-limit/rate-limit.service';
import { AiDailyLimitException, FREE_AI_PER_DAY } from './plan';

// Dia de SP (UTC-3, sem horário de verão desde 2019): o limite volta à meia-noite daqui.
const FREE_AI_DAILY: RateLimitRule = {
  limit: FREE_AI_PER_DAY,
  windowMs: 86_400_000,
  offsetMs: 3 * 3_600_000,
};

/**
 * Leituras por IA do dia no Grátis, somando site e bot (print e áudio). Barra
 * antes de chamar a IA e só conta depois que ela leu: leitura que falhou não
 * gasta a cota de ninguém. O Pro não passa por aqui.
 *
 * Por conta (userId), não por canal: 5 no site + 5 no bot dariam 10.
 */
@Injectable()
export class AiQuotaService {
  constructor(private readonly rateLimit: RateLimitService) {}

  private bucket(userId: number) {
    return `ai-day:user:${userId}`;
  }

  async usedToday(userId: number): Promise<number> {
    return this.rateLimit.used(this.bucket(userId), FREE_AI_DAILY);
  }

  async assertAvailable(userId: number, pro: boolean): Promise<void> {
    if (pro) return;
    if ((await this.usedToday(userId)) >= FREE_AI_PER_DAY) throw new AiDailyLimitException();
  }

  async record(userId: number, pro: boolean): Promise<void> {
    if (pro) return;
    await this.rateLimit.record(this.bucket(userId), FREE_AI_DAILY);
  }
}
