import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { Database } from '../../infra/db/database.types';
import { DATABASE_WRITE_CONNECTION } from '../../infra/db/db.module';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
  // Desloca o início da janela. Sem ele a janela de 1 dia vira à meia-noite
  // UTC (21h em SP); com 3h, vira à meia-noite de SP.
  offsetMs?: number;
}

// Leitura de print (site e bot) e áudio custam OpenAI por chamada.
export const AI_PARSE_LIMIT: RateLimitRule = { limit: 40, windowMs: 60 * 60_000 };
// Código de vínculo tem 6 dígitos: sem teto, dava pra chutar pelo bot.
export const TELEGRAM_LINK_LIMIT: RateLimitRule = { limit: 5, windowMs: 15 * 60_000 };

export class RateLimitedException extends HttpException {
  constructor(retryAfterMs: number) {
    const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
    super(
      { message: `Muitas tentativas. Tente de novo em ${minutes} min.`, retryAfterMs },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Início da janela em que `now` cai (ms). */
export function windowStart({ windowMs, offsetMs = 0 }: RateLimitRule, now: number): number {
  return Math.floor((now - offsetMs) / windowMs) * windowMs + offsetMs;
}

/**
 * Limite de uso por janela fixa, contado no banco: a API roda serverless e um
 * contador em memória zera a cada instância, nunca barrando ninguém.
 *
 * Fail-open: se o banco falhar (ou a migration não tiver rodado), deixa passar
 * e loga — o limite protege custo, não pode derrubar a funcionalidade.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(DATABASE_WRITE_CONNECTION) private readonly db: Kysely<Database>) {}

  /** Conta um uso; lança RateLimitedException quando passa do limite. */
  async consume(bucket: string, rule: RateLimitRule, now = Date.now()): Promise<void> {
    const hits = await this.record(bucket, rule, now);
    if (hits !== null && hits > rule.limit) {
      throw new RateLimitedException(windowStart(rule, now) + rule.windowMs - now);
    }
  }

  /** Conta um uso sem barrar. Devolve o total da janela (null = contador fora). */
  async record(bucket: string, rule: RateLimitRule, now = Date.now()): Promise<number | null> {
    try {
      const row = await this.db
        .insertInto('rateLimitHits')
        .values({ bucket, windowStart: new Date(windowStart(rule, now)), hits: 1 })
        .onConflict((oc) =>
          oc.columns(['bucket', 'windowStart']).doUpdateSet({ hits: sql<number>`rate_limit_hits.hits + 1` }),
        )
        .returning('hits')
        .executeTakeFirstOrThrow();
      return Number(row.hits);
    } catch (error) {
      this.logger.warn(`contador indisponivel (${bucket}), liberando: ${(error as Error).message}`);
      return null;
    }
  }

  /** Usos já contados na janela atual, sem contar mais um. Fail-open: 0. */
  async used(bucket: string, rule: RateLimitRule, now = Date.now()): Promise<number> {
    try {
      const row = await this.db
        .selectFrom('rateLimitHits')
        .select('hits')
        .where('bucket', '=', bucket)
        .where('windowStart', '=', new Date(windowStart(rule, now)))
        .executeTakeFirst();
      return Number(row?.hits ?? 0);
    } catch (error) {
      this.logger.warn(`contador indisponivel (${bucket}), liberando: ${(error as Error).message}`);
      return 0;
    }
  }

  /** Apaga janelas com mais de um dia. Chamado pelo cron diário. */
  async purgeOld(now = Date.now()): Promise<void> {
    await this.db
      .deleteFrom('rateLimitHits')
      .where('windowStart', '<', new Date(now - 86_400_000))
      .execute()
      .catch((error: Error) => this.logger.warn(`limpeza do contador falhou: ${error.message}`));
  }
}
