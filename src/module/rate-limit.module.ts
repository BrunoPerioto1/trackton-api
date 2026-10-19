import { Module } from '@nestjs/common';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { AiQuotaService } from '../users/ai-quota.service';

// O banco vem do DatabaseModule, que é global. A cota de IA do Grátis mora
// aqui porque é o mesmo contador, e quem a usa (site, bot, /users/me) já
// importa este módulo.
@Module({
  providers: [RateLimitService, AiQuotaService],
  exports: [RateLimitService, AiQuotaService],
})
export class RateLimitModule {}
