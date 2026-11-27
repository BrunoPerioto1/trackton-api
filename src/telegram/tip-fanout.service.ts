import type { MessageEntity } from 'telegraf/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { TELEGRAM_BOT } from './telegram-bot.provider';
import { UsersService } from '../users/users.service';
import { TipsService } from '../tips/tips.service';
import { TipsGroupService } from './tips-group.service';
import { forEachWithConcurrency } from '../common/utils/concurrency';
import {
  extractLimitFromText,
  extractOddFromText,
  extractPercent,
  isAvisoMessage,
} from './utils/tip-extractors.util';
import {
  TIP_BOILERPLATE_PATTERNS,
  stripBoilerplateParagraphs,
} from './utils/tip-text.util';
import { errorArgs } from '../common/utils/log';
import { HouseService } from '../house/house.service';
import {
  checkHouseAccess,
  houseAccessLine,
  type HouseAccessRules,
} from '../house/house-access';

// DMs ao mesmo tempo no fan-out. O Telegram aceita ~30/s por bot; 8 em voo
// deixa folga pro resto do bot continuar respondendo.
const FANOUT_CONCURRENCY = 8;

// Mesma regra do UsersService.getUserStake: zero ou vazio é "sem banca".
const bancaDefinida = (stake: number | string | null | undefined) =>
  stake != null && Number(stake) > 0 ? Number(stake) : null;

const NO_BANKROLL_LINE =
  '🎯 Defina sua banca com /stake VALOR pra receber a recomendação de aposta.';

// Tudo que envolve entregar uma tip pro DM individual de cada usuário: o
// fan-out ao vivo (quando a tip chega no grupo), o reenvio avulso de um item
// (botão "✏️ Editar" da lista do /pendentes) e a edição posterior dessa
// mensagem quando o usuário resolve pela lista em vez de clicar nela direto.
@Injectable()
export class TipFanoutService {
  private readonly logger = new Logger(TipFanoutService.name);

  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Telegraf,
    private readonly usersService: UsersService,
    private readonly tipsService: TipsService,
    private readonly tipsGroup: TipsGroupService,
    private readonly houses: HouseService,
  ) {}

  isTipsGroup(chatId: number): boolean {
    return this.tipsGroup.isTipsGroup(chatId);
  }

  tipsCopyKeyboard(tipId?: number) {
    const suffix = tipId !== undefined ? `:${tipId}` : '';
    return {
      inline_keyboard: [
        [
          {
            text: '📊 Enviar ao Planilhador',
            callback_data: `planilhar${suffix}`,
          },
        ],
        [
          { text: '✏️ Editar', callback_data: `editar${suffix}` },
          { text: '❌ Aposta Caiu', callback_data: `aposta_caiu${suffix}` },
        ],
      ],
    };
  }

  // Fan-out: dado o texto de uma tip postada no grupo Tips (chatId/messageId
  // dessa mensagem), extrai a %, e manda uma cópia com botão próprio de
  // Planilhar para cada usuário vinculado cujo filtro de % é satisfeito.
  // Mensagens de SOBRECARGA/AVISO passam mesmo sem % (mas sem recomendação,
  // já que não há % pra converter pela banca do usuário). Quando há %, cada
  // cópia leva sua própria "Recomendação de aposta" (banca do usuário × % da
  // tip, limitada pelo 🚦/limite do texto), em negrito. `entities` são os
  // links/formatação da mensagem original (ex.: "Clique AQUI" → text_link) —
  // sempre reconstruímos o texto (tira boilerplate, acrescenta recomendação),
  // então as entidades precisam ser realinhadas junto — senão a cópia perde
  // todo link/formatação.
  async handleTipsMessage(
    text: string,
    chatId: number,
    messageId: number,
    hasMedia: boolean,
    entities?: MessageEntity[],
  ) {
    const rawPercent = extractPercent(text);
    const isAviso = isAvisoMessage(text);
    // AVISO/SOBRECARGA só tem o que planilhar quando é uma tip de verdade
    // (com odd), não um comunicado puro ("envio finalizado, boa noite" etc.)
    // — sem odd não tem como calcular nada, então nem mostra os botões nem
    // finge que tem uma % válida (o "0.98%" que às vezes aparece solto numa
    // frase de aviso não é uma recomendação real).
    const hasOdd = extractOddFromText(text) !== null;
    const showKeyboard = !isAviso || hasOdd;
    const percent = showKeyboard ? rawPercent : null;
    this.logger.log(
      `📨 handleTipsMessage: percent=${percent} isAviso=${isAviso} hasMedia=${hasMedia} showKeyboard=${showKeyboard}`,
    );
    if (rawPercent === null && !isAviso) return;

    const { tip, created } = await this.tipsService.recordTip({
      chatId,
      messageId,
      text,
      percent,
      isAviso,
      hasMedia,
      entities: entities ?? null,
    });
    // Reentrega do webhook (o Telegram repete quando a resposta demora): a
    // primeira entrega já fez o fan-out, repetir mandaria a DM duas vezes.
    if (!created) {
      this.logger.log(`📨 handleTipsMessage: tip ${tip.id} já registrada, fan-out ignorado`);
      return;
    }

    const users = await this.usersService.getUsersForTipsFanout();
    const limit = extractLimitFromText(text);
    // Uma vez por tip: o verificador de acesso só cruza com o perfil de cada um.
    const house = await this.findHouseRules(text);
    const { text: baseText, entities: baseEntities } =
      stripBoilerplateParagraphs(text, entities, TIP_BOILERPLATE_PATTERNS);

    const destinatarios = users.filter(
      (user) =>
        percent === null ||
        user.minPercentFilter === null ||
        percent >= Number(user.minPercentFilter),
    );

    // Em paralelo, com teto: um de cada vez, a última DM chegava segundos
    // depois da primeira. Cada envio já trata o próprio erro.
    await forEachWithConcurrency(destinatarios, FANOUT_CONCURRENCY, async (user) => {
      const stillMember = await this.tipsGroup
        .isMember(user.telegramUserId as number)
        .catch(() => false);
      if (!stillMember) return;

      await this.sendTipCopyToUser(
        user,
        tip,
        chatId,
        messageId,
        hasMedia,
        baseText,
        baseEntities,
        text,
        limit,
        showKeyboard,
        house,
      );
    });
  }

  // Manda a cópia individual de uma tip (com recomendação de aposta calculada
  // pra banca/filtro do usuário) — usado tanto pelo fan-out ao vivo quanto
  // pelo reenvio avulso de um item do /pendentes (resendTipCard). `tip` só
  // precisa de id e percent; texto/casa/odd sempre vêm recalculados a partir
  // de baseText/originalText, nunca de campos extras da tip.
  async sendTipCopyToUser(
    // `stake` vem pronto do fan-out (a query já traz); o reenvio avulso não
    // tem e busca.
    user: {
      id: number;
      telegramUserId: number | null;
      stake?: number | string | null;
      hasVpn?: boolean;
      hasCrypto?: boolean;
    },
    tip: { id: number; percent: number | null },
    chatId: number,
    messageId: number,
    hasMedia: boolean,
    baseText: string,
    baseEntities: MessageEntity[] | undefined,
    originalText: string,
    limit: number | null,
    showKeyboard = true,
    // undefined = não resolvida ainda (reenvio avulso); null = tip sem casa cadastrada.
    house?: HouseAccessRules | null,
  ) {
    let outgoingText = baseText;
    let outgoingEntities: MessageEntity[] | undefined = baseEntities;
    // NUMERIC do Postgres volta como string via pg — mesmo pra uma tip que
    // acabou de ser inserida com um number — então normaliza antes de fazer
    // conta com isso (division/toFixed em cima de string não estoura, mas
    // .toFixed(2) e comparações mais adiante esperam number de verdade).
    const percent = tip.percent !== null ? Number(tip.percent) : null;
    try {
      const userStake =
        percent === null
          ? null
          : 'stake' in user
            ? bancaDefinida(user.stake)
            : await this.usersService.getUserStake(user.id);
      if (percent !== null && userStake === null) {
        // Sem banca não existe recomendação: o Planilhar pede o /stake em vez
        // de gravar uma stake calculada sobre um valor inventado.
        outgoingText = `${baseText}\n\n${NO_BANKROLL_LINE}`;
      } else if (percent !== null && userStake !== null) {
        let recommendedStake = (percent / 100) * userStake;
        if (limit !== null)
          recommendedStake = Math.min(recommendedStake, limit);

        const recommendationValue = recommendedStake
          .toFixed(2)
          .replace('.', ',');
        const recommendationLine = `🎯 Recomendação de aposta: R$ ${recommendationValue}`;
        outgoingEntities = [
          ...(baseEntities ?? []),
          {
            type: 'bold',
            offset: baseText.length + 2,
            length: recommendationLine.length,
          },
        ];

        const odd = extractOddFromText(originalText);
        if (odd !== null) {
          const lucroValue = (recommendedStake * odd - recommendedStake)
            .toFixed(2)
            .replace('.', ',');
          const lucroLine = `💰 Lucro potencial: R$ ${lucroValue}`;
          outgoingText = `${baseText}\n\n${recommendationLine}\n${lucroLine}`;
          outgoingEntities.push({
            type: 'bold',
            offset: baseText.length + 2 + recommendationLine.length + 1,
            length: lucroLine.length,
          });
        } else {
          outgoingText = `${baseText}\n\n${recommendationLine}`;
        }
        this.logger.log(
          `🎯 Recomendação calculada (userId=${user.id}, telegramUserId=${user.telegramUserId}): banca=${userStake} percent=${percent} limit=${limit} -> R$${recommendationValue}`,
        );
      }

      // Verificador de acesso: só tip de verdade (com teclado), não aviso puro.
      if (showKeyboard) {
        const accessLine = await this.accessLineFor(user, house, originalText);
        if (accessLine) outgoingText = `${outgoingText}

${accessLine}`;
      }

      const keyboard = showKeyboard ? this.tipsCopyKeyboard(tip.id) : undefined;
      const sent = hasMedia
        ? await this.bot.telegram.copyMessage(
            user.telegramUserId as number,
            chatId,
            messageId,
            {
              caption: outgoingText,
              caption_entities: outgoingEntities,
              reply_markup: keyboard,
            },
          )
        : await this.bot.telegram.sendMessage(
            user.telegramUserId as number,
            outgoingText,
            {
              entities: outgoingEntities,
              reply_markup: keyboard,
            },
          );

      // Sem botão não tem o que resolver depois (nem Planilhar nem Caiu),
      // então nem faz sentido guardar delivery pra essa cópia.
      if (showKeyboard) {
        // Guarda essa cópia (texto/entidades exatos) pra dar pra editar depois
        // — é o que permite o /pendentes marcar "✅ PLANILHADO"/"❌ APOSTA CAIU"
        // direto na mensagem que o usuário recebeu, mesmo resolvendo pela lista
        // em vez de clicar na mensagem original.
        await this.tipsService.saveDelivery({
          tipId: tip.id,
          userId: user.id,
          messageId: sent.message_id,
          hasMedia,
          text: outgoingText,
          entities: outgoingEntities ?? null,
        });
      }
    } catch (err) {
      this.logger.error(...errorArgs(`⚠️ Não foi possível enviar tip para o usuário (telegramUserId=${user.telegramUserId})`, err));
    }
  }

  private async findHouseRules(text: string): Promise<HouseAccessRules | null> {
    try {
      const house = await this.houses.findHouseFromText(text);
      if (!house) return null;
      return {
        requiresVpn: house.requiresVpn ?? null,
        acceptsPix: house.acceptsPix ?? null,
        acceptsCrypto: house.acceptsCrypto ?? null,
      };
    } catch (err) {
      // Sem a linha de acesso a tip ainda chega; não vale derrubar o envio.
      this.logger.warn(...errorArgs('⚠️ Verificador de acesso: casa da tip não resolvida', err));
      return null;
    }
  }

  private async accessLineFor(
    user: { id: number; hasVpn?: boolean; hasCrypto?: boolean },
    house: HouseAccessRules | null | undefined,
    originalText: string,
  ): Promise<string | null> {
    const rules = house === undefined ? await this.findHouseRules(originalText) : house;
    if (!rules) return null;
    let profile = { hasVpn: user.hasVpn, hasCrypto: user.hasCrypto };
    if (profile.hasVpn === undefined || profile.hasCrypto === undefined) {
      const full = await this.usersService.findById(user.id);
      profile = { hasVpn: full?.hasVpn, hasCrypto: full?.hasCrypto };
    }
    return houseAccessLine(
      checkHouseAccess(rules, { hasVpn: !!profile.hasVpn, hasCrypto: !!profile.hasCrypto }),
    );
  }

  // Reenvia uma única tip (a pedido do botão "✏️ Editar" da lista) como o
  // card completo de sempre — reaproveita sendTipCopyToUser, então ganha o
  // mesmo Planilhar/Editar/Aposta Caiu que a tip teria tido na hora que
  // chegou no grupo.
  async resendTipCard(
    user: { id: number; telegramUserId: number | null },
    tipId: number,
  ): Promise<boolean> {
    const tip = await this.tipsService.findById(tipId);
    if (!tip) return false;

    const { text: baseText, entities: baseEntities } =
      stripBoilerplateParagraphs(
        tip.text,
        // Gravadas do próprio update do Telegram (recordTip): são MessageEntity.
        (tip.entities ?? undefined) as MessageEntity[] | undefined,
        TIP_BOILERPLATE_PATTERNS,
      );
    const limit = extractLimitFromText(tip.text);
    await this.sendTipCopyToUser(
      user,
      tip,
      tip.chatId,
      tip.messageId,
      tip.hasMedia,
      baseText,
      baseEntities,
      tip.text,
      limit,
    );
    return true;
  }

  // Edita a última cópia de DM conhecida pra essa (tip, usuário) — marca o
  // mesmo banner "✅ PLANILHADO"/"❌ APOSTA CAIU" que já aparece quando se
  // clica direto na mensagem, só que a partir da ação feita na lista do
  // /pendentes. Sem delivery salva (tip antiga, de antes dessa mudança) não
  // tem o que editar — segue sem erro, só não atualiza a mensagem original.
  async markDeliveredMessage(
    user: { id: number; telegramUserId: number | null },
    tipId: number,
    kind: 'planilhado' | 'caiu',
  ) {
    if (!user.telegramUserId) return;
    try {
      const delivery = await this.tipsService.findDelivery(tipId, user.id);
      if (!delivery) return;

      const prefix = kind === 'caiu' ? '❌ APOSTA CAIU' : '✅ PLANILHADO';
      const novoTexto = `${prefix}\n\n${delivery.text}`;
      const keyboard =
        kind === 'caiu'
          ? {
              inline_keyboard: [
                [{ text: '↩️ Voltar', callback_data: `voltar:${tipId}` }],
              ],
            }
          : {
              inline_keyboard: [
                [{ text: '✅ Planilhado', callback_data: 'done' }],
              ],
            };

      if (delivery.hasMedia) {
        await this.bot.telegram.editMessageCaption(
          user.telegramUserId,
          delivery.messageId,
          undefined,
          novoTexto,
          {
            reply_markup: keyboard,
          },
        );
      } else {
        await this.bot.telegram.editMessageText(
          user.telegramUserId,
          delivery.messageId,
          undefined,
          novoTexto,
          {
            reply_markup: keyboard,
          },
        );
      }
    } catch (err) {
      this.logger.error(...errorArgs(`⚠️ Não foi possível atualizar a mensagem original da tip (tipId=${tipId})`, err));
    }
  }
}
