// src/dashboard/dashboard.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { SportId } from '../../db_types/Sports';
import type { Database } from '../db/database.types';
import { DATABASE_READ_CONNECTION } from '../db/db.module';
import { BettingHouseId } from '../../db_types/BettingHouse';
import { UserId } from '../../db_types/Users';
import { isNotEmpty } from 'class-validator';
import { endOfDay, startOfDay } from '../../common/utils/bet.utils';
import { betDate } from './bet-date';
import {
  LOST_RESULT_IDS,
  ResultIdEnum,
  SETTLED_RESULT_IDS,
  WON_RESULT_IDS,
} from '../../bet/dto/result-id.enum';

// A coluna e' TIMESTAMP sem timezone guardando instante UTC, entao a conversao
// precisa dos dois `AT TIME ZONE`: o primeiro rotula o valor como UTC, o segundo
// o traz pro horario civil de Sao Paulo. O que entra na conversao e' o `betDate`
// (data do jogo, com fallback pra data de planilhamento), nao a coluna crua.
const betTimeBr = sql`(${betDate} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'`;
const betCalendarDateBr = sql<string>`to_char(${betTimeBr}, 'YYYY-MM-DD')`;
const betCalendarMonthBr = sql<string>`to_char(date_trunc('month', ${betTimeBr}), 'YYYY-MM-DD')`;

interface FilterDashboard {
  startDate?: string;
  endDate?: string;
  houseId?: BettingHouseId;
  houseIds?: number[];
  sportIds?: number[];
  userId?: UserId;
}

// Filtros de todas as consultas do dashboard. Eram quatro cadeias de $if
// copiadas, uma por consulta, que podiam divergir. Exige `bets as b`.
function dashboardFilters(filters: FilterDashboard) {
  const { startDate, endDate, houseId, houseIds, sportIds, userId } = filters;
  return (eb: ExpressionBuilder<Database & { b: Database["bets"] }, "b">) => {
    const conditions: Expression<SqlBool>[] = [eb("b.deletedAt", "is", null)];
    if (isNotEmpty(userId)) conditions.push(eb("b.userId", "=", userId!));
    if (isNotEmpty(houseId)) conditions.push(eb("b.houseId", "=", houseId!));
    if (houseIds?.length) conditions.push(eb("b.houseId", "in", houseIds as BettingHouseId[]));
    if (sportIds?.length) conditions.push(eb("b.sportId", "in", sportIds as SportId[]));
    if (isNotEmpty(startDate)) conditions.push(eb(betDate, ">=", startOfDay(new Date(startDate!))));
    if (isNotEmpty(endDate)) conditions.push(eb(betDate, "<", endOfDay(new Date(endDate!))));
    return eb.and(conditions);
  };
}

@Injectable()
export class DashboardRepository {
  constructor(
    @Inject(DATABASE_READ_CONNECTION)
    private readonly dbRead: Kysely<Database>,
  ) {}



async findDailySummary(filters: FilterDashboard) {
  return this.dbRead
    .selectFrom("bets as b")
    .where(dashboardFilters(filters))
    .select(({ fn }) => [
      betCalendarDateBr.as("date"),
      fn.count("b.id").as("totalBets"),
      fn<number>("coalesce", [fn.sum<number>("b.profit"), sql.lit(0)]).as("profitDay"),
    ])
    .groupBy(betCalendarDateBr)
    .orderBy(betCalendarDateBr, "asc")
    .execute();
}
async findMonthlySummary(filters: FilterDashboard) {
  return this.dbRead
    .selectFrom("bets as b")
    .leftJoin("betResults as br", "br.betId", "b.id")
    .where(dashboardFilters(filters))
    .select((eb) => [
      betCalendarMonthBr.as("month"),
      eb.fn.count("b.id").as("totalBets"),
      eb.fn<number>("coalesce", [eb.fn.sum<number>("b.profit"), sql.lit(0)]).as("profitMonth"),
      // Base do ROI do mês, igual à das métricas: só o stake já liquidado.
      eb.fn<number>("coalesce", [
        eb.fn.sum<number>(eb.case().when("br.resultId", "in", SETTLED_RESULT_IDS as any).then(eb.ref("b.stake")).else(0).end()),
        sql.lit(0),
      ]).as("settledStake"),
    ])
    .groupBy(betCalendarMonthBr)
    .orderBy(betCalendarMonthBr, "asc")
    .execute();
}
// Lucro por casa no periodo. Casa sem lucro/prejuizo (so pendentes) fica de fora.
async findProfitByHouse(filters: FilterDashboard) {
  return this.dbRead
    .selectFrom("bets as b")
    .leftJoin("bettingHouses as bh", "bh.id", "b.houseId")
    .where(dashboardFilters(filters))
    .select(({ fn }) => [
      sql<string>`coalesce(${sql.ref("bh.name")}, 'Sem casa')`.as("house"),
      fn.sum<string>("b.profit").as("profit"),
    ])
    .groupBy("bh.name")
    .having(({ fn }) => fn("coalesce", [fn.sum("b.profit"), sql.lit(0)]), "!=", 0)
    .orderBy("profit", "desc")
    .execute();
}
// Desempenho por esporte no periodo, com as mesmas bases das metricas do
// dashboard: acerto = ganhas / (ganhas + perdidas), ROI = lucro / stake
// liquidado. Aposta sem esporte vira "Outros".
async findBetsBySport(filters: FilterDashboard) {
  return this.dbRead
    .selectFrom("bets as b")
    .leftJoin("sports as s", "s.id", "b.sportId")
    .leftJoin("betResults as br", "br.betId", "b.id")
    .where(dashboardFilters(filters))
    .select((eb) => [
      sql<string>`coalesce(${sql.ref("s.name")}, 'Outros')`.as("sport"),
      eb.fn.count("b.id").as("bets"),
      eb.fn<number>("sum", [eb.case().when("br.resultId", "=", ResultIdEnum.PENDING as any).then(1).else(0).end()]).as("pendingBets"),
      eb.fn<number>("sum", [eb.case().when("br.resultId", "in", WON_RESULT_IDS as any).then(1).else(0).end()]).as("wonBets"),
      eb.fn<number>("sum", [eb.case().when("br.resultId", "in", LOST_RESULT_IDS as any).then(1).else(0).end()]).as("lostBets"),
      eb.fn<number>("coalesce", [
        eb.fn.sum<number>(eb.case().when("br.resultId", "in", SETTLED_RESULT_IDS as any).then(eb.ref("b.stake")).else(0).end()),
        sql.lit(0),
      ]).as("settledStake"),
      eb.fn<number>("coalesce", [eb.fn.sum<number>("b.profit"), sql.lit(0)]).as("profit"),
    ])
    .groupBy("s.name")
    .orderBy("bets", "desc")
    .execute();
}
async findBetDateRange(userId: UserId) {
  return this.dbRead
    .selectFrom("bets as b")
    .where("b.deletedAt", "is", null)
    .where("b.userId", "=", userId)
    .select((eb) => [
      eb.fn.min(betDate).as("firstBetDate"),
      eb.fn.max(betDate).as("lastBetDate"),
    ])
    .executeTakeFirst();
}

async findDashboardMetrics(filters: FilterDashboard) {
  return this.dbRead
    .selectFrom("bets as b")
    .leftJoin("betResults as br", "br.betId", "b.id")
    .where(dashboardFilters(filters))
    .select((eb) => [
      eb.fn.count("b.id").as("totalBets"),
      eb.fn<number>("sum", [eb.case().when("br.resultId", "in", SETTLED_RESULT_IDS as any).then(1).else(0).end()]).as("settledBets"),
      eb.fn<number>("sum", [
        eb
          .case()
          .when("br.resultId", "in", WON_RESULT_IDS as any)
          .then(1)
          .else(0)
          .end(),
      ]).as("wonBets"),
      eb.fn<number>("sum", [
        eb
          .case()
          .when("br.resultId", "in", LOST_RESULT_IDS as any)
          .then(1)
          .else(0)
          .end(),
      ]).as("lostBets"),
      eb.fn<number>("sum", [
        eb
          .case()
          .when("br.resultId", "=", ResultIdEnum.PENDING as any)
          .then(1)
          .else(0)
          .end(),
      ]).as("pendingBets"),
      eb.fn<number>("sum", [
        eb
          .case()
          .when("br.resultId", "=", ResultIdEnum.CANCELED as any)
          .then(1)
          .else(0)
          .end(),
      ]).as("canceledBets"),
      eb.fn<number>("coalesce", [eb.fn.avg<number>("b.stake"), sql.lit(0)]).as("averageStake"),
      eb.fn<number>("coalesce", [eb.fn.avg<number>("b.odd"), sql.lit(0)]).as("averageOdd"),
      eb.fn<number>("coalesce", [eb.fn.sum<number>("b.stake"), sql.lit(0)]).as("totalStaked"),
      // Base do ROI: so' o que ja' liquidou. Pendente ainda nao tem lucro e
      // cancelada devolve a stake — dividir por elas encolhia o ROI.
      eb.fn<number>("coalesce", [
        eb.fn.sum<number>(eb.case().when("br.resultId", "in", SETTLED_RESULT_IDS as any).then(eb.ref("b.stake")).else(0).end()),
        sql.lit(0),
      ]).as("settledStake"),
      eb.fn<number>("coalesce", [eb.fn.sum<number>("b.profit"), sql.lit(0)]).as("totalProfit"),
      // Maior green / maior red de uma aposta só, entre as liquidadas.
      eb.fn<number>("coalesce", [
        eb.fn.max<number>(eb.case().when("br.resultId", "in", SETTLED_RESULT_IDS as any).then(eb.ref("b.profit")).end()),
        sql.lit(0),
      ]).as("biggestWin"),
      eb.fn<number>("coalesce", [
        eb.fn.min<number>(eb.case().when("br.resultId", "in", SETTLED_RESULT_IDS as any).then(eb.ref("b.profit")).end()),
        sql.lit(0),
      ]).as("biggestLoss"),
    ])
    .executeTakeFirst();
}

// Lucro das liquidadas em ordem cronológica: base da sequência atual e do
// drawdown, que dependem da ordem e não saem de um agregado simples.
async findSettledProfits(filters: FilterDashboard) {
  return this.dbRead
    .selectFrom("bets as b")
    .innerJoin("betResults as br", "br.betId", "b.id")
    .where(dashboardFilters(filters))
    .where("br.resultId", "in", SETTLED_RESULT_IDS as any)
    .select("b.profit")
    .orderBy(betDate, "asc")
    .orderBy("b.id", "asc")
    .execute();
}
}
