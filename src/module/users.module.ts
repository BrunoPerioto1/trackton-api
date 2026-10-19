import { Module } from '@nestjs/common';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { UsersRepository } from '../infra/repository/users.repository';
import { DatabaseModule } from '../infra/db/db.module';
import { TelegramBotModule } from './telegram-bot.module';
import { RateLimitModule } from './rate-limit.module';
import { BillingModule } from './billing.module';

@Module({
  // TelegramBotModule pela porta do grupo Tips: desvincular, trocar de
  // Telegram e excluir a conta tiram a pessoa de lá. RateLimitModule pela
  // cota de IA do Grátis, que o /users/me mostra. BillingModule porque
  // excluir a conta cancela a assinatura.
  imports: [DatabaseModule, TelegramBotModule, RateLimitModule, BillingModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
