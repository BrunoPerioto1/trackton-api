import { Inject, Injectable, Logger } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { TELEGRAM_BOT } from './telegram-bot.provider';
import { UsersRepository } from '../infra/repository/users.repository';
import { ADMIN_ROLE_ID } from '../common/guards/admin.guard';
import { unlinkedInstructions } from './messages.const';
import { accessBlock, subscribeKeyboard, subscribeLine } from '../users/access';
import { errorArgs } from '../common/utils/log';

// Curto o bastante pra um convite esquecido no chat não virar porta aberta. E,
// como o link pede aprovação, quem não pagou esbarra no bot mesmo com ele na mão.
const INVITE_TTL_SECONDS = 24 * 60 * 60;

type JoinRequest = {
  chat: { id: number };
  from: { id: number };
  user_chat_id: number;
};

const spDate = (d: Date) =>
  new Date(d).toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  });

// Dentro do grupo de verdade: "restricted" também pode ser quem já saiu.
function insideGroup(member: { status: string; is_member?: boolean }): boolean {
  return (
    member.status === 'creator' ||
    member.status === 'administrator' ||
    member.status === 'member' ||
    (member.status === 'restricted' && member.is_member === true)
  );
}

/** O motivo que o Telegram deu pra recusar, ou a mensagem do erro. */
export function telegramErrorText(error: unknown): string {
  return (
    (error as { response?: { description?: string } })?.response?.description ??
    (error instanceof Error ? error.message : 'erro desconhecido')
  );
}

/** Por que o Telegram perdeu o vínculo com a conta. */
export type LeaveReason = 'unlinked' | 'relinked' | 'deleted';

// O que a pessoa lê no privado depois de sair do grupo.
const LEAVE_NOTICE: Record<LeaveReason, string> = {
  unlinked:
    '🔗 Este Telegram foi desvinculado da sua conta do Trackton, então saiu do grupo de Tips.\n\n' +
    'Pra voltar, vincule de novo pelo site (Perfil → Telegram): com o acesso em dia, o convite do grupo chega aqui.',
  relinked: '🔗 Sua conta do Trackton foi vinculada a outro Telegram, então este saiu do grupo de Tips.',
  deleted: '🗑 Sua conta do Trackton foi excluída, então este Telegram saiu do grupo de Tips.',
};

const LEAVE_ACTION: Record<LeaveReason, string> = {
  unlinked: 'desvincular o Telegram',
  relinked: 'trocar de Telegram',
  deleted: 'excluir a conta',
};

/** O bastante pra tirar do grupo e, se falhar, o admin achar a pessoa. */
export interface LeavingMember {
  // BIGINT: o pg devolve como string. null = sem Telegram, nada a tirar.
  telegramUserId: number | string | null;
  telegramUsername?: string | null;
  fullName?: string | null;
  username?: string | null;
  email?: string | null;
}

// O Telegram não esconde mensagem de quem é membro: o único jeito de quem não
// pagou deixar de ler o grupo Tips é estar fora dele. Esta classe é a porta —
// entra por pedido (o bot aprova só vinculado e em dia), sai pelo painel (ban,
// senão volta pelo link que já tem) e volta com convite quando o acesso é
// liberado. Pressupõe o bot admin do grupo com "Banir usuários" e "Convidar
// usuários via link".
@Injectable()
export class TipsGroupService {
  private readonly logger = new Logger(TipsGroupService.name);

  private readonly chatId: number | null;

  // Repositório e não UsersService: é o UsersService que usa esta classe
  // (desvincular e excluir conta tiram a pessoa do grupo).
  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Telegraf,
    private readonly usersRepository: UsersRepository,
  ) {
    const chatId = Number(process.env.TIPS_GROUP_CHAT_ID);
    this.chatId = Number.isFinite(chatId) && chatId !== 0 ? chatId : null;
    if (!this.chatId) {
      this.logger.warn(
        '⚠️  TIPS_GROUP_CHAT_ID não definido — fan-out e controle de entrada do grupo Tips ficam desativados.',
      );
    }
  }

  get configured(): boolean {
    return this.chatId !== null;
  }

  isTipsGroup(chatId: number): boolean {
    return this.chatId !== null && chatId === this.chatId;
  }

  // Só manda tip pra quem ainda está no grupo Tips — evita continuar mandando
  // DM pra quem já vinculou a conta um dia mas saiu do grupo depois.
  async isMember(telegramUserId: number): Promise<boolean> {
    if (!this.chatId) return true;
    try {
      const member = await this.bot.telegram.getChatMember(
        this.chatId,
        telegramUserId,
      );
      return member.status !== 'left' && member.status !== 'kicked';
    } catch (err) {
      this.logger.error(...errorArgs(`⚠️ Não foi possível checar membro do grupo Tips (telegramUserId=${telegramUserId})`, err));
      return false;
    }
  }

  // Ban sem prazo: dura até o readmit. Só pelo painel: cair no Grátis não
  // tira ninguém do grupo. O aviso é cortesia — se não sair (a pessoa
  // bloqueou o bot), a remoção continua valendo.
  async remove(telegramUserId: number): Promise<void> {
    if (!this.chatId) throw new Error('TIPS_GROUP_CHAT_ID não definido');
    await this.bot.telegram.banChatMember(this.chatId, telegramUserId);

    await this.bot.telegram
      .sendMessage(
        telegramUserId,
        `🔒 Você saiu do grupo de Tips.\n\n${subscribeLine()}`,
        { reply_markup: subscribeKeyboard() },
      )
      .catch((error) =>
        this.logger.error(...errorArgs(`⚠️ Aviso de saída do grupo Tips falhou (telegramUserId=${telegramUserId})`, error)),
      );
  }

  /**
   * Acesso liberado: quem está fora do grupo ganha um convite no privado
   * (e perde o ban, se tiver). Quem continua lá dentro não recebe nada.
   * Chamar depois de gravar o novo vencimento — o convite pede aprovação, e
   * o bot aprova lendo o banco.
   *
   * null = nada a fazer; 'failed' = o Telegram recusou alguma etapa (o erro
   * vai pro log, e repetir é seguro). `intro` troca a primeira linha quando o
   * motivo não é acesso liberado (ex.: vinculou o Telegram de novo).
   */
  async readmit(
    telegramUserId: number,
    accessUntil: Date | null,
    intro?: string,
  ): Promise<'sent' | 'failed' | null> {
    if (!this.chatId) return null;
    try {
      const member = await this.bot.telegram.getChatMember(
        this.chatId,
        telegramUserId,
      );
      if (insideGroup(member)) return null;

      if (member.status === 'kicked') {
        await this.bot.telegram.unbanChatMember(this.chatId, telegramUserId, {
          only_if_banned: true,
        });
      }
      const link = await this.bot.telegram.createChatInviteLink(this.chatId, {
        creates_join_request: true,
        expire_date: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
      });
      const until = accessUntil ? ` até ${spDate(accessUntil)}` : '';
      await this.bot.telegram.sendMessage(
        telegramUserId,
        `${intro ?? `✅ Acesso liberado${until}.`}\n\nPra voltar ao grupo de Tips, entre por este link (vale 24h):\n${link.invite_link}`,
      );
      return 'sent';
    } catch (error) {
      this.logger.error(...errorArgs(`⚠️ Convite do grupo Tips falhou (telegramUserId=${telegramUserId})`, error));
      return 'failed';
    }
  }

  /**
   * Tira do grupo Tips o Telegram que perdeu o vínculo com a conta
   * (desvinculou, trocou de Telegram ou excluiu a conta). Sem isso, quem
   * pagava um mês desvinculava e seguia lendo as tips depois de vencer: sem o
   * ID salvo, nem o "Tirar do grupo" do painel alcançava a pessoa.
   *
   * O ban é só o jeito de tirar — o unban logo depois deixa voltar pelo
   * convite quando vincular de novo. Nunca lança: desvincular e excluir não
   * podem travar por causa do Telegram, então a falha vai pros admins com o ID
   * pra tirar à mão.
   *
   * null = nada a fazer (sem Telegram, grupo não configurado, fora do grupo,
   * ou admin dele).
   */
  async leave(member: LeavingMember, reason: LeaveReason): Promise<'removed' | 'failed' | null> {
    if (!this.chatId || member.telegramUserId == null) return null;
    const telegramUserId = Number(member.telegramUserId);
    try {
      const current = await this.bot.telegram.getChatMember(this.chatId, telegramUserId);
      // Dono e admins do grupo são da equipe, e o bot nem consegue tirar.
      if (current.status === 'creator' || current.status === 'administrator') return null;
      if (!insideGroup(current)) return null;
      await this.bot.telegram.banChatMember(this.chatId, telegramUserId);
    } catch (error) {
      this.logger.error(...errorArgs(`⚠️ Saída do grupo Tips falhou (telegramUserId=${telegramUserId})`, error));
      await this.alertAdmins(member, reason, error);
      return 'failed';
    }

    // Unban que falha deixa o ban: o readmit desfaz quando a pessoa voltar.
    await this.bot.telegram
      .unbanChatMember(this.chatId, telegramUserId, { only_if_banned: true })
      .catch((error: Error) =>
        this.logger.warn(`unban depois da saída do grupo Tips falhou (telegramUserId=${telegramUserId}): ${error.message}`),
      );
    await this.bot.telegram
      .sendMessage(telegramUserId, LEAVE_NOTICE[reason])
      .catch((error: Error) =>
        this.logger.warn(`aviso de saída do grupo Tips falhou (telegramUserId=${telegramUserId}): ${error.message}`),
      );
    return 'removed';
  }

  private async alertAdmins(member: LeavingMember, reason: LeaveReason, error: unknown) {
    const who = member.fullName || member.username || member.email || 'Conta sem nome';
    const handle = member.telegramUsername ? ` (@${member.telegramUsername})` : '';
    const text =
      `⚠️ Não consegui tirar ${who}${handle} do grupo de Tips ao ${LEAVE_ACTION[reason]}: ${telegramErrorText(error)}\n` +
      `Telegram ID: ${member.telegramUserId}. Tire manualmente pelo grupo.`;
    try {
      const admins = await this.usersRepository.findAdminsWithTelegram(ADMIN_ROLE_ID);
      for (const admin of admins) {
        await this.bot.telegram
          .sendMessage(admin.telegramUserId as number, text)
          .catch((e: Error) => this.logger.warn(`alerta de saída do grupo Tips não chegou ao admin: ${e.message}`));
      }
    } catch (e) {
      this.logger.error(...errorArgs('⚠️ Não deu pra avisar os admins da saída do grupo Tips', e));
    }
  }

  // Entrada só por pedido: o bot aprova quem é vinculado e está em dia, e
  // recusa o resto dizendo o que falta.
  async handleJoinRequest(request: JoinRequest): Promise<void> {
    if (!this.chatId || !this.isTipsGroup(request.chat.id)) return;
    const telegramUserId = request.from.id;

    let user: Awaited<ReturnType<UsersRepository['findByTelegramUserId']>>;
    try {
      user = await this.usersRepository.findByTelegramUserId(telegramUserId);
    } catch (error) {
      // Banco fora: o pedido fica pendente e um admin decide pelo Telegram.
      this.logger.error(...errorArgs('Erro ao conferir pedido de entrada no grupo Tips', error));
      return;
    }

    const block = user ? accessBlock(user) : 'unlinked';
    try {
      if (!block) {
        await this.bot.telegram.approveChatJoinRequest(
          this.chatId,
          telegramUserId,
        );
        // Voltou pelo link: o "fora do grupo" do painel deixou de valer.
        if (user?.tipsGroupRemovedAt) {
          await this.usersRepository
            .updateUser(user.id, { tipsGroupRemovedAt: null })
            .catch((error: Error) => this.logger.warn(`marca de fora do grupo não saiu (userId=${user?.id}): ${error.message}`));
        }
        return;
      }

      // O Telegram só deixa o bot falar com quem pediu enquanto o pedido está
      // aberto: a explicação vai antes da recusa.
      await this.explainRefusal(request.user_chat_id, block, user?.accessUntil)
        .catch((error) =>
          this.logger.error(...errorArgs(`⚠️ Explicação da recusa no grupo Tips falhou (telegramUserId=${telegramUserId})`, error)),
        );
      await this.bot.telegram.declineChatJoinRequest(
        this.chatId,
        telegramUserId,
      );
    } catch (error) {
      this.logger.error(...errorArgs(`⚠️ Pedido de entrada no grupo Tips não resolvido (telegramUserId=${telegramUserId})`, error));
    }
  }

  private explainRefusal(
    chatId: number,
    block: 'unlinked' | 'inactive' | 'expired',
    accessUntil: Date | null | undefined,
  ) {
    if (block === 'unlinked') {
      return this.bot.telegram.sendMessage(
        chatId,
        `${unlinkedInstructions()}\n\nO grupo de Tips é só pra contas vinculadas e em dia. Depois de vincular, peça pra entrar de novo pelo mesmo link.`,
      );
    }
    if (block === 'inactive') {
      return this.bot.telegram.sendMessage(
        chatId,
        '🚫 Sua conta está desativada. Fale com o administrador.',
      );
    }
    return this.bot.telegram.sendMessage(
      chatId,
      `🔒 O grupo de Tips é pra quem está no Pro, e o seu acabou em ${spDate(accessUntil as Date)}. Por isso o pedido pra entrar foi recusado.\n\n${subscribeLine()}`,
      { reply_markup: subscribeKeyboard() },
    );
  }
}
