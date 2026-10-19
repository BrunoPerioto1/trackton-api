import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { PendentesService } from './pendentes.service';
import { unlinkedInstructions } from './messages.const';
import { LEGACY_PAYMENT_CLAIM_CALLBACK } from '../users/access';
import { isPro } from '../users/plan';
import { parseCallbackAction } from './utils/callback-parsing.util';
import {
  RateLimitedException,
  RateLimitService,
  TELEGRAM_LINK_LIMIT,
} from '../common/rate-limit/rate-limit.service';
import { MAX_PERCENT_FILTER, MIN_PERCENT_FILTER } from '../users/dto/request.dto';
import { normalizeBetNumber } from '../bet/bet-normalization';
import { frontUrl } from '../common/utils/front-url';
import {
  callbackData,
  commandArgs,
  messageText,
  senderId,
  type BotContext,
} from './utils/bot-context';
import { errorArgs } from '../common/utils/log';

// Botões que transformam tip do grupo em aposta: o que o Grátis não usa.
const TIP_PLANILHAR_ACTIONS = new Set(['planilhar', 'lista_planilhar']);

// Os comandos "simples" do bot — cada um só conversa com o usuário que
// chamou, sem envolver fan-out de tips nem callback_query.
@Injectable()
export class BotCommandsService {
  private readonly logger = new Logger(BotCommandsService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly pendentesService: PendentesService,
    private readonly rateLimit?: RateLimitService,
  ) {}

  async handleStart(ctx: BotContext) {
    await ctx.reply(
      '👋 Bem-vindo!\n\n' +
        `1️⃣ Vincule sua conta: faça login em ${frontUrl('/login')} → Perfil → Telegram → "Gerar código de vinculação" e envie aqui /vincular com os seis dígitos\n` +
        '2️⃣ Defina sua banca: /stake VALOR\n' +
        '3️⃣ (Opcional) Defina o filtro de porcentagem mínima das tips que você quer receber: /filtro 1.5\n' +
        '   Use /filtro off para remover o filtro e receber todas as tips.\n\n' +
        'Depois disso, as apostas do grupo Tips que baterem seu filtro chegam aqui, com um botão para planilhar.\n\n' +
        '📋 Use /pendentes a qualquer momento pra ver quais tips ainda faltam planilhar.',
    );
  }

  // /pendentes: resumo do que ainda falta planilhar (ou marcar como aposta
  // caiu), sem limite de data — uma tip só sai da lista quando você resolve
  // ela, senão ficaria perdida pra sempre se passasse batido no dia em que
  // chegou.
  async handlePendentes(ctx: BotContext) {
    try {
      const user = await this.usersService.findByTelegramUserId(senderId(ctx));
      if (!user) {
        await ctx.reply(unlinkedInstructions());
        return;
      }
      const { text, keyboard } = await this.pendentesService.buildMessage(user);
      await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      });
    } catch (err) {
      this.logger.error(...errorArgs('Erro ao buscar pendentes', err));
      await ctx.reply('❌ Erro ao buscar tips pendentes. Tente novamente.');
    }
  }

  // /site: link direto pro dashboard do app.
  async handleSite(ctx: BotContext) {
    await ctx.reply(`📊 Site: ${frontUrl()}`);
  }

  async handleFiltro(ctx: BotContext) {
    const [arg] = commandArgs(ctx);
    const telegramUserId = senderId(ctx);

    try {
      const user = await this.usersService.findByTelegramUserId(telegramUserId);
      if (!user) {
        await ctx.reply(unlinkedInstructions());
        return;
      }

      if (commandArgs(ctx).length !== 1) {
        await ctx.reply(
          '❌ Formato incorreto. Use: /filtro VALOR (ex.: /filtro 1.5) ou /filtro off',
        );
        return;
      }
      if (arg.toLowerCase() === 'off') {
        await this.usersService.setMinPercentFilter(telegramUserId, null);
        await ctx.reply('✅ Filtro removido. Você vai receber todas as tips do grupo.');
        return;
      }

      const value = Number(arg.replace(',', '.'));
      if (!Number.isFinite(value) || value < MIN_PERCENT_FILTER || value > MAX_PERCENT_FILTER) {
        await ctx.reply(
          `❌ Valor inválido. Informe de ${MIN_PERCENT_FILTER} a ${MAX_PERCENT_FILTER} (ex.: /filtro 1.5), ou /filtro off pra receber tudo.`,
        );
        return;
      }

      await this.usersService.setMinPercentFilter(telegramUserId, value);
      await ctx.reply(`✅ Filtro definido: só chegam tips com porcentagem >= ${value}%`);
    } catch (error) {
      this.logger.error(...errorArgs('Erro ao atualizar filtro', error));
      await ctx.reply('❌ Erro ao atualizar seu filtro. Tente novamente.');
    }
  }

  async handleStake(ctx: BotContext) {
    const args = commandArgs(ctx);
    if (args.length !== 1) {
      await ctx.reply('❌ Formato incorreto. Use: /stake VALOR\nExemplo: /stake 2000');
      return;
    }

    // Banca é dinheiro: "1.500" é mil e quinhentos, "1500,50" tem centavos.
    // O prefixo R$ é o que faz o normalizeBetNumber ler o ponto como milhar.
    const value = normalizeBetNumber(`R$ ${args[0].replace(/^R\$/i, '')}`);
    if (value === null || value <= 0) {
      await ctx.reply('❌ Valor inválido. Informe um número maior que zero.');
      return;
    }

    try {
      const user = await this.usersService.findByTelegramUserId(senderId(ctx));
      if (!user) {
        await ctx.reply(unlinkedInstructions());
        return;
      }

      await this.usersService.updateUserStake(user.id, value);

      await ctx.reply(
        `✅ Banca definida: R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      );
    } catch (error) {
      this.logger.error(...errorArgs('Erro ao atualizar stake', error));
      await ctx.reply('❌ Erro ao atualizar sua banca. Tente novamente.');
    }
  }

  // Último @ gravado por id do Telegram, neste processo: evita uma escrita no
  // banco a cada mensagem. Só vai ao banco na primeira mensagem de cada um e
  // quando o @ muda.
  private readonly knownUsernames = new Map<number, string | null>();

  /** Mantém o @ do card do app em dia; nunca atrapalha o fluxo da mensagem. */
  syncUsername(from: { id: number; is_bot?: boolean; username?: string } | undefined) {
    if (!from || from.is_bot) return;
    const username = from.username ?? null;
    if (this.knownUsernames.get(from.id) === username) return;
    this.knownUsernames.set(from.id, username);
    this.usersService.syncTelegramUsername(from.id, username).catch((error: Error) => {
      this.knownUsernames.delete(from.id);
      this.logger.error('Erro ao sincronizar @ do Telegram', error);
    });
  }

  /**
   * Porteiro do privado. Conta desativada não usa nada. Conta no Grátis usa o
   * bot (aposta digitada à vontade; print e áudio com a cota do dia, contada
   * no BetTextService), menos planilhar tip do grupo, que é do Pro. Fica na
   * entrada (middleware) e não em cada handler.
   * Devolve true quando barrou (e já respondeu).
   */
  async blockIfNoAccess(ctx: BotContext): Promise<boolean> {
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return false;
    // Instruções e vínculo seguem livres: é por eles que a pessoa volta.
    if (/^\/(start|vincular)(@\w+)?(\s|$)/.test(messageText(ctx))) return false;

    let user: Awaited<ReturnType<UsersService['findByTelegramUserId']>>;
    try {
      user = await this.usersService.findByTelegramUserId(ctx.from.id);
    } catch (error) {
      // Banco fora: deixa passar — o handler vai esbarrar no mesmo erro e
      // responder como sempre respondeu.
      this.logger.error(...errorArgs('Erro ao conferir acesso no bot', error));
      return false;
    }
    // Sem vínculo: os handlers já pedem o /vincular.
    if (!user) return false;

    if (user.isActive === false) {
      const text = '🚫 Sua conta está desativada. Fale com o administrador.';
      if (ctx.callbackQuery) await ctx.answerCbQuery(text, { show_alert: true }).catch(() => undefined);
      else await ctx.reply(text);
      return true;
    }

    // "Já paguei" de mensagem antiga (PIX manual): aponta pro caminho novo.
    if (callbackData(ctx) === LEGACY_PAYMENT_CLAIM_CALLBACK) {
      await ctx
        .answerCbQuery(
          (isPro(user)
            ? '✅ Seu Pro está ativo.'
            : `O pagamento agora é pela assinatura do Pro, no site:\n${frontUrl('/plano')}`
          ).slice(0, 200),
          { show_alert: true },
        )
        .catch(() => undefined);
      return true;
    }

    // Grátis tocando em Planilhar de tip (cópia individual ou /pendentes).
    // Pop-up e nada mais: a mensagem e o botão ficam intactos, então o mesmo
    // "Planilhar" volta a funcionar quando a pessoa assinar. O planilhar_ts é
    // o card do print/áudio da própria pessoa e segue livre.
    const { action } = parseCallbackAction(callbackData(ctx) ?? '');
    if (TIP_PLANILHAR_ACTIONS.has(action) && !isPro(user)) {
      await ctx
        .answerCbQuery(
          `⭐ Planilhar tips é do plano Pro.\n\nAssine pelo site, na página Plano:\n${frontUrl('/plano')}`.slice(0, 200),
          { show_alert: true },
        )
        .catch(() => undefined);
      return true;
    }
    return false;
  }


  async handleVincular(ctx: BotContext) {
    const args = commandArgs(ctx);
    if (args.length !== 1) {
      await ctx.reply('❌ Formato incorreto. Use: /vincular 123456');
      return;
    }

    const telegramUserId = senderId(ctx);
    try {
      // Código de 6 dígitos: sem teto de tentativas dava pra chutar o de outra conta.
      await this.rateLimit?.consume(`vincular:tg:${telegramUserId}`, TELEGRAM_LINK_LIMIT);
      const owner = await this.usersService.confirmTelegramLink(args[0], telegramUserId, ctx.from?.username ?? null);
      await ctx.reply('✅ Conta vinculada com sucesso!');
      // Depois da confirmação: o convite do grupo é outra mensagem, e falhar
      // nele não desfaz o vínculo.
      await this.usersService
        .rejoinTipsGroup(owner, telegramUserId)
        .catch((error) => this.logger.error(...errorArgs('Erro ao convidar de volta pro grupo Tips', error)));
    } catch (error) {
      if (error instanceof BadRequestException) {
        await ctx.reply('❌ Erro: ' + error.message);
        return;
      }
      if (error instanceof RateLimitedException) {
        await ctx.reply(`⏳ ${(error.getResponse() as { message: string }).message}`);
        return;
      }
      this.logger.error(...errorArgs('Erro ao confirmar vinculação', error));
      await ctx.reply('❌ Erro ao processar solicitação. Tente mais tarde.');
    }
  }
}
