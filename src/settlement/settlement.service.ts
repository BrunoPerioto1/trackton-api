import { Injectable, Logger } from '@nestjs/common';
import { SettlementRepository } from '../infra/repository/settlement.repository';
import { BetService } from '../bet/bet.service';
import { UserId } from '../db_types/Users';
import { BetId } from '../db_types/Bet';
import { ResultIdEnum } from '../bet/dto/result-id.enum';
import { settleBet } from './settle';
import { decodeFacts } from './event-facts';
import { normalize } from './market-parser';
import { splitConfronto } from '../bet/event-matching';
import { EventLeg, settleMultiEvent } from './multi-event';
import { SettlementContext } from './settlement.types';

const football = (sport: string | null) =>
  ['futebol', 'football', 'soccer'].includes(normalize(sport ?? ''));

function contexto(
  facts: unknown,
  sport: string | null,
  eventSport: string | null,
  scoreScope: string | null,
): SettlementContext {
  return {
    ...decodeFacts(facts),
    sport:
      sport == null && eventSport == null
        ? 'football'
        : (sport == null || football(sport)) && (eventSport == null || football(eventSport))
          ? 'football'
          : null,
    scoreScope: scoreScope == null || scoreScope === 'REGULATION' ? 'REGULATION' : 'UNKNOWN',
    // Regra da casa informada pelo usuário em 2026-09-15: vermelho vale 2
    // amarelos. O coletor já grava cardPoints nessa regra.
    cardCounting: 'RED_COUNTS_TWO',
  };
}

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly repository: SettlementRepository,
    private readonly betService: BetService,
  ) {}

  // Lote de uma recomputacao. O repositorio so' devolve aposta cuja sugestao
  // esta' desatualizada, entao o que sobrar do lote continua candidato na
  // chamada seguinte — nenhuma aposta fica presa fora da janela.
  private static readonly LOTE = 200;

  /**
   * Recalcula as sugestoes das apostas pendentes com jogo ja' encerrado.
   *
   * Nao escreve resultado nenhum: so' popula bet_settlement_suggestions, que a
   * tela de conferencia mostra pro usuario confirmar.
   */
  async computeSuggestions(userId: UserId) {
    const bets = await this.repository.findSettleable(
      userId,
      SettlementService.LOTE,
    );
    // Multipla de varios jogos: cada perna olha o placar do proprio jogo.
    const pernas = bets.length
      ? await this.repository.findLegs(bets.map((bet) => bet.id))
      : [];

    const suggestions = bets.map((bet) => {
      const daAposta = pernas.filter((perna) => perna.betId === bet.id);
      if (daAposta.length) {
        const legs = daAposta
          // Perna sem placar coletado nao entra: pra liquidacao e' jogo sem
          // resultado, igual a confronto que nao casou.
          .filter((perna) => perna.eventStatus != null)
          .map(
            (perna): EventLeg => ({
              position: perna.position,
              teams: { home: perna.homeName ?? '', away: perna.awayName ?? '' },
              score:
                perna.homeScore != null && perna.awayScore != null
                  ? { home: perna.homeScore, away: perna.awayScore }
                  : null,
              eventStatus: perna.eventStatus,
              // Esporte da perna pelo provider: "Futebol" da aposta pode vir
              // como "Vários" numa multipla.
              context: contexto(perna.facts, null, perna.eventSport, perna.scoreScope),
            }),
          );
        const settlement = settleMultiEvent(bet.game, bet.market, legs);
        return {
          betId: bet.id,
          suggestedResultId: settlement.resultId,
          reason: settlement.reason,
          explanation: settlement.explanation,
          // Placar de um jogo so' enganaria numa multipla: a frase ja' traz o
          // placar de cada perna.
          homeScore: null,
          awayScore: null,
        };
      }

      // O placar vem do provider na ordem dele (mandante primeiro). Os nomes
      // saem de sport_events quando o cache ainda tem o jogo; senao, do texto
      // da aposta, que ja' foi casado com esse mesmo evento na criacao.
      const doTexto = splitConfronto(bet.game);
      const teams = {
        home: bet.homeName ?? doTexto?.home ?? '',
        away: bet.awayName ?? doTexto?.away ?? '',
      };
      const score =
        bet.homeScore != null && bet.awayScore != null
          ? { home: bet.homeScore, away: bet.awayScore }
          : null;

      const settlement = settleBet(
        bet.market,
        teams,
        score,
        bet.eventStatus,
        contexto(bet.facts, bet.sport, bet.eventSport, bet.scoreScope),
      );
      return {
        betId: bet.id,
        suggestedResultId: settlement.resultId,
        reason: settlement.reason,
        explanation: settlement.explanation,
        homeScore: bet.homeScore,
        awayScore: bet.awayScore,
      };
    });

    await this.repository.saveSuggestions(suggestions);

    const decididas = suggestions.filter((s) => s.suggestedResultId != null);
    this.logger.log(
      `usuario ${userId}: ${bets.length} apostas com placar, ` +
        `${decididas.length} com sugestao`,
    );
    return {
      analyzed: bets.length,
      suggested: decididas.length,
      undecided: suggestions.length - decididas.length,
      // Lote cheio: pode ter sobrado backlog. A tela chama de novo em vez de
      // deixar aposta antiga sem sugestao pra sempre.
      hasMore: bets.length === SettlementService.LOTE,
    };
  }

  // Teto de lotes por chamada automatica: a function da Vercel morre em 60s,
  // e o que sobrar entra na proxima chamada (a fila e' drenada em ordem).
  private static readonly LOTES_POR_CHAMADA = 5;

  /**
   * Drena a fila em lotes. Sugestao nao grava resultado nenhum, entao calcular
   * sem clique e' seguro: quem decide continua sendo o usuario, na tela.
   */
  async computeAll(userId: UserId) {
    const total = { analyzed: 0, suggested: 0, undecided: 0, hasMore: false };
    for (let lote = 0; lote < SettlementService.LOTES_POR_CHAMADA; lote++) {
      const resultado = await this.computeSuggestions(userId);
      total.analyzed += resultado.analyzed;
      total.suggested += resultado.suggested;
      total.undecided += resultado.undecided;
      total.hasMore = resultado.hasMore;
      if (!resultado.hasMore) break;
    }
    return total;
  }

  /**
   * Contadores da fila, pra tela nao depender da resposta do ultimo compute.
   *
   * Com placar esperando calculo, calcula antes de contar: o badge do menu so'
   * contava sugestao ja' calculada, e o usuario precisava entrar na tela e
   * clicar pra descobrir que tinha aposta pronta.
   */
  async queue(userId: UserId, pro = true) {
    let counts = await this.repository.queue(userId);
    // Grátis: so' os contadores das apostas dele (o "pendentes de jogo
    // encerrado" do menu); conferencia pelo placar e' do Pro e nao calcula.
    if (!pro) {
      return { ...counts, settleable: 0, suggestions: 0, undecided: 0, computed: 0, hasMore: false };
    }
    let computed = 0;
    if (counts.settleable > 0) {
      computed = (await this.computeAll(userId)).analyzed;
      counts = await this.repository.queue(userId);
    }
    return {
      ...counts,
      // Quantas acabaram de ser calculadas: a tela recarrega a lista quando >0.
      computed,
      // Sobrou candidato: a tela oferece "calcular proximo lote" em vez de dar
      // a impressao de que nao ha mais nada esperando.
      hasMore: counts.settleable > 0,
    };
  }

  /**
   * Fim do job de placar: calcula pra todo mundo com aposta pendente. Devolve
   * so' quem ganhou sugestao nova, que e' quem recebe o aviso no bot.
   */
  async computeForAllUsers() {
    const userIds = await this.repository.findUsersWithPendingBets();
    const comNovidade: { userId: UserId; suggested: number }[] = [];
    for (const userId of userIds) {
      const { suggested } = await this.computeAll(userId);
      if (suggested > 0) comNovidade.push({ userId, suggested });
    }
    return comNovidade;
  }

  async listSuggestions(userId: UserId) {
    const rows = await this.repository.findPendingSuggestions(userId);
    return rows.map((row) => ({
      betId: row.betId,
      game: row.game,
      market: row.market,
      stake: Number(row.stake),
      odd: Number(row.odd),
      eventStartAt: row.eventStartAt,
      suggestedResultId: row.suggestedResultId as ResultIdEnum,
      explanation: row.explanation,
      homeScore: row.homeScore,
      awayScore: row.awayScore,
    }));
  }

  async listReview(userId: UserId) {
    return this.repository.findPendingSuggestions(userId, undefined, true);
  }

  /**
   * Confirma as sugestoes escolhidas — e' o unico caminho pelo qual a
   * liquidacao automatica vira resultado de verdade.
   *
   * Reusa o fluxo de finalizacao que ja existe (mesmo calculo de lucro, mesma
   * transacao), agrupando por resultado sugerido.
   */
  async confirm(betIds: BetId[], userId: UserId) {
    // O filtro vai no SQL: so' as sugestoes que o usuario marcou voltam do
    // banco, em vez de trazer a lista toda pra descartar quase tudo aqui.
    const pendentes = await this.repository.findPendingSuggestions(
      userId,
      betIds,
    );
    const porResultado = new Map<ResultIdEnum, BetId[]>();

    for (const sugestao of pendentes) {
      const resultId = sugestao.suggestedResultId as ResultIdEnum;
      const grupo = porResultado.get(resultId);
      if (grupo) grupo.push(sugestao.betId);
      else porResultado.set(resultId, [sugestao.betId]);
    }

    let confirmadas = 0;
    for (const [resultId, ids] of porResultado) {
      await this.betService.finalizeMany(ids, resultId, userId);
      confirmadas += ids.length;
    }
    this.logger.log(`usuario ${userId}: ${confirmadas} apostas planilhadas`);
    return { confirmed: confirmadas };
  }

  async dismiss(betIds: BetId[], userId: UserId) {
    // Conta o que o UPDATE atingiu, nao o que veio no body: id de outro usuario
    // e' filtrado no repositorio e nao pode aparecer como recusado.
    const dismissed = await this.repository.dismiss(betIds, userId);
    return { dismissed };
  }
}
