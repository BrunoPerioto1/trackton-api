import { Module } from '@nestjs/common';
import { BillingController } from '../billing/billing.controller';
import { SubscriptionService } from '../billing/subscription.service';
import { BillingRepository } from '../infra/repository/billing.repository';
import { UsersRepository } from '../infra/repository/users.repository';
import { TelegramBotModule } from './telegram-bot.module';

// Assinatura do Pro no Mercado Pago. UsersRepository próprio (o banco vem do
// DatabaseModule, global) em vez de importar o UsersModule: é o UsersModule
// que importa este, porque excluir a conta cancela a assinatura antes.
@Module({
  imports: [TelegramBotModule],
  controllers: [BillingController],
  providers: [SubscriptionService, BillingRepository, UsersRepository],
  exports: [SubscriptionService],
})
export class BillingModule {}
