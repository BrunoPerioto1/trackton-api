import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { BetModule } from './module/bet.module';
import { BetSlipModule } from './module/bet-slip.module';
import { TelegramModule } from './module/telegram.module';
import { HouseModule } from './module/house.module';
import { DashboardModule } from './module/dashboard.module';
import { TransactionModule } from './module/transaction.module';
import { AuthModule } from './module/auth.module';
import { TelegramLinkModule } from './module/telegram-link.module';
import { TipsModule } from './module/tips.module';
import { SettlementModule } from './module/settlement.module';
import { AdminModule } from './module/admin.module';
import { BillingModule } from './module/billing.module';

@Module({
  imports: [
    // Carrega o .env (local; na Vercel as variáveis já estão no processo) e
    // valida tudo no boot. Os módulos continuam lendo process.env.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    BetModule,
    BetSlipModule,
    TelegramModule,
    HouseModule,
    DashboardModule,
    TransactionModule,
    AuthModule,
    TelegramLinkModule,
    TipsModule,
    SettlementModule,
    AdminModule,
    BillingModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
