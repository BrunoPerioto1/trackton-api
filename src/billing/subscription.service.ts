import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { TELEGRAM_BOT } from '../telegram/telegram-bot.provider';
import { UsersRepository } from '../infra/repository/users.repository';
import { BillingRepository } from '../infra/repository/billing.repository';
import { ADMIN_ROLE_ID } from '../common/guards/admin.guard';
import { frontUrl } from '../common/utils/front-url';
import { errorArgs } from '../common/utils/log';
import type { UserId } from '../db_types/Users';
import { mercadoPago, mercadoPagoConfigured, type Preapproval } from './mercadopago.client';
import { proPrice } from '../users/plan';

const DAY_MS = 86_400_000;
// Folga depois do mês pago: cobrança recusada no cartão é tentada de novo por
// alguns dias, e o Pro não cai no meio disso.
const GRACE_DAYS = 3;
const REFERENCE_PREFIX = 'sts-user-';

// O dono vai no external_reference: é como o aviso do Mercado Pago chega na conta.
export const subscriptionReference = (userId: number) => `${REFERENCE_PREFIX}${userId}`;

export function userIdFromReference(reference: string | null | undefined): number | null {
  if (!reference?.startsWith(REFERENCE_PREFIX)) return null;
  const id = Number(reference.slice(REFERENCE_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Um mês depois de `from` (mesmo dia; 31/01 vira 28/02 ou 29/02), mais a folga. */
export function paidProUntil(from: Date): Date {
  const next = new Date(from);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return new Date(next.getTime() + GRACE_DAYS * DAY_MS);
}

/**
 * Assinatura do Pro no Mercado Pago, sem plano e com pagamento pendente: o
 * servidor cria a assinatura e manda a pessoa pro checkout do Mercado Pago,
 * onde ela escolhe cartão, Pix ou boleto. Quem libera o Pro é a mensalidade
 * aprovada (webhook), não a volta do checkout.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly billingRepository: BillingRepository,
    @Inject(TELEGRAM_BOT) private readonly bot: Telegraf,
  ) {}

  async subscribe(userId: number, payerEmail: string): Promise<{ initPoint: string }> {
    if (!mercadoPagoConfigured()) {
      throw new ServiceUnavailableException('Assinatura indisponível no momento. Tente mais tarde.');
    }
    const user = await this.usersRepository.findById(userId as UserId);
    if (!user) throw new BadRequestException('Usuário não encontrado.');
    if (user.subscriptionStatus === 'authorized') {
      throw new BadRequestException('Você já tem uma assinatura ativa.');
    }

    // Link anterior que não foi pago: cancela antes de criar outro. Dois links
    // abertos virariam duas assinaturas cobrando a mesma pessoa.
    if (user.mpPreapprovalId && user.subscriptionStatus === 'pending') {
      await mercadoPago.cancelPreapproval(user.mpPreapprovalId).catch((error) =>
        this.logger.warn(`assinatura pendente antiga nao cancelou (userId=${userId}): ${(error as Error).message}`),
      );
    }

    // Ainda no Pro (teste ou dias pagos): a primeira cobrança fica pro dia em
    // que ele acaba, e ninguém paga pelos dias que já tinha.
    const now = Date.now();
    const accessUntil = user.accessUntil ? new Date(user.accessUntil).getTime() : null;
    const startDate = accessUntil && accessUntil > now + 3_600_000 ? new Date(accessUntil).toISOString() : undefined;

    let preapproval: Preapproval;
    try {
      preapproval = await mercadoPago.createPreapproval({
        reason: 'Trackton Pro',
        external_reference: subscriptionReference(user.id),
        payer_email: payerEmail,
        back_url: frontUrl('/plano?retorno=mercadopago'),
        status: 'pending',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: proPrice(),
          currency_id: 'BRL',
          ...(startDate ? { start_date: startDate } : {}),
        },
      });
    } catch (error) {
      this.logger.error(...errorArgs(`⚠️ Assinatura nao criada (userId=${userId})`, error));
      throw new ServiceUnavailableException(
        'Não consegui falar com o Mercado Pago agora. Tente de novo em instantes.',
      );
    }
    if (!preapproval.init_point) {
      throw new ServiceUnavailableException('O Mercado Pago não devolveu o link de pagamento. Tente de novo.');
    }

    await this.billingRepository.setSubscription(user.id, preapproval.id, preapproval.status);
    return { initPoint: preapproval.init_point };
  }

  /** Cancela a cobrança automática. O Pro já pago continua até o fim. */
  async cancel(userId: number): Promise<void> {
    const user = await this.usersRepository.findById(userId as UserId);
    if (!user?.mpPreapprovalId || user.subscriptionStatus === 'cancelled') {
      throw new BadRequestException('Você não tem assinatura ativa.');
    }
    await this.cancelPreapproval(user.id, user.mpPreapprovalId);
  }

  /**
   * Excluir a conta cancela a assinatura antes: sem isso o cartão continuaria
   * sendo cobrado por uma conta que não existe mais. Falhou, não exclui.
   */
  async cancelBeforeDelete(user: { id: number; mpPreapprovalId: string | null; subscriptionStatus: string | null }) {
    if (!user.mpPreapprovalId || user.subscriptionStatus === 'cancelled') return;
    await this.cancelPreapproval(user.id, user.mpPreapprovalId);
  }

  private async cancelPreapproval(userId: number, preapprovalId: string) {
    if (!mercadoPagoConfigured()) {
      throw new ServiceUnavailableException('Não consegui cancelar a assinatura agora. Tente mais tarde.');
    }
    try {
      await mercadoPago.cancelPreapproval(preapprovalId);
    } catch (error) {
      this.logger.error(...errorArgs(`⚠️ Assinatura nao cancelou (userId=${userId})`, error));
      throw new ServiceUnavailableException(
        'Não consegui cancelar a assinatura no Mercado Pago agora. Tente de novo em instantes.',
      );
    }
    await this.billingRepository.setSubscriptionStatus(userId as UserId, preapprovalId, 'cancelled');
  }

  /**
   * Aviso do Mercado Pago. Nunca confia no corpo da notificação: busca o
   * recurso na API com o token do servidor e decide pelo que vier de lá.
   */
  async handleNotification(type: string | undefined, id: string | undefined): Promise<void> {
    if (!id) return;
    if (type === 'subscription_preapproval') await this.syncPreapproval(id);
    else if (type === 'subscription_authorized_payment') await this.syncAuthorizedPayment(id);
  }

  private async syncPreapproval(preapprovalId: string) {
    const preapproval = await mercadoPago.getPreapproval(preapprovalId);
    const userId = userIdFromReference(preapproval.external_reference);
    if (!userId) return;
    await this.billingRepository.setSubscriptionStatus(userId as UserId, preapproval.id, preapproval.status);
  }

  private async syncAuthorizedPayment(authorizedPaymentId: string) {
    const invoice = await mercadoPago.getAuthorizedPayment(authorizedPaymentId);
    const payment = invoice.payment;
    if (!payment || payment.status !== 'approved') return;

    let user = await this.billingRepository.findUserByPreapprovalId(invoice.preapproval_id);
    if (!user) {
      // Assinatura que não é mais a atual da conta (trocou de link): acha o
      // dono pela referência. Pagou, então conta igual.
      const preapproval = await mercadoPago.getPreapproval(invoice.preapproval_id);
      const userId = userIdFromReference(preapproval.external_reference);
      user = userId ? await this.usersRepository.findById(userId as UserId) : undefined;
    }
    if (!user) {
      this.logger.error(`⚠️ Mensalidade aprovada sem dono: preapproval=${invoice.preapproval_id} payment=${payment.id}`);
      return;
    }

    const proUntil = paidProUntil(new Date());
    const isNew = await this.billingRepository.recordPayment({
      userId: user.id,
      mpPaymentId: String(payment.id),
      mpPreapprovalId: invoice.preapproval_id,
      amount: Number(invoice.transaction_amount),
      proUntil,
    });
    if (!isNew) return;
    // Pagou: a assinatura está rodando, mesmo que o aviso de status ainda não tenha chegado.
    await this.billingRepository.setSubscriptionStatus(user.id, invoice.preapproval_id, 'authorized');
    await this.notifyPaid(user, Number(invoice.transaction_amount), proUntil);
  }

  // Avisos de cortesia: o pagamento já está gravado, falhar aqui não desfaz nada.
  private async notifyPaid(
    user: { id: number; username: string; email: string; fullName: string | null; telegramUserId: number | null; accessUntil: Date | null },
    amount: number,
    proUntil: Date,
  ) {
    const fresh = await this.usersRepository.findById(user.id as UserId).catch(() => undefined);
    const until = (fresh?.accessUntil ? new Date(fresh.accessUntil) : proUntil).toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
    });
    const price = `R$ ${amount.toFixed(2).replace('.', ',')}`;

    if (user.telegramUserId) {
      await this.bot.telegram
        .sendMessage(user.telegramUserId, `✅ Pagamento de ${price} confirmado. Seu Pro está ativo até ${until}.`)
        .catch((error: Error) => this.logger.warn(`aviso de pagamento ao usuario falhou: ${error.message}`));
    }
    const admins = await this.usersRepository.findAdminsWithTelegram(ADMIN_ROLE_ID).catch(() => []);
    for (const admin of admins) {
      await this.bot.telegram
        .sendMessage(
          admin.telegramUserId as number,
          `💰 ${user.fullName || user.username} (${user.email}) pagou ${price} da assinatura. Pro até ${until}.`,
        )
        .catch((error: Error) => this.logger.warn(`aviso de pagamento ao admin falhou: ${error.message}`));
    }
  }
}
