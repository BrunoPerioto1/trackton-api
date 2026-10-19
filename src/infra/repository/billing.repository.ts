import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { UserId } from '../../db_types/Users';
import { DATABASE_READ_CONNECTION, DATABASE_WRITE_CONNECTION } from '../db/db.module';
import { Database } from '../db/database.types';

@Injectable()
export class BillingRepository {
  constructor(
    @Inject(DATABASE_WRITE_CONNECTION)
    private readonly dbWrite: Kysely<Database>,
    @Inject(DATABASE_READ_CONNECTION)
    private readonly dbRead: Kysely<Database>,
  ) {}

  async findUserByPreapprovalId(preapprovalId: string) {
    return this.dbRead
      .selectFrom('users')
      .selectAll()
      .where('mpPreapprovalId', '=', preapprovalId)
      .executeTakeFirst();
  }

  async setSubscription(userId: UserId, mpPreapprovalId: string, subscriptionStatus: string) {
    await this.dbWrite
      .updateTable('users')
      .set({ mpPreapprovalId, subscriptionStatus, updatedAt: new Date() })
      .where('id', '=', userId)
      .execute();
  }

  // Só mexe se a assinatura ainda for a atual da conta: aviso atrasado de uma
  // assinatura antiga (trocada por outra) não sobrescreve o status da nova.
  async setSubscriptionStatus(userId: UserId, mpPreapprovalId: string, subscriptionStatus: string) {
    await this.dbWrite
      .updateTable('users')
      .set({ subscriptionStatus, updatedAt: new Date() })
      .where('id', '=', userId)
      .where('mpPreapprovalId', '=', mpPreapprovalId)
      .execute();
  }

  /**
   * Mensalidade aprovada: grava o pagamento e empurra o Pro, na mesma
   * transação. Devolve false se esse pagamento já tinha sido gravado (o
   * Mercado Pago repete notificação) — aí nada muda.
   *
   * O Pro vai até o maior entre o que a conta já tinha e `proUntil`: quem
   * assinou no meio do teste ou ganhou dias do admin não perde nada. Conta sem
   * prazo (NULL) continua sem prazo.
   */
  async recordPayment(payment: {
    userId: UserId;
    mpPaymentId: string;
    mpPreapprovalId: string;
    amount: number;
    proUntil: Date;
  }): Promise<boolean> {
    return this.dbWrite.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('subscriptionPayments')
        .values(payment)
        .onConflict((oc) => oc.column('mpPaymentId').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) return false;

      await trx
        .updateTable('users')
        .set({
          accessUntil: sql<Date | null>`case when access_until is null then null else greatest(access_until, ${payment.proUntil}) end`,
          updatedAt: new Date(),
        })
        .where('id', '=', payment.userId)
        .execute();
      return true;
    });
  }
}
