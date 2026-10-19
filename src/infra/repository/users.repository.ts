
import { Inject, Injectable } from '@nestjs/common';
import { NewUser, UpdateUser, UserId } from '../../db_types/Users';
import type { RoleId } from '../../db_types/Roles';
import { DATABASE_READ_CONNECTION, DATABASE_WRITE_CONNECTION } from '../db/db.module';
import { Kysely, sql } from 'kysely';
import { Database } from '../db/database.types';

@Injectable()
export class UsersRepository {
  constructor(
    @Inject(DATABASE_WRITE_CONNECTION)
    private readonly dbWrite: Kysely<Database>,
    @Inject(DATABASE_READ_CONNECTION)
    private readonly dbRead: Kysely<Database>,
  ) {}

 async findByEmail(email: string) {
  return this.dbRead
    .selectFrom("users")
    .selectAll()
    .where("email", "=", email)
    .executeTakeFirst();
}

async findByUsername(username: string) {
  return this.dbRead
    .selectFrom("users")
    .selectAll()
    .where("username", "=", username)
    .executeTakeFirst();
}

async findById(id: UserId) {
  return this.dbRead
    .selectFrom("users")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

   async linkTelegram(userId: UserId, telegramUserId: number, telegramUsername: string | null = null) {
  const update: UpdateUser = {
    telegramUserId,
    telegramUsername,
    telegramLinkedAt: new Date(),
    // O código morre no ato: um msesmo código não vincula dois Telegrams.
    telegramLinkCode: null,
    telegramLinkExpiresAt: null,
    updatedAt: new Date(),
  };

  const linkedUser = await this.dbWrite
    .updateTable("users")
    .set(update)
    .where("id", "=", userId)
    .returning("id")
    .executeTakeFirstOrThrow();

  return !!linkedUser;
}


 async insertUser(newUser: NewUser) {
  return this.dbWrite
    .insertInto("users")
    .values({
      ...newUser,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

 async updateUser(id: UserId, update: UpdateUser) {
  if (Object.keys(update).length === 0) {
    return this.findById(id);
  }

  return this.dbWrite
    .updateTable("users")
    .set({
      ...update,
      updatedAt: new Date(),
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

async findByTelegramLinkCode(code: string) {
  return this.dbRead
    .selectFrom("users")
    .selectAll()
    .where("telegramLinkCode", "=", code)
    .executeTakeFirst();
}

// Apaga tudo que é do usuário e o usuário. Nenhuma FK pra `users` tem ON
// DELETE CASCADE em produção (bets, house_transactions, tip_deliveries e
// tip_dismissals — conferido no catálogo em 2026-10-01): faltando uma tabela
// aqui, o último DELETE bate na FK e a exclusão dá 500. Era o caso de quem já
// tinha recebido ou descartado uma tip. As filhas de `bets` (resultado,
// pernas, sugestões) caem em cascata.
async deleteUserAndData(userId: UserId) {
  await this.dbWrite.transaction().execute(async (trx) => {
    await trx.deleteFrom("bets").where("userId", "=", userId).execute();
    await trx.deleteFrom("houseTransactions").where("userId", "=", userId).execute();
    await trx.deleteFrom("tipDeliveries").where("userId", "=", userId).execute();
    await trx.deleteFrom("tipDismissals").where("userId", "=", userId).execute();
    await trx.deleteFrom("users").where("id", "=", userId).execute();
  });
}

async findByTelegramUserId(telegramUserId: number) {
  return this.dbRead
    .selectFrom("users")
    .selectAll()
    .where("telegramUserId", "=", telegramUserId)
    .executeTakeFirst();
}

  async updateUserStake(userId: UserId, stake: number) {
  const updated = await this.dbWrite
    .updateTable("users")
    .set({
      stake,
      updatedAt: new Date(),
    })
    .where("id", "=", userId)
    .returning("id")
    .executeTakeFirst();

  return !!updated;
}

async getUserStake(userId: UserId) {
  const result = await this.dbRead
    .selectFrom("users")
    .select("stake")
    .where("id", "=", userId)
    .executeTakeFirst();

  return result?.stake ?? null;
}

async findLinkedForTipsFanout() {
  return this.dbRead
    .selectFrom("users")
    // stake vem junto: o fan-out calculava a recomendação com um SELECT por usuário.
    .select(["id", "telegramUserId", "minPercentFilter", "stake"])
    .where("telegramUserId", "is not", null)
    // Vencido/desativado não recebe tip: o bloqueio do site valeria pouco se o bot continuasse entregando.
    .where((eb) => eb.or([eb("isActive", "is", null), eb("isActive", "=", true)]))
    .where((eb) => eb.or([eb("accessUntil", "is", null), eb("accessUntil", ">", new Date())]))
    .execute();
}

// Quem tem vencimento e Telegram vinculado: o cron de aviso decide quem recebe pelo dia.
async findWithAccessDeadline() {
  return this.dbRead
    .selectFrom("users")
    .select(["id", "username", "telegramUserId", "accessUntil", "isActive", "subscriptionStatus"])
    .where("accessUntil", "is not", null)
    .execute();
}

async findAdminsWithTelegram(adminRoleId: number) {
  return this.dbRead
    .selectFrom("users")
    .select(["telegramUserId"])
    .where("roleId", "=", adminRoleId as RoleId)
    .where("telegramUserId", "is not", null)
    .execute();
}

// Uma query só, e só escreve se o @ mudou: vincular antes da coluna existir ou
// trocar o @ no Telegram não exige vincular de novo.
async syncTelegramUsername(telegramUserId: number, telegramUsername: string | null) {
  await this.dbWrite
    .updateTable("users")
    .set({ telegramUsername })
    .where("telegramUserId", "=", telegramUserId)
    .where(sql<boolean>`telegram_username IS DISTINCT FROM ${telegramUsername}`)
    .execute();
}

async updateMinPercentFilter(telegramUserId: number, value: number | null) {
  const updated = await this.dbWrite
    .updateTable("users")
    .set({ minPercentFilter: value, updatedAt: new Date() })
    .where("telegramUserId", "=", telegramUserId)
    .returning("id")
    .executeTakeFirst();

  return !!updated;
}
}
