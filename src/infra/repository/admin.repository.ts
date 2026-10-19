import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DATABASE_READ_CONNECTION } from '../db/db.module';
import type { Database } from '../db/database.types';
import { ResultIdEnum } from '../../bet/dto/result-id.enum';
import type { ResultId } from '../../db_types/Results';
import type { UserId } from '../../db_types/Users';

// Uma tip sem entrega envelhece: passadas 24h não há o que investigar, o
// fan-out daquela rodada já era. A janela mantém o card olhando pro que ainda
// dá pra consertar.
const DELIVERY_WINDOW_HOURS = 24;
// Evento sem placar só interessa enquanto o coletor ainda busca aquela data.
// Sem esse corte o card acumularia todo jogo velho que nunca foi coletado e o
// número pararia de significar "o coletor está atrasado".
const COLLECT_WINDOW_DAYS = 7;

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60_000);

export interface UndeliveredTipRow {
  id: number;
  text: string;
  percent: number | null;
  createdAt: Date;
}

/**
 * Consultas da tela de admin. Vivem num repositório próprio porque cruzam
 * tabelas de domínios diferentes (tips, eventos, apostas, usuários) só pra
 * responder "o pipeline está de pé?" — não pertencem a nenhum dos repositórios
 * existentes.
 *
 * Só leitura: a escrita da tela (mudar papel, desbloquear, desvincular) passa
 * pelo UsersRepository, que já sabe fazer isso.
 */
@Injectable()
export class AdminRepository {
  constructor(
    @Inject(DATABASE_READ_CONNECTION)
    private readonly dbRead: Kysely<Database>,
  ) {}

  /** `max()` de cada etapa: quando cada uma rodou pela última vez. */
  private async lastActivity() {
    const [tip, delivery, event, result] = await Promise.all([
      this.dbRead
        .selectFrom('tips')
        .select((eb) => eb.fn.max('createdAt').as('at'))
        .executeTakeFirst(),
      this.dbRead
        .selectFrom('tipDeliveries')
        .select((eb) => eb.fn.max('createdAt').as('at'))
        .executeTakeFirst(),
      this.dbRead
        .selectFrom('sportEvents')
        .select((eb) => eb.fn.max('fetchedAt').as('at'))
        .executeTakeFirst(),
      this.dbRead
        .selectFrom('eventResults')
        .select((eb) => eb.fn.max('fetchedAt').as('at'))
        .executeTakeFirst(),
    ]);

    return {
      lastTipAt: tip?.at ?? null,
      lastDeliveryAt: delivery?.at ?? null,
      lastEventFetchAt: event?.at ?? null,
      lastResultFetchAt: result?.at ?? null,
    };
  }

  /**
   * Tips recentes que não geraram nenhuma DM.
   *
   * Nem toda linha aqui é falha: aviso não vira mensagem (por isso o filtro de
   * `isAviso`) e tip com percentual abaixo do `minPercentFilter` de todos os
   * usuários legitimamente não entrega pra ninguém. Por isso devolve a lista, e
   * não só a contagem — o texto e o percentual são o que distingue bug de
   * filtro.
   */
  async undeliveredTips(): Promise<UndeliveredTipRow[]> {
    const rows = await this.dbRead
      .selectFrom('tips')
      .leftJoin('tipDeliveries as d', 'd.tipId', 'tips.id')
      .where('tips.createdAt', '>', hoursAgo(DELIVERY_WINDOW_HOURS))
      .where('tips.isAviso', '=', false)
      .where('d.id', 'is', null)
      .select(['tips.id as id', 'tips.text as text', 'tips.percent as percent', 'tips.createdAt as createdAt'])
      .orderBy('tips.createdAt', 'desc')
      .execute();

    return rows as UndeliveredTipRow[];
  }

  /**
   * Jogos que já começaram, têm aposta em cima e o coletor não trouxe placar.
   *
   * O "têm aposta em cima" não é detalhe: o coletor guarda a tabela inteira das
   * ligas que acompanha, e a maioria desses jogos nunca vai ser conferida por
   * ninguém. Sem esse filtro o número passa de 450 e o card vive vermelho
   * dizendo nada. Com ele, cada unidade é uma aposta que não consegue liquidar.
   */
  private async startedEventsWithoutResult(): Promise<number> {
    const row = await this.dbRead
      .selectFrom('sportEvents as se')
      .leftJoin('eventResults as er', (join) =>
        join
          .onRef('er.provider', '=', 'se.provider')
          .onRef('er.externalId', '=', 'se.externalId'),
      )
      .where('se.startAt', '<', new Date())
      .where('se.startAt', '>', daysAgo(COLLECT_WINDOW_DAYS))
      .where('er.externalId', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('bets as b')
            .where('b.deletedAt', 'is', null)
            .select('b.id')
            .whereRef('b.eventProvider', '=', 'se.provider')
            .whereRef('b.eventExternalId', '=', 'se.externalId'),
        ),
      )
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .executeTakeFirst();

    return Number(row?.total ?? 0);
  }

  /**
   * Apostas SUAS, pendentes, com placar coletado e sem sugestão nenhuma.
   *
   * Por que só as suas: o motor não roda sozinho pra todo mundo — ele é
   * disparado pela tela de conferência de cada usuário. Contar o banco inteiro
   * mediria quem não abriu a tela (316 aqui), não saúde de pipeline. Com o
   * recorte, o número é trabalho que o placar já permite fazer e não foi feito.
   */
  private async pendingBetsWithoutSuggestion(userId: UserId): Promise<number> {
    const row = await this.dbRead
      .selectFrom('bets')
      .where('deletedAt', 'is', null)
      .innerJoin('betResults', 'betResults.betId', 'bets.id')
      .innerJoin('eventResults as er', (join) =>
        join
          .onRef('er.provider', '=', 'bets.eventProvider')
          .onRef('er.externalId', '=', 'bets.eventExternalId'),
      )
      .leftJoin('betSettlementSuggestions as s', 's.betId', 'bets.id')
      .where('bets.userId', '=', userId)
      .where('betResults.resultId', '=', ResultIdEnum.PENDING as ResultId)
      .where('s.betId', 'is', null)
      .select((eb) => eb.fn.count<string>('bets.id').distinct().as('total'))
      .executeTakeFirst();

    return Number(row?.total ?? 0);
  }

  /**
   * Duas contagens sobre a mesma tabela, também só das suas apostas: o que o
   * motor não soube decidir (`suggestedResultId` nulo) e o que ele decidiu e
   * espera confirmação na tela de conferência. A segunda não é defeito — é fila
   * de trabalho, e a tela mostra ela em cinza por isso.
   */
  private async suggestionCounts(userId: UserId) {
    const row = await this.dbRead
      .selectFrom('betSettlementSuggestions as s')
      .innerJoin('bets', (join) => join.onRef('bets.id', '=', 's.betId').on('bets.deletedAt', 'is', null))
      .innerJoin('betResults', 'betResults.betId', 's.betId')
      .where('bets.userId', '=', userId)
      .where('s.dismissedAt', 'is', null)
      .where('betResults.resultId', '=', ResultIdEnum.PENDING as ResultId)
      .select((eb) => [
        eb.fn
          .count<string>('s.betId')
          .filterWhere('s.suggestedResultId', 'is', null)
          .as('undecided'),
        eb.fn
          .count<string>('s.betId')
          .filterWhere('s.suggestedResultId', 'is not', null)
          .as('awaitingUser'),
      ])
      .executeTakeFirst();

    return {
      undecidedSuggestions: Number(row?.undecided ?? 0),
      suggestionsAwaitingUser: Number(row?.awaitingUser ?? 0),
    };
  }

  private async usersByRole() {
    const rows = await this.dbRead
      .selectFrom('users')
      .select((eb) => ['users.roleId as roleId', eb.fn.countAll<string>().as('total')])
      .groupBy('users.roleId')
      .execute();

    const by = (roleId: number) =>
      Number(rows.find((r) => Number(r.roleId) === roleId)?.total ?? 0);

    return { admin: by(1), user: by(3) };
  }

  /**
   * Filtro de % de quem realmente recebe DM hoje. Serve pra separar, entre as
   * tips sem entrega, as que deveriam ter chegado em alguém.
   *
   * "Realmente recebe" = teve alguma entrega na última semana. Conta vinculada
   * não basta: o fan-out também pula quem saiu do grupo de Tips, e isso só o
   * Telegram sabe — aqui há três contas vinculadas que nunca receberam nada.
   * Contá-las marcaria toda tip fraca como suspeita.
   *
   * Se ninguém recebeu nada na semana, cai pra todas as contas vinculadas: aí o
   * silêncio é justamente o que se quer ver marcado.
   */
  private async deliveryFilters(): Promise<(number | null)[]> {
    const linked = this.dbRead.selectFrom('users').select('minPercentFilter').where('telegramUserId', 'is not', null);

    const active = await linked
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('tipDeliveries as d')
            .select('d.id')
            .whereRef('d.userId', '=', 'users.id')
            .where('d.createdAt', '>', daysAgo(7)),
        ),
      )
      .execute();

    const rows = active.length ? active : await linked.execute();

    return rows.map((r) => (r.minPercentFilter === null ? null : Number(r.minPercentFilter)));
  }

  /** `userId` é o admin que pediu: os cards de liquidação são das apostas dele. */
  async overview(userId: UserId) {
    const [
      activity,
      undeliveredTips,
      deliveryFilters,
      startedEventsWithoutResult,
      pendingBetsWithoutSuggestion,
      suggestions,
      usersByRole,
    ] = await Promise.all([
      this.lastActivity(),
      this.undeliveredTips(),
      this.deliveryFilters(),
      this.startedEventsWithoutResult(),
      this.pendingBetsWithoutSuggestion(userId),
      this.suggestionCounts(userId),
      this.usersByRole(),
    ]);

    return {
      ...activity,
      undeliveredTips,
      deliveryFilters,
      startedEventsWithoutResult,
      pendingBetsWithoutSuggestion,
      ...suggestions,
      usersByRole,
    };
  }

  /**
   * Lista da tabela de usuários. `passwordHash` fica de fora por seleção
   * explícita — `selectAll()` aqui vazaria o hash de todo mundo numa rota só.
   */
  async listUsers() {
    return this.dbRead
      .selectFrom('users as u')
      .leftJoin('bets as b', (join) => join.onRef('b.userId', '=', 'u.id').on('b.deletedAt', 'is', null))
      .select((eb) => [
        'u.id as id',
        'u.username as username',
        'u.email as email',
        'u.fullName as fullName',
        'u.roleId as roleId',
        'u.isActive as isActive',
        'u.lastLogin as lastLogin',
        'u.createdAt as createdAt',
        'u.lockedUntil as lockedUntil',
        'u.failedLoginAttempts as failedLoginAttempts',
        'u.telegramLinkedAt as telegramLinkedAt',
        'u.telegramUserId as telegramUserId',
        'u.accessUntil as accessUntil',
        'u.tipsGroupRemovedAt as tipsGroupRemovedAt',
        'u.subscriptionStatus as subscriptionStatus',
        eb.fn.count<string>('b.id').as('betCount'),
      ])
      .groupBy([
        'u.id',
        'u.username',
        'u.email',
        'u.fullName',
        'u.roleId',
        'u.isActive',
        'u.lastLogin',
        'u.createdAt',
        'u.lockedUntil',
        'u.failedLoginAttempts',
        'u.telegramLinkedAt',
        'u.telegramUserId',
        'u.accessUntil',
        'u.tipsGroupRemovedAt',
        'u.subscriptionStatus',
      ])
      .orderBy('u.username')
      .execute();
  }
}
