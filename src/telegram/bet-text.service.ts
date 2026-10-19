import {
  normalizeBetData,
  type BetOrigin,
  type RawBetData,
} from '../bet/bet-normalization';
import { Injectable, Logger } from '@nestjs/common';
import { GrokService } from './grok.service';
import { BetService, TipAlreadyPlanilhadaException } from '../bet/bet.service';
import { CreateBetDto } from '../bet/dto/bet.dto';
import { UsersService } from '../users/users.service';
import { HouseService } from '../house/house.service';
import { TipFanoutService } from './tip-fanout.service';
import {
  EDIT_PROMPT_INSTRUCTIONS,
  unlinkedInstructions,
} from './messages.const';
import {
  extractLimitFromText,
  extractOddFromText,
  extractPercent,
  extractRecommendedStakeFromText,
  extractStakeFromText,
  parseBetLocal,
} from './utils/tip-extractors.util';
import { findBetMatches, type PendingCandidate } from '../bet-slip/matching.util';
import { TipsService } from '../tips/tips.service';
import { BetSlipParserService } from '../bet-slip/bet-slip-parser.service';
import { PendingMatchService } from '../bet-slip/pending-match.service';
import { BetAudioService, MAX_AUDIO_BYTES } from './bet-audio.service';
import { buildBetPreview, missingBetFields } from './utils/bet-preview.util';
import type { Context } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { callbackMessage, senderId, type BotContext } from './utils/bot-context';
import {
  AI_PARSE_LIMIT,
  RateLimitedException,
  RateLimitService,
} from '../common/rate-limit/rate-limit.service';
import type { Message } from 'telegraf/types';
import { errorArgs } from '../common/utils/log';
import { AiQuotaService } from '../users/ai-quota.service';
import { FREE_AI_PER_DAY, isPro } from '../users/plan';
import { frontUrl } from '../common/utils/front-url';

// Transforma texto livre (DM ou tip) numa aposta salva, e trata o fluxo de
// edição de odd/limite/casa que acontece antes disso (prompt de "✏️ Editar").
// A foto do bilhete, com o que o fluxo de print lê.
export type BetPhotoMessage = {
  message_id: number;
  date: number;
  caption?: string;
  photo: { file_id: string; width: number; height: number }[];
};

@Injectable()
export class BetTextService {
  private readonly logger = new Logger(BetTextService.name);

  constructor(
    private readonly grokService: GrokService,
    private readonly betService: BetService,
    private readonly usersService: UsersService,
    private readonly houseService: HouseService,
    private readonly tipFanoutService: TipFanoutService,
    private readonly betSlipParser: BetSlipParserService,
    private readonly betAudioService: BetAudioService,
    private readonly pendingMatchService: PendingMatchService,
    private readonly tipsService?: TipsService,
    private readonly rateLimit?: RateLimitService,
    private readonly aiQuota?: AiQuotaService,
  ) {}

  // Print e áudio custam uma chamada à OpenAI cada. Devolve o aviso pra quem
  // passou do limite, ou null quando pode seguir. `daily` = conta na cota do
  // Grátis; a análise profunda relê o mesmo bilhete e não conta de novo.
  private async aiLimitMessage(ctx: BotContext, daily = true): Promise<string | null> {
    // Sem contador (testes) não há o que esperar: o "Analisando…" sai na hora.
    if (!this.rateLimit) return null;
    if (daily && this.aiQuota) {
      const user = await this.usersService.findByTelegramUserId(senderId(ctx));
      // Sem vínculo: o fluxo de sempre pede o /vincular mais adiante.
      if (user && !isPro(user) && (await this.aiQuota.usedToday(user.id)) >= FREE_AI_PER_DAY) {
        return (
          `🔒 Você já usou as ${FREE_AI_PER_DAY} leituras por IA de hoje (print e áudio). Amanhã libera de novo.\n\n` +
          'Até lá, dá pra registrar digitando a aposta aqui mesmo, sem limite. ' +
          `Ou assine o Pro e leia quantos prints quiser: ${frontUrl('/plano')}`
        );
      }
    }
    try {
      await this.rateLimit.consume(`ai:tg:${ctx.from?.id}`, AI_PARSE_LIMIT);
      return null;
    } catch (error) {
      if (error instanceof RateLimitedException)
        return `⏳ Muitas leituras seguidas. ${(error.getResponse() as { message: string }).message}`;
      throw error;
    }
  }

  // Leitura feita: conta na cota do Grátis. Não derruba o fluxo — a IA já leu,
  // e o pior caso de falhar aqui é a pessoa ganhar uma leitura a mais.
  private async recordDailyAiUse(ctx: BotContext): Promise<void> {
    if (!this.aiQuota) return;
    try {
      const user = await this.usersService.findByTelegramUserId(senderId(ctx));
      if (user) await this.aiQuota.record(user.id, isPro(user));
    } catch (error) {
      this.logger.warn(`cota de IA nao contou: ${(error as Error).message}`);
    }
  }


  // Parsing + criação da aposta. Reaproveitado tanto pelo texto livre em DM
  // quanto pelo clique em "Enviar ao Planilhador" na cópia individual do
  // grupo Tips. Quando vem de um clique (replyToMessageId presente), a
  // confirmação sai como resposta à própria tip, em vez de mensagem solta.
  async processBetText(
    ctx: BotContext,
    userMessage: string,
    replyToMessageId?: number,
    tipId?: number,
    betTime?: Date,
    origin?: BetOrigin,
  ) {
    try {
      const resolvedHouseId =
        await this.houseService.resolveHouseIdFromText(userMessage);

      // Caminho rápido: os dois formatos conhecidos (emoji e SOBRECARGA/
      // AVISO) são posicionais, então dá pra extrair tudo com regex e pular
      // a ida na IA. O Groq fica só de fallback pra texto fora do padrão.
      const local = parseBetLocal(userMessage);
      const jsonResult: RawBetData = local
        ? local
        : ((await this.grokService.parseBetMessage(
            userMessage,
            resolvedHouseId,
          )) as RawBetData);

      const normalized = normalizeBetData(jsonResult);
      const houseId = resolvedHouseId;
      const { game, market, sport } = normalized;
      const odd = normalized.odd ?? NaN;

      const percent = extractPercent(userMessage);
      const user = await this.usersService.findByTelegramUserId(senderId(ctx));
      if (!user) throw new Error('UNLINKED');

      // O card entregue já traz a stake calculada na hora da entrega
      // ("🎯 Recomendação de aposta"): é ela que o usuário viu e vai apostar.
      // Refazer banca × % aqui divergia quando a banca mudou nesse meio tempo.
      // A conta só roda pra texto sem essa linha (tip colada à mão, card antigo).
      let stake = extractRecommendedStakeFromText(userMessage) ?? NaN;
      let semBanca = false;
      if (!Number.isFinite(stake) && percent !== null) {
        const userStake = await this.usersService.getUserStake(user.id);
        if (userStake === null) semBanca = true;
        else stake = (percent / 100) * userStake;
      } else if (!Number.isFinite(stake)) {
        stake = normalized.stake ?? NaN;
      }

      // Card vindo de print: não tem % pra converter pela banca, o valor
      // apostado já está no texto ("💰 Stake: R$ 14,83").
      if (!Number.isFinite(stake))
        stake = extractStakeFromText(userMessage) ?? NaN;
      if (!Number.isFinite(stake) && semBanca) throw new Error('SEM_BANCA');

      const limit = extractLimitFromText(userMessage);
      if (limit !== null) stake = Math.min(stake, limit);

      if (houseId === null || !Number.isFinite(houseId) || houseId <= 0)
        throw new Error('CASA_INVALIDA');
      if (!Number.isFinite(stake) || stake <= 0)
        throw new Error('stake inválida');
      if (!Number.isFinite(odd) || odd <= 1) throw new Error('odd inválida');
      if (!game) throw new Error('game vazio');
      if (!market) throw new Error('mercado vazio');
      if (!sport) throw new Error('esporte vazio');

      const apostaData: CreateBetDto = {
        userId: user.id,
        game,
        stake: Number(stake.toFixed(2)),
        odd,
        houseId,
        market,
        sport,
        // Só o fluxo de imagem passa isso (horário da mensagem original no
        // Telegram). Sem betTime o banco segue usando o default de sempre.
        ...(betTime ? { betTime: betTime.toISOString() } : {}),
      };

      const telegramContext = ctx as Context;
      const callback = telegramContext.callbackQuery;
      const message =
        telegramContext.message ??
        (callback && 'message' in callback ? callback.message : undefined);
      const source: BetOrigin = origin ?? {
        source: 'telegram',
        sourceType: 'text',
        telegramMessageId: message?.message_id,
        telegramChatId: telegramContext.chat
          ? String(telegramContext.chat.id)
          : undefined,
      };
      const aposta = await this.betService.createBet(apostaData, tipId, source);

      let houseName = 'N/A';
      try {
        const houses = await this.houseService.getAllHouses();
        const house = houses.find((h) => h.id === aposta.houseId);
        if (house) houseName = house.name;
      } catch (err) {
        this.logger.error(...errorArgs('Erro ao buscar casa', err));
      }

      const emBrasilia = (data: Date) =>
        new Date(data).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'America/Sao_Paulo',
        });

      const horario = emBrasilia(aposta.betTime);
      // So aparece quando o jogo foi identificado no cache de eventos. Sem
      // match a linha some — nunca mostra data chutada.
      const inicio = aposta.eventStartAt
        ? `\n🏟 Começa: ${emBrasilia(aposta.eventStartAt)}`
        : '';

      // Consultivo: a aposta já foi gravada, o aviso só sinaliza pro usuário
      // conferir e apagar a repetida se for o caso.
      const duplicado = aposta.duplicate.isPotentialDuplicate
        ? `⚠️ Possível aposta duplicada — você planilhou uma igual há ${Math.max(
            1,
            Math.round(
              (Date.now() - aposta.duplicate.existingCreatedAt!.getTime()) /
                60000,
            ),
          )} min.

`
        : '';

      await ctx.reply(
        `${duplicado}✅ Aposta salva!\n\n🎮 Jogo: ${aposta.game}\n🕐 Planilhado: ${horario}${inicio}\n💰 Stake: R$ ${aposta.stake}\n📈 Odd: ${aposta.odd}\n🏆 Mercado: ${aposta.market}\n⚽ Esporte: ${aposta.sport}\n🏢 Casa: ${houseName}`,
        replyToMessageId
          ? { reply_parameters: { message_id: replyToMessageId } }
          : undefined,
      );
    } catch (err) {
      // Clique duplo que passou pelo lock em memória (outra instância): o
      // banco recusou a segunda aposta. Quem chamou responde "já planilhada".
      if (err instanceof TipAlreadyPlanilhadaException) throw err;
      this.logger.warn(`[VALIDATION_FAILED] stage=telegram_bet ${(err as Error).message}`);
      const extra = replyToMessageId
        ? { reply_parameters: { message_id: replyToMessageId } }
        : undefined;
      if ((err as Error).message === 'UNLINKED') {
        await ctx.reply(unlinkedInstructions(), extra);
      } else if ((err as Error).message === 'SEM_BANCA') {
        await ctx.reply(
          '❌ Você ainda não definiu sua banca, então não dá pra calcular a stake dessa tip.\nUse /stake VALOR (ex.: /stake 2000) e clique em Planilhar de novo.',
          extra,
        );
      } else if ((err as Error).message === 'CASA_INVALIDA') {
        await ctx.reply(
          '❌ Erro ao ler a casa de aposta. Por favor, remande a aposta aqui no chat trocando a casa por uma parecida.',
          extra,
        );
      } else {
        await ctx.reply(
          `❌ Erro ao processar aposta.\n${(err as Error).message}`,
          extra,
        );
      }
      throw err;
    }
  }

  // Print de bilhete + legenda com o nome da casa. A IA só extrai os dados —
  // quem planilha continua sendo o botão "Enviar ao Planilhador" de sempre.
  // O truque pra não duplicar nada: em vez de inventar um estado novo entre
  // preview e clique, monta o MESMO card de texto emoji que o callback de
  // planilhar já sabe reler (🏠/🆚/⚽/📌/🏷 + 💰 Stake). Nada é gravado aqui.
  async handleDeepBetPhoto(ctx: BotContext) {
    const preview = callbackMessage(ctx);
    const photo = preview?.reply_to_message;
    if (!preview || !photo?.photo?.length || !photo.caption || !photo.date) {
      await ctx.answerCbQuery(
        'Não encontrei a foto original. Envie novamente com a legenda.',
      );
      return;
    }
    if (photo.from?.id !== ctx.from?.id) {
      await ctx.answerCbQuery(
        'Somente quem enviou a foto pode revisar esta aposta.',
      );
      return;
    }
    const keyboard = preview.reply_markup;
    if (
      !keyboard?.inline_keyboard?.some((row) =>
        row.some((button) => 'callback_data' in button && button.callback_data === 'bet_image_deep'),
      )
    ) {
      await ctx.answerCbQuery('Esta análise já foi solicitada.');
      return;
    }
    const limited = await this.aiLimitMessage(ctx, false);
    if (limited) {
      await ctx.answerCbQuery(limited.slice(0, 200), { show_alert: true });
      return;
    }
    await ctx.answerCbQuery('Analisando a foto novamente…');
    try {
      // Remove Planilhar enquanto a revisão está em andamento.
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: '⏳ Analisando…', callback_data: 'noop' }]],
      });
    } catch {
      // Outro clique pode já ter colocado a mensagem no mesmo estado.
      return;
    }
    try {
      await this.handleBetPhoto(ctx, photo as unknown as BetPhotoMessage, true);
    } catch (err) {
      this.logger.error(`Erro na análise profunda: ${(err as Error).message}`);
      await ctx.editMessageReplyMarkup(keyboard);
      await ctx.reply(
        '⚠️ A análise profunda não conseguiu concluir a leitura. O preview anterior foi mantido. Tente novamente ou envie um print mais legível.',
        { reply_parameters: { message_id: preview.message_id } },
      );
    }
  }

  async handleBetPhoto(ctx: BotContext, msg: BetPhotoMessage, deep = false) {
    const caption = String(msg.caption ?? '').trim();
    if (!caption) {
      await ctx.reply(
        '📸 Informe o nome da casa na legenda da imagem. Ex.: Ginga',
        { reply_parameters: { message_id: msg.message_id } },
      );
      return;
    }
    // A análise profunda já contou o uso no clique (handleDeepBetPhoto).
    const limited = deep || !this.rateLimit ? null : await this.aiLimitMessage(ctx);
    if (limited) {
      await ctx.reply(limited, { reply_parameters: { message_id: msg.message_id } });
      return;
    }

    const startedAt = performance.now();
    const timings: Record<string, number> = {};
    let status = 'error';
    const measure = async <T>(
      stage: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        timings[stage] = Math.round(performance.now() - start);
      }
    };
    const extra = { reply_parameters: { message_id: msg.message_id } };
    const deepButton = [
      { text: '🔎 Análise profunda', callback_data: 'bet_image_deep' },
    ];
    const retryExtra = {
      ...extra,
      reply_markup: { inline_keyboard: [deepButton] },
    };

    // Feedback e pendentes rodam de lado: nada na leitura do print depende
    // deles, então não podem segurar a chamada da IA.
    const noticePromise = deep
      ? Promise.resolve(null)
      : measure('feedback', () => ctx.reply('⏳ Analisando a foto…', extra))
          .then((m) => ({ message_id: m.message_id }))
          .catch(() => {
            this.logger.warn('[BET_IMAGE_FLOW] feedback_failed=true');
            return null;
          });
    const pendentesPromise = measure('pendentes', async () => {
      const user = await this.usersService.findByTelegramUserId(senderId(ctx));
      if (!user) return [] as PendingCandidate[];
      return this.pendingMatchService.loadCandidates(
        user.id,
        new Date(msg.date * 1000),
      );
    }).catch((err) => {
      this.logger.warn('[BET_MATCH] pendentes_indisponiveis=true');
      throw err;
    });
    pendentesPromise.catch(() => {});

    const chatId = ctx.chat?.id;
    const reply = async (
      text: string,
      options: { reply_parameters?: unknown; reply_markup?: InlineKeyboardMarkup } = {},
    ) =>
      measure('preview', async () => {
        const { reply_parameters: _replyParameters, ...editOptions } = options;
        if (deep) return ctx.editMessageText(text, editOptions);
        const notice = await noticePromise;
        if (notice && chatId !== undefined)
          return ctx.telegram.editMessageText(
            chatId,
            notice.message_id,
            undefined,
            text,
            editOptions,
          );
        return ctx.reply(text, { ...extra, ...editOptions });
      });

    try {
      // Só casa e download bloqueiam a IA. A IA só roda com casa válida.
      const [house, photo] = await Promise.allSettled([
        measure('house', () =>
          this.houseService.resolveHouseIdFromText(`🏠 ${caption}`),
        ),
        (async () => {
          const fileId = pickPhotoSize<{
            file_id: string;
            width: number;
            height: number;
          }>(msg.photo).file_id;
          const link = await measure('get_file', () =>
            ctx.telegram.getFileLink(fileId),
          );
          const url = link.href;
          const imageBuffer = await measure('download', async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`download ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
          });
          return {
            imageBuffer,
            mimeType: /\.png($|\?)/i.test(url) ? 'image/png' : 'image/jpeg',
          };
        })(),
      ]);

      let extracted: Awaited<
        ReturnType<typeof this.betSlipParser.extractBetFromImage>
      >;
      try {
        if (house.status === 'rejected') throw house.reason;
        if (!house.value) {
          status = 'invalid_house';
          if (deep) throw new Error('CASA_INVALIDA');
          await reply(
            '❌ Erro ao ler a casa de aposta. Por favor, remande a aposta aqui no chat trocando a casa por uma parecida.',
          );
          return;
        }
        if (photo.status === 'rejected') throw photo.reason;
        extracted = await measure('ai', () =>
          this.betSlipParser.extractBetFromImage({ ...photo.value, deep }),
        );
        if (!deep) await this.recordDailyAiUse(ctx);
      } catch (err) {
        const reason = (err as Error).message;
        this.logger.error(
          `Erro ao reconhecer print (chatId=${ctx.chat?.id} messageId=${msg.message_id}): ${reason}`,
        );
        if (deep) throw err;
        await reply(
          reason === 'OPENAI_API_KEY_AUSENTE'
            ? '❌ Reconhecimento por imagem não está configurado no servidor.'
            : '❌ Não consegui ler esse print agora. Tenta de novo em instantes.',
          retryExtra,
        );
        return;
      }

      const faltando = missingBetFields(extracted);

      if (faltando.length) {
        status = 'incomplete';
        if (deep) throw new Error(`CAMPOS_AUSENTES: ${faltando.join(', ')}`);
        await reply(
          `⚠️ Não consegui identificar completamente esta aposta.\n\nNão identificado:\n${faltando
            .map((f) => `• ${f}`)
            .join(
              '\n',
            )}\n\nTente a análise profunda ou envie outro print mostrando o bilhete completo.`,
          retryExtra,
        );
        return;
      }

      // Comparacao local pura (sem I/O, sem IA): so pontua o que ja veio.
      // Pendencia indisponivel nao pode atrapalhar o print — segue sem sugestao.
      const pendentes = await Promise.allSettled([pendentesPromise]).then(
        ([r]) => r,
      );
      const matches =
        pendentes.status === 'fulfilled'
          ? findBetMatches(
              {
                game: extracted.evento ?? '',
                market: extracted.mercado ?? '',
                house: caption,
                odd: extracted.odd ?? NaN,
                stake: extracted.stake ?? NaN,
                at: new Date((msg.date) * 1000),
              },
              pendentes.value,
            ).map(({ candidate, score }) => ({
              tipId: candidate.tipId,
              score,
              label: candidate.game || `#${candidate.tipId}`,
            }))
          : [];
      const preview = buildBetPreview(extracted, caption, msg.date, {
        deep,
        allowDeep: !deep,
        matches,
      });
      await reply(preview.text, { reply_markup: preview.reply_markup });
      status = 'ok';
    } finally {
      this.logger.log(
        `[BET_IMAGE_FLOW] chat_id=${ctx.chat?.id} message_id=${msg.message_id} mode=${deep ? 'deep' : 'standard'} status=${status} ` +
          Object.entries(timings)
            .map(([stage, duration]) => `${stage}_ms=${duration}`)
            .join(' ') +
          ` total_ms=${Math.round(performance.now() - startedAt)}`,
      );
    }
  }

  async handleBetAudio(
    ctx: Context,
    msg: Message.VoiceMessage | Message.AudioMessage,
  ) {
    const startedAt = performance.now();
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const limited = this.rateLimit ? await this.aiLimitMessage(ctx) : null;
    if (limited) {
      await ctx.reply(limited, { reply_parameters: { message_id: msg.message_id } });
      return;
    }
    const audio = 'voice' in msg ? msg.voice : msg.audio;
    const extra = { reply_parameters: { message_id: msg.message_id } };
    let feedback: Message.TextMessage | undefined;
    let status = 'error';
    const reply = async (
      text: string,
      replyMarkup?: ReturnType<typeof buildBetPreview>['reply_markup'],
    ) => {
      if (feedback)
        return ctx.telegram.editMessageText(
          chatId,
          feedback.message_id,
          undefined,
          text,
          { reply_markup: replyMarkup },
        );
      return ctx.reply(text, { ...extra, reply_markup: replyMarkup });
    };
    try {
      if ((audio.file_size ?? 0) > MAX_AUDIO_BYTES)
        throw new Error('AUDIO_MUITO_GRANDE');
      try {
        feedback = await ctx.reply('⏳ Analisando o áudio…', extra);
      } catch {
        this.logger.warn('[BET_AUDIO_TOTAL] feedback_failed=true');
      }

      const downloadStart = performance.now();
      let audioBuffer: Buffer;
      let filename: string;
      try {
        const link = await ctx.telegram.getFileLink(audio.file_id);
        filename =
          'voice' in msg
            ? 'voice.ogg'
            : (msg.audio.file_name ??
              link.pathname.split('/').pop() ??
              'audio');
        const response = await fetch(link.href, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok || !response.body)
          throw new Error('AUDIO_DOWNLOAD_FALHOU');
        if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) {
          await response.body.cancel();
          throw new Error('AUDIO_MUITO_GRANDE');
        }
        // Limita também os bytes reais, mesmo se Telegram não informar file_size/Content-Length.
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const value = chunk.value as Uint8Array;
            size += value.byteLength;
            if (size > MAX_AUDIO_BYTES) {
              await reader.cancel();
              throw new Error('AUDIO_MUITO_GRANDE');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        audioBuffer = Buffer.concat(chunks);
      } finally {
        this.logger.log(
          `[BET_AUDIO_DOWNLOAD] message_id=${msg.message_id} duration_ms=${Math.round(performance.now() - downloadStart)}`,
        );
      }
      const transcript = await this.betAudioService.transcribeBetAudio({
        audioBuffer,
        filename,
        mimeType: audio.mime_type,
        durationSeconds: audio.duration,
      });
      const extracted =
        await this.betAudioService.extractBetFromTranscript(transcript);
      await this.recordDailyAiUse(ctx);
      const faltando = missingBetFields(extracted);
      const houseId = extracted.casa
        ? await this.houseService.resolveHouseIdFromText(`🏠 ${extracted.casa}`)
        : null;
      if (!houseId) faltando.unshift('Casa');
      if (faltando.length) {
        status = 'incomplete';
        await reply(
          `⚠️ Não consegui identificar completamente a aposta.\n\nFaltando:\n${faltando.map((f) => `• ${f}`).join('\n')}\n\nEnvie outro áudio incluindo esses dados.`,
        );
        return;
      }
      const preview = buildBetPreview(extracted, extracted.casa!, msg.date, {
        sourceType: 'audio',
      });
      await reply(preview.text, preview.reply_markup);
      status = 'ok';
    } catch (error) {
      this.logger.error(
        `[BET_AUDIO_ERROR] message_id=${msg.message_id} type=${error instanceof Error ? error.name : 'unknown'}`,
      );
      await reply(
        error instanceof Error && error.message === 'AUDIO_MUITO_GRANDE'
          ? '⚠️ Áudio muito grande. Envie um arquivo de até 20 MB.'
          : 'Não consegui entender este áudio. Tente enviar novamente falando os dados da aposta.',
      );
    } finally {
      this.logger.log(
        `[BET_AUDIO_TOTAL] message_id=${msg.message_id} status=${status} duration_ms=${Math.round(performance.now() - startedAt)}`,
      );
    }
  }

  // O Planilhar grava o "🎯 Recomendação de aposta" do card, então o card tem
  // que acompanhar a edição. Limite novo refaz banca × % cortada pelo limite
  // (subir o limite pode liberar mais stake); só a odd mudando mantém a stake
  // e refaz o lucro potencial. Card sem 🎯 (sem banca, AVISO) fica como está.
  private async refreshRecommendation(
    ctx: BotContext,
    text: string,
    limitChanged: boolean,
  ): Promise<string> {
    let stake = extractRecommendedStakeFromText(text);
    if (stake === null) return text;

    const percent = extractPercent(text);
    if (limitChanged && percent !== null) {
      const user = await this.usersService.findByTelegramUserId(senderId(ctx));
      const banca = user
        ? await this.usersService.getUserStake(user.id)
        : null;
      if (banca !== null) stake = (percent / 100) * banca;
    }
    const limit = extractLimitFromText(text);
    if (limit !== null) stake = Math.min(stake, limit);

    const money = (value: number) => value.toFixed(2).replace('.', ',');
    let out = text.replace(
      /^(🎯\s*Recomendação de aposta:\s*R?\$?\s*)[\d.,]+/m,
      `$1${money(stake)}`,
    );
    const odd = extractOddFromText(out);
    if (odd !== null)
      out = out.replace(
        /^(💰\s*Lucro potencial:\s*R?\$?\s*)[\d.,]+/m,
        `$1${money(stake * odd - stake)}`,
      );
    return out;
  }

  // Resposta (reply) a um prompt de "✏️ Editar": extrai a odd/limite novos e
  // o texto original (embutido no próprio prompt) e edita só essa mensagem.
  async handleEditReply(
    ctx: BotContext,
    promptText: string,
    headerMatch: RegExpMatchArray,
    replyText: string,
  ) {
    const originalMessageId = Number(headerMatch[1]);
    const isMedia = headerMatch[2] === 'p';
    const tipId = headerMatch[3] ? Number(headerMatch[3]) : undefined;
    const sepIndex = promptText.indexOf('\n\n');
    const originalText = sepIndex >= 0 ? promptText.slice(sepIndex + 2) : '';
    if (!originalText) {
      await ctx.reply(
        '❌ Não consegui recuperar o texto original. Clica em Editar de novo.',
      );
      return;
    }

    const raw = replyText.trim();
    const lower = raw.toLowerCase();
    let novaOdd: number | null = null;
    let novoLimite: number | null = null;
    let novaCasa: string | null = null;

    if (lower.startsWith('casa')) {
      novaCasa = raw.slice(4).trim();
    } else if (lower.startsWith('odd')) {
      novaOdd = parseFloat(raw.slice(3).trim().replace(',', '.'));
    } else if (lower.startsWith('limite') || lower.startsWith('limit')) {
      novoLimite = parseFloat(
        raw
          .replace(/^limite|^limit/i, '')
          .trim()
          .replace(',', '.'),
      );
    } else {
      const parts = raw.split(/\s+/);
      if (parts.length >= 2) {
        novaOdd = parseFloat(parts[0].replace(',', '.'));
        novoLimite = parseFloat(parts[1].replace(',', '.'));
      } else if (parts.length === 1 && parts[0]) {
        novaOdd = parseFloat(parts[0].replace(',', '.'));
      }
    }

    if (novaOdd === null && novoLimite === null && !novaCasa) {
      await ctx.reply(`❌ Não entendi. ${EDIT_PROMPT_INSTRUCTIONS}`);
      return;
    }
    if (novaOdd !== null && (!Number.isFinite(novaOdd) || novaOdd <= 1)) {
      await ctx.reply('❌ Odd inválida.');
      return;
    }
    if (novoLimite !== null && !Number.isFinite(novoLimite)) {
      await ctx.reply('❌ Limite inválido.');
      return;
    }
    if (novaCasa !== null && !novaCasa) {
      await ctx.reply('❌ Nome da casa inválido.');
      return;
    }

    let novoTexto = originalText;
    if (novaOdd !== null) {
      novoTexto = novoTexto.replace(
        /🏷\s*([\d]+(?:[.,][\d]+)?)/,
        `🏷 ${novaOdd.toFixed(2)}`,
      );
    }
    if (novoLimite !== null) {
      novoTexto = novoTexto.replace(
        /(🚦[^\n]*R\$\s*)([\d.,]+)/,
        `$1${novoLimite.toFixed(2)}`,
      );
    }
    if (novaCasa) {
      novoTexto = novoTexto.replace(/^🏠\s*.*$/m, `🏠 ${novaCasa}`);
    }
    if (novaOdd !== null || novoLimite !== null) {
      novoTexto = await this.refreshRecommendation(
        ctx,
        novoTexto,
        extractLimitFromText(novoTexto) !== extractLimitFromText(originalText),
      );
    }

    // Resposta a um prompt do bot: sempre vem de um chat.
    const chatId = ctx.chat!.id;
    try {
      if (isMedia) {
        await ctx.telegram.editMessageCaption(
          chatId,
          originalMessageId,
          undefined,
          novoTexto,
          {
            reply_markup: this.tipFanoutService.tipsCopyKeyboard(tipId),
          },
        );
      } else {
        await ctx.telegram.editMessageText(
          chatId,
          originalMessageId,
          undefined,
          novoTexto,
          {
            reply_markup: this.tipFanoutService.tipsCopyKeyboard(tipId),
          },
        );
      }
      const salvo =
        tipId === undefined ||
        (await this.saveEditedDelivery(ctx, tipId, originalMessageId, isMedia, novoTexto));
      await ctx.reply(
        salvo
          ? '✅ Aposta atualizada!'
          : '⚠️ Mensagem atualizada, mas não consegui guardar a edição: planilhe por esta mensagem, não pelo /pendentes nem pelo site.',
        { reply_parameters: { message_id: originalMessageId } },
      );
    } catch (err) {
      this.logger.error(...errorArgs('Erro ao editar aposta individual', err));
      await ctx.reply('❌ Erro ao atualizar. Tenta de novo.');
    }
  }

  // O Planilhar do /pendentes e a tela de Tips leem a cópia entregue salva, não
  // a mensagem: sem gravar a edição, eles planilhavam a odd e a stake de antes.
  // Sem entidades: a mensagem editada perdeu a formatação, e os offsets antigos
  // não batem mais com o texto.
  private async saveEditedDelivery(
    ctx: BotContext,
    tipId: number,
    messageId: number,
    hasMedia: boolean,
    text: string,
  ): Promise<boolean> {
    if (!this.tipsService) return true;
    try {
      const user = await this.usersService.findByTelegramUserId(senderId(ctx));
      if (!user) return true;
      await this.tipsService.saveDelivery({ tipId, userId: user.id, messageId, hasMedia, text, entities: null });
      return true;
    } catch (err) {
      this.logger.error(...errorArgs(`Erro ao guardar a edição da tip ${tipId}`, err));
      return false;
    }
  }
}

// Telegram entrega o mesmo print em vários tamanhos. O maior (às vezes 2000px+)
// só engorda download e tokens de imagem sem ganhar legibilidade no bilhete —
// pega o menor que ainda passa de ~1100px de lado maior.
// ponytail: sem redimensionar nada localmente; se 1100 ficar ilegível em alguma
// casa, sobe o limite ou aí sim entra um resize (sharp).
export function pickPhotoSize<T extends { width: number; height: number }>(
  sizes: T[],
): T {
  const sorted = [...sizes].sort(
    (a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height),
  );
  return (
    sorted.find((s) => Math.max(s.width, s.height) >= 1100) ??
    sorted[sorted.length - 1]
  );
}
