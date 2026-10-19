import { Module } from '@nestjs/common';
import {
  TELEGRAM_BOT,
  createTelegramBot,
} from '../telegram/telegram-bot.provider';
import { TipsGroupService } from '../telegram/tips-group.service';
import { UsersRepository } from '../infra/repository/users.repository';

// O bot e a porta do grupo Tips num módulo à parte: o painel admin também
// tira gente do grupo e manda convite, e importar o TelegramModule inteiro lá
// levaria junto os handlers e o fan-out. A assinatura (BillingModule) usa o
// bot pelo mesmo motivo, pra avisar o pagamento.
//
// UsersRepository próprio (o banco vem do DatabaseModule, global) em vez de
// importar o UsersModule: é o UsersModule que importa este módulo, porque
// desvincular e excluir conta tiram a pessoa do grupo.
@Module({
  providers: [
    { provide: TELEGRAM_BOT, useFactory: createTelegramBot },
    UsersRepository,
    TipsGroupService,
  ],
  exports: [TELEGRAM_BOT, TipsGroupService],
})
export class TelegramBotModule {}
