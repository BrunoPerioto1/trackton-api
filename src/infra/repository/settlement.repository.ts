import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import {
  DATABASE_READ_CONNECTION,
  DATABASE_WRITE_CONNECTION,
} from '../db/db.module';
import type { Database } from '../db/database.types';
import { BetId } from '../../db_types/Bet';
import { UserId } from '../../db_types/Users';
import { ResultId } from '../../db_types/Results';
import { ResultIdEnum } from '../../bet/dto/result-id.enum';
import { ENGINE_VERSION } from '../../settlement/settle';

export interface SettleableBet {
  id: BetId;
  game: string;
  market: string;
  homeName: string | null;
  awayName: string | null;
  homeScore: number | null;
  awayScore: number | null;
  eventStatus: string | null;
  sport: string | null;
  eventSport: string | null;
  scoreScope: string | null;
  facts: unknown;
}

@Injectable()
export class SettlementRepository {
  constructor(
    @Inject(DATABASE_WRITE_CONNECTION)
    private readonly dbWrite: Kysely<Database>,
    @Inject(DATABASE_READ_CONNECTION)
    private readonly dbRead: Kysely<Database>,
  ) {}

  /**
   * Por aposta, o placar mais recente entre os jogos de uma multipla de varios
   * jogos (bet_events). bets.event_* so' guarda o jogo que abre a multipla — ou
   * nada, se algum confronto nao casou —, entao sem isto placar novo de outra
   * perna nao invalidaria a sugestao, e multipla sem evento principal nunca
   * entraria na fila.
   */
  private legsFetched() {
    return this.dbRead
      .selectFrom('betEvents as be')
      .innerJoin('eventResults as ler', (join) =>
        join
          .onRef('ler.provider', '=', 'be.provider')
          .onRef('ler.externalId', '=', 'be.externalId'),
      )
      .select('be.betId as betId')
      .select((eb) => eb.fn.max('ler.fetchedAt').as('fetchedAt'))
      .groupBy('be.betId');
  }

  /** Jogos das multiplas de varios jogos, cada um com placar e fatos proprios. */
  async findLegs(betIds: BetId[]) {
    if (!betIds.length) return [];
    const rows = await this.dbRead
      .selectFrom('betEvents as be')
      .leftJoin('eventResults as er', (join) =>
        join
          .onRef('er.provider', '=', 'be.provider')
          .onRef('er.externalId', '=', 'be.externalId'),
      )
      .leftJoin('eventFacts as f', (join) =>
        join
          .onRef('f.provider', '=', 'er.provider')
          .onRef('f.externalId', '=', 'er.externalId')
          .onRef('f.fetchedAt', '=', 'er.fetchedAt')
          .on('f.formatVersion', '=', 1),
      )
      .where('be.betId', 'in', betIds)
      .select([
        'be.betId as betId',
        'be.position as position',
        'er.homeName as homeName',
        'er.awayName as awayName',
        'er.homeScore as homeScore',
        'er.awayScore as awayScore',
        'er.status as eventStatus',
        'er.sport as eventSport',
        'er.scoreScope as scoreScope',
        // Texto pelo mesmo motivo de findSettleable: o CamelCasePlugin
        // renomearia as chaves de `periods`.
        sql<string | null>`f.data_json::text`.as('facts'),
      ])
      .orderBy('be.betId')
      .orderBy('be.position')
      .execute();

    return rows.map(({ facts, ...row }) => ({
      ...row,
      facts: facts == null ? null : (JSON.parse(facts) as unknown),
    }));
  }

  /**
   * Apostas ainda pendentes cujo jogo ja' terminou, ja' tem placar coletado e
   * cuja sugestao esta' desatualizada — ou seja, so' o que mudou desde a ultima
   * recomputacao.
   *
   * A sugestao vale enquanto as duas entradas que a geraram nao mudarem: o
   * placar (`event_results.fetched_at`, que o provider pode corrigir) e a
   * propria aposta (`bets.updated_at`, quando o usuario arruma o texto do
   * mercado). Se `computed_at` e' mais novo que ambos, recalcular daria
   * exatamente a mesma frase. Sem esse filtro, toda abertura da tela
   * reprocessava o historico inteiro do usuario e reescrevia as mesmas linhas.
   * Com ele, o `limit` vira lote: o que sobrou continua sendo candidato na
   * proxima chamada, e o mais antigo vem primeiro pra fila drenar em ordem em
   * vez de ficar preso atras dos recentes.
   *
   * Sugestao recusada nao volta pra ca': ela ja' esta' invisivel na tela e o
   * upsert nao ressuscita `dismissed_at`, entao recalcular seria trabalho jogado
   * fora.
   *
   * Os nomes dos times vem de sport_events quando o cache ainda tem o jogo;
   * quando ja' expirou, caem pro texto do proprio `game`, que o avaliador
   * consegue quebrar. Nao e' motivo pra deixar de liquidar.
   */
  /**
   * Quem tem aposta pendente — o universo do calculo em lote do cron. Conta
   * inativa fica de fora: nao entra no app nem recebe aviso. O Gratis tambem:
   * conferencia pelo placar e' do Pro (mesma regra do plan.ts isPro).
   */
  async findUsersWithPendingBets(): Promise<UserId[]> {
    const rows = await this.dbRead
      .selectFrom('bets')
      .innerJoin('betResults', 'betResults.betId', 'bets.id')
      .innerJoin('users', 'users.id', 'bets.userId')
      .where('bets.deletedAt', 'is', null)
      .where('betResults.resultId', '=', ResultIdEnum.PENDING as ResultId)
      .where((eb) => eb.or([eb('users.isActive', 'is', null), eb('users.isActive', '=', true)]))
      .where((eb) => eb.or([eb('users.accessUntil', 'is', null), eb('users.accessUntil', '>', new Date())]))
      .select('bets.userId')
      .distinct()
      .execute();
    return rows.flatMap((row) => (row.userId == null ? [] : [row.userId]));
  }

  /**
   * Contadores da fila. A tela precisa deles no load: hoje esses numeros so'
   * existem na resposta do ultimo `compute`, entao um F5 apaga tanto o aviso de
   * fila restante quanto o de aposta sem proposta.
   *
   * `undecided` sao as apostas que o bot analisou e nao soube resolver. Elas
   * seguem pendentes e nunca entram na lista de propostas — sem esse numero,
   * virariam silencio na tela.
   */
  async queue(userId: UserId): Promise<{
    pending: number;
    settleable: number;
    overdue: number;
    suggestions: number;
    undecided: number;
  }> {
    const [bets, suggestions] = await Promise.all([
      this.dbRead
        .selectFrom('bets')
        .where('deletedAt', 'is', null)
        .innerJoin('betResults', 'betResults.betId', 'bets.id')
        // left join: aposta pendente sem placar coletado ainda conta em
        // `pending`, so' nao entra em `settleable`.
        .leftJoin('eventResults', (join) =>
          join
            .onRef('eventResults.provider', '=', 'bets.eventProvider')
            .onRef('eventResults.externalId', '=', 'bets.eventExternalId'),
        )
        .leftJoin('betSettlementSuggestions as s', 's.betId', 'bets.id')
        .leftJoin(this.legsFetched().as('legs'), (join) =>
          join.onRef('legs.betId', '=', 'bets.id'),
        )
        .where('bets.userId', '=', userId)
        .where('betResults.resultId', '=', ResultIdEnum.PENDING as ResultId)
        .select((eb) => [
          eb.fn.countAll<string>().as('pending'),
          eb.fn
            .count<string>('bets.id')
            // Mesmo filtro de findSettleable: o que entraria no proximo lote.
            // Se um mudar, o outro tem que mudar junto.
            .filterWhere((fb) =>
              fb.and([
                fb.or([
                  fb('eventResults.externalId', 'is not', null),
                  fb('legs.betId', 'is not', null),
                ]),
                fb.or([
                  fb('s.betId', 'is', null),
                  fb.and([
                    fb('s.dismissedAt', 'is', null),
                    fb.or([
                      fb('s.engineVersion', 'is', null),
                      fb('s.engineVersion', '!=', ENGINE_VERSION),
                      fb('s.computedAt', '<', fb.ref('eventResults.fetchedAt')),
                      fb('s.computedAt', '<', fb.ref('legs.fetchedAt')),
                      fb('s.computedAt', '<', fb.ref('bets.updatedAt')),
                    ]),
                  ]),
                ]),
              ]),
            )
            .as('settleable'),
          eb.fn
            .count<string>('bets.id')
            // Pendente de jogo que ja acabou: e' a que pede atencao. Aposta de
            // jogo de amanha tambem e' pendente, e contar ela no menu fazia o
            // numero nunca zerar. Acabou = placar coletado, ou inicio ha mais
            // de 3h; sem jogo casado, planilhada ha mais de um dia.
            .filterWhere((fb) =>
              fb.or([
                fb('eventResults.externalId', 'is not', null),
                fb('bets.eventStartAt', '<', sql<Date>`now() - interval '3 hours'`),
                fb.and([
                  fb('bets.eventStartAt', 'is', null),
                  fb('bets.betTime', '<', sql<Date>`now() - interval '1 day'`),
                ]),
              ]),
            )
            .as('overdue'),
        ])
        .executeTakeFirstOrThrow(),
      this.dbRead
        .selectFrom('betSettlementSuggestions as s')
        .innerJoin('bets', (join) => join.onRef('bets.id', '=', 's.betId').on('bets.deletedAt', 'is', null))
        .innerJoin('betResults', 'betResults.betId', 'bets.id')
        .leftJoin('eventResults as er', (join) =>
          join
            .onRef('er.provider', '=', 'bets.eventProvider')
            .onRef('er.externalId', '=', 'bets.eventExternalId'),
        )
        .leftJoin(this.legsFetched().as('legs'), (join) =>
          join.onRef('legs.betId', '=', 'bets.id'),
        )
        .where('bets.userId', '=', userId)
        .where('betResults.resultId', '=', ResultIdEnum.PENDING as ResultId)
        .where('s.dismissedAt', 'is', null)
        .where('s.engineVersion', '=', ENGINE_VERSION)
        // Mesma cerca de frescor de findPendingSuggestions: o contador tem que
        // bater com a lista que a tela mostra, nao com o que ficou no banco.
        .whereRef('s.computedAt', '>=', 'bets.updatedAt')
        .where((eb) =>
          eb.and([
            eb.or([eb('er.externalId', 'is not', null), eb('legs.betId', 'is not', null)]),
            eb.or([eb('er.fetchedAt', 'is', null), eb('s.computedAt', '>=', eb.ref('er.fetchedAt'))]),
            eb.or([eb('legs.fetchedAt', 'is', null), eb('s.computedAt', '>=', eb.ref('legs.fetchedAt'))]),
          ]),
        )
        .select((eb) => [
          eb.fn
            .count<string>('s.betId')
            .filterWhere('s.suggestedResultId', 'is not', null)
            .as('suggestions'),
          eb.fn
            .count<string>('s.betId')
            .filterWhere('s.suggestedResultId', 'is', null)
            .as('undecided'),
        ])
        .executeTakeFirstOrThrow(),
    ]);

    return {
      pending: Number(bets.pending),
      settleable: Number(bets.settleable),
      overdue: Number(bets.overdue),
      suggestions: Number(suggestions.suggestions),
      undecided: Number(suggestions.undecided),
    };
  }

  async findSettleable(userId: UserId, limit = 200): Promise<SettleableBet[]> {
    const rows = await this.dbRead
      .selectFrom('bets')
      .where('deletedAt', 'is', null)
      .innerJoin('betResults', 'betResults.betId', 'bets.id')
      // left join: multipla de varios jogos pode nao ter evento principal e
      // ainda assim ter placar nas pernas (legs).
      .leftJoin('eventResults', (join) =>
        join
          .onRef('eventResults.provider', '=', 'bets.eventProvider')
          .onRef('eventResults.externalId', '=', 'bets.eventExternalId'),
      )
      .leftJoin(this.legsFetched().as('legs'), (join) =>
        join.onRef('legs.betId', '=', 'bets.id'),
      )
      .leftJoin('sportEvents', (join) =>
        join
          .onRef('sportEvents.provider', '=', 'bets.eventProvider')
          .onRef('sportEvents.externalId', '=', 'bets.eventExternalId'),
      )
      .leftJoin('betSettlementSuggestions as s', 's.betId', 'bets.id')
      .leftJoin('eventFacts as f', (join) => join
        .onRef('f.provider', '=', 'eventResults.provider')
        .onRef('f.externalId', '=', 'eventResults.externalId')
        .onRef('f.fetchedAt', '=', 'eventResults.fetchedAt')
        .on('f.formatVersion', '=', 1))
      .where('bets.userId', '=', userId)
      .where('betResults.resultId', '=', ResultIdEnum.PENDING as ResultId)
      .where((eb) =>
        eb.or([
          eb('eventResults.externalId', 'is not', null),
          eb('legs.betId', 'is not', null),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('s.betId', 'is', null),
          eb.and([
            eb('s.dismissedAt', 'is', null),
            eb.or([
              eb('s.engineVersion', 'is', null),
              eb('s.engineVersion', '!=', ENGINE_VERSION),
              eb('s.computedAt', '<', eb.ref('eventResults.fetchedAt')),
              eb('s.computedAt', '<', eb.ref('legs.fetchedAt')),
              eb('s.computedAt', '<', eb.ref('bets.updatedAt')),
            ]),
          ]),
        ]),
      )
      .select([
        'bets.id as id',
        'bets.game as game',
        'bets.market as market',
        'eventResults.homeName as homeName',
        'eventResults.awayName as awayName',
        'bets.sport as sport',
        'eventResults.sport as eventSport',
        'eventResults.scoreScope as scoreScope',
        // Texto, nao jsonb: o CamelCasePlugin tambem renomeia chave de objeto
        // aninhado, e `periods.FIRST_HALF` virava `FIRSTHALF` — todo mercado
        // de tempo ficava "placar do primeiro tempo indisponivel" com o dado
        // no banco. String passa pelo plugin intacta; o parse e' logo abaixo.
        sql<string | null>`f.data_json::text`.as('facts'),
        'eventResults.homeScore as homeScore',
        'eventResults.awayScore as awayScore',
        'eventResults.status as eventStatus',
      ])
      .orderBy('bets.eventStartAt', 'asc')
      .limit(limit)
      .execute();

    return rows.map(({ facts, ...row }) => ({
      ...row,
      facts: facts == null ? null : (JSON.parse(facts) as unknown),
    })) as unknown as SettleableBet[];
  }

  async saveSuggestions(
    suggestions: {
      betId: BetId;
      suggestedResultId: number | null;
      reason: string | null;
      explanation: string;
      homeScore: number | null;
      awayScore: number | null;
    }[],
  ) {
    if (!suggestions.length) return;
    await this.dbWrite
      .insertInto('betSettlementSuggestions')
      .values(
        suggestions.map((s) => ({
          ...s,
          // Relogio do banco, nao do Node. As colunas sao `timestamp without
          // time zone`: o pg grava `new Date()` na hora local da maquina
          // (UTC-3 em Sao Paulo), enquanto `event_results.fetched_at` e o
          // trigger de `bets.updated_at` usam CURRENT_TIMESTAMP em UTC. Com
          // `new Date()`, `computed_at` nascia 3h "antes" do placar: a lista
          // escondia a sugestao recem-calculada e o proximo compute pegava
          // ela de novo, pra sempre.
          computedAt: sql<Date>`CURRENT_TIMESTAMP`,
          engineVersion: ENGINE_VERSION,
          dismissedAt: null,
        })),
      )
      // Recomputar e' idempotente: o placar pode ter sido corrigido pelo
      // provider. `dismissedAt` nao entra no update pra nao ressuscitar
      // sugestao que o usuario ja' recusou.
      .onConflict((oc) =>
        oc.column('betId').doUpdateSet((eb) => ({
          suggestedResultId: eb.ref('excluded.suggestedResultId'),
          reason: eb.ref('excluded.reason'),
          explanation: eb.ref('excluded.explanation'),
          homeScore: eb.ref('excluded.homeScore'),
          awayScore: eb.ref('excluded.awayScore'),
          computedAt: eb.ref('excluded.computedAt'),
          engineVersion: eb.ref('excluded.engineVersion'),
        })),
      )
      .execute();
  }

  /**
   * Sugestoes decididas e ainda nao recusadas, prontas pra tela.
   *
   * `betIds` restringe ao que o usuario marcou — e' o que a confirmacao usa pra
   * nao trazer a lista inteira do banco so' pra descartar quase tudo em memoria.
   */
  async findPendingSuggestions(userId: UserId, betIds?: BetId[], review = false) {
    // `in ()` nao e' SQL valido; lista vazia nao tem o que buscar.
    if (betIds && !betIds.length) return [];

    let query = this.dbRead
      .selectFrom('betSettlementSuggestions as s')
      .innerJoin('bets', (join) => join.onRef('bets.id', '=', 's.betId').on('bets.deletedAt', 'is', null))
      .innerJoin('betResults', 'betResults.betId', 'bets.id')
      .leftJoin('eventResults as er', (join) => join
        .onRef('er.provider', '=', 'bets.eventProvider')
        .onRef('er.externalId', '=', 'bets.eventExternalId'))
      .leftJoin(this.legsFetched().as('legs'), (join) => join.onRef('legs.betId', '=', 'bets.id'))
      .where('bets.userId', '=', userId)
      .where('betResults.resultId', '=', ResultIdEnum.PENDING as ResultId)
      .where('s.dismissedAt', 'is', null)
      .where('s.engineVersion', '=', ENGINE_VERSION)
      .whereRef('s.computedAt', '>=', 'bets.updatedAt')
      // Frescor contra o placar do jogo principal E contra o de cada perna da
      // multipla — mesma cerca de queue().
      .where((eb) => eb.and([
        eb.or([eb('er.externalId', 'is not', null), eb('legs.betId', 'is not', null)]),
        eb.or([eb('er.fetchedAt', 'is', null), eb('s.computedAt', '>=', eb.ref('er.fetchedAt'))]),
        eb.or([eb('legs.fetchedAt', 'is', null), eb('s.computedAt', '>=', eb.ref('legs.fetchedAt'))]),
      ]));

    query = review ? query.where('s.suggestedResultId', 'is', null) : query.where('s.suggestedResultId', 'is not', null);

    if (betIds) query = query.where('s.betId', 'in', betIds);

    return query
      .select([
        's.betId as betId',
        's.suggestedResultId as suggestedResultId',
        's.explanation as explanation',
        's.reason as reason',
        's.homeScore as homeScore',
        's.awayScore as awayScore',
        's.computedAt as computedAt',
        'bets.game as game',
        'bets.market as market',
        'bets.stake as stake',
        'bets.odd as odd',
        'bets.eventStartAt as eventStartAt',
      ])
      .orderBy('bets.eventStartAt', 'desc')
      .execute();
  }

  /** -> quantas sugestoes a recusa realmente atingiu (id de outro usuario nao conta). */
  async dismiss(betIds: BetId[], userId: UserId): Promise<number> {
    if (!betIds.length) return 0;
    const result = await this.dbWrite
      .updateTable('betSettlementSuggestions')
      .set({ dismissedAt: new Date() })
      .where('betId', 'in', betIds)
      // Cerca de dono: sem isso um id de outro usuario seria recusado aqui.
      .where((eb) =>
        eb(
          'betId',
          'in',
          eb.selectFrom('bets').select('id').where('userId', '=', userId),
        ),
      )
      .executeTakeFirst();

    return Number(result?.numUpdatedRows ?? 0);
  }
}
