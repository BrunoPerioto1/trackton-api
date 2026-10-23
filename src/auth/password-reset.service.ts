import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Telegraf } from 'telegraf';
import { TELEGRAM_BOT } from '../telegram/telegram-bot.provider';
import { UsersRepository } from '../infra/repository/users.repository';
import { EmailService } from '../email/email.service';
import { passwordResetEmail } from '../email/templates/password-reset';
import { frontUrl } from '../common/utils/front-url';

const TOKEN_TTL_MINUTES = 30;
const TOKEN_TTL_MS = TOKEN_TTL_MINUTES * 60_000;
// Um link novo por minuto: segurar o dedo no botão não vira spam na caixa.
const RESEND_AFTER_MS = 60_000;

const INVALID = 'Link inválido ou vencido. Peça um novo.';

// 32 bytes aleatórios: chutar é inviável, então não precisa do teto de
// tentativas que o código de 6 dígitos tinha. SHA-256 (e não bcrypt) porque o
// token já é forte e o banco precisa achar a conta pelo hash.
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * "Esqueci a senha" por link: o token vai por e-mail pra toda conta e, pra
 * quem vinculou o Telegram, também no privado do bot. Só o hash fica no banco
 * (users.password_reset_code_hash, a coluna do antigo código de 6 dígitos).
 *
 * A resposta do pedido é a mesma exista ou não a conta — senão a tela viraria
 * um jeito de descobrir quais e-mails estão cadastrados.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly email: EmailService,
    @Inject(TELEGRAM_BOT) private readonly bot: Telegraf,
  ) {}

  async request(email: string): Promise<void> {
    // Sem e-mail configurado, quem não tem Telegram ficaria esperando um link
    // que nunca sai. Falha pra todo mundo e antes de olhar a conta: o erro é
    // do servidor e não revela se o e-mail existe.
    if (!this.email.isConfigured()) {
      this.logger.error(
        'Esqueci a senha sem e-mail configurado: defina RESEND_API_KEY e MAIL_FROM.',
      );
      throw new ServiceUnavailableException(
        'A recuperação de senha está indisponível agora. Tente de novo mais tarde.',
      );
    }

    const user = await this.usersRepository.findByEmail(email.trim());
    if (!user || user.isActive === false) return;

    const sentAt = user.passwordResetExpiresAt
      ? new Date(user.passwordResetExpiresAt).getTime() - TOKEN_TTL_MS
      : 0;
    if (Date.now() - sentAt < RESEND_AFTER_MS) return;

    const token = randomBytes(32).toString('base64url');
    await this.usersRepository.updateUser(user.id, {
      passwordResetCodeHash: hashResetToken(token),
      passwordResetExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });

    const resetUrl = `${frontUrl('/redefinir-senha')}?token=${token}`;
    await Promise.all([
      this.sendByEmail(user.id, user.email, resetUrl),
      user.telegramUserId
        ? this.sendByTelegram(user.id, user.telegramUserId, resetUrl)
        : null,
    ]);
  }

  async reset(token: string, newPassword: string): Promise<void> {
    const tokenHash = hashResetToken(token.trim());
    const user = await this.usersRepository.findByPasswordResetHash(tokenHash);
    const expiresAt = user?.passwordResetExpiresAt
      ? new Date(user.passwordResetExpiresAt).getTime()
      : 0;
    if (!user || user.isActive === false || expiresAt <= Date.now()) {
      throw new BadRequestException(INVALID);
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    if (
      !(await this.usersRepository.consumePasswordReset(
        user.id,
        tokenHash,
        passwordHash,
      ))
    ) {
      throw new BadRequestException(INVALID);
    }
  }

  // Falha de entrega não vira erro na resposta: o pedido já respondeu igual
  // pra todo mundo, e um 500 aqui diria que a conta existe. Fica no log.
  private async sendByEmail(userId: number, to: string, resetUrl: string) {
    try {
      await this.email.send({
        to,
        ...passwordResetEmail({ resetUrl, validMinutes: TOKEN_TTL_MINUTES }),
      });
    } catch (error) {
      this.logger.error(
        `link de senha nao saiu por e-mail (userId=${userId}): ${(error as Error).message}`,
      );
    }
  }

  private async sendByTelegram(
    userId: number,
    telegramUserId: number,
    resetUrl: string,
  ) {
    try {
      await this.bot.telegram.sendMessage(
        telegramUserId,
        `🔑 Pediram pra redefinir a senha da sua conta no Trackton.\n\nO link vale ${TOKEN_TTL_MINUTES} minutos e só funciona uma vez. Se não foi você, ignore: sua senha continua a mesma.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: 'Redefinir senha', url: resetUrl }]],
          },
        },
      );
    } catch (error) {
      this.logger.warn(
        `link de senha nao saiu pelo bot (userId=${userId}): ${(error as Error).message}`,
      );
    }
  }
}
