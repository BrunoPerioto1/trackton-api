import { Module } from '@nestjs/common';
import { EmailService } from '../email/email.service';

// Módulo próprio pra qualquer feature importar o envio sem puxar o Auth junto.
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
