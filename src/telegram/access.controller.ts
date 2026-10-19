import { Controller, Get, Inject, Logger, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Telegraf } from 'telegraf';
import { TELEGRAM_BOT } from './telegram-bot.provider';
import { UsersRepository } from '../infra/repository/users.repository';
import { ADMIN_ROLE_ID } from '../common/guards/admin.guard';
import { CronGuard } from '../common/guards/cron.guard';
import { daysUntil, subscribeKeyboard, subscribeLine } from '../users/access';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { errorArgs } from '../common/utils/log';

// Dias antes do fim do Pro em que o cliente é lembrado. Cron roda 1x/dia, então
// cada aviso sai uma vez só sem precisar guardar "já avisei".
const REMINDER_DAYS: Record<number, string> = {
  3: '⏳ Seu Pro acaba em 3 dias',
  1: '⚠️ Seu Pro acaba amanhã',
  0: '🔓 Seu Pro acabou hoje e a conta passou pro Grátis',
};

@ApiTags('access')
@Controller('access')
export class AccessController {
  private readonly logger = new Logger(AccessController.name);

  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Telegraf,
    private readonly usersRepository: UsersRepository,
    private readonly rateLimit: RateLimitService,
  ) {}

  // Chamado pelo cron da Vercel (vercel.json), que manda Bearer CRON_SECRET.
  @Get('cron')
  @ApiExcludeEndpoint()
  @UseGuards(CronGuard)
  async remind() {
    const users = await this.usersRepository.findWithAccessDeadline();
    const summary: string[] = [];

    for (const user of users) {
      if (user.isActive === false || !user.accessUntil) continue;
      // Assinatura rodando: a cobrança renova sozinha, não há o que lembrar.
      if (user.subscriptionStatus === 'authorized') continue;
      const days = daysUntil(user.accessUntil);
      const headline = REMINDER_DAYS[days];
      if (!headline) continue;

      const date = new Date(user.accessUntil).toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
      });
      summary.push(
        `• ${user.username}: ${days === 0 ? 'Pro acabou hoje' : `Pro acaba em ${days}d`} (${date})${user.telegramUserId ? '' : ' — sem Telegram'}`,
      );
      if (!user.telegramUserId) continue;

      try {
        await this.bot.telegram.sendMessage(
          user.telegramUserId,
          `${headline} (${date}).\n\n${subscribeLine()}`,
          { reply_markup: subscribeKeyboard() },
        );
      } catch (error) {
        this.logger.error(...errorArgs(`⚠️ Aviso de fim do Pro falhou (userId=${user.id})`, error));
      }
    }

    if (summary.length) {
      const admins =
        await this.usersRepository.findAdminsWithTelegram(ADMIN_ROLE_ID);
      for (const admin of admins) {
        await this.bot.telegram
          .sendMessage(
            admin.telegramUserId as number,
            `📅 Pro acabando (sem assinatura):\n${summary.join('\n')}`,
          )
          .catch((error) =>
            this.logger.error(...errorArgs('⚠️ Resumo de vencimentos falhou', error)),
          );
      }
    }

    // Faxina diária do contador de limite (janelas de mais de um dia).
    await this.rateLimit.purgeOld();

    return { notified: summary.length };
  }
}
