import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Versão sem HTML: cliente que não renderiza e filtro de spam leem esta. */
  text: string;
}

/** Falta RESEND_API_KEY ou MAIL_FROM: erro do servidor, não de quem pediu. */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super('E-mail não configurado: defina RESEND_API_KEY e MAIL_FROM');
    this.name = 'EmailNotConfiguredError';
  }
}

/** O provedor recusou ou não respondeu. A mensagem é pro log, nunca pro front. */
export class EmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

/**
 * Porta única de e-mail da API: o resto do código chama `send` e não sabe que
 * por trás é o Resend. Trocar de provedor mexe só aqui.
 *
 * A chave e o remetente vêm de env (RESEND_API_KEY, MAIL_FROM). Sem eles a API
 * sobe normalmente e só o envio falha, com EmailNotConfiguredError — exigir no
 * boot derrubaria a API inteira por causa de um recurso.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly client: Resend | null;
  private readonly from: string | null;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    this.from = process.env.MAIL_FROM?.trim() || null;
    // O construtor do SDK lança sem chave: só cria quando há o que usar.
    this.client = apiKey ? new Resend(apiKey) : null;
    if (!this.isConfigured()) {
      this.logger.warn(
        'E-mail desligado: RESEND_API_KEY e MAIL_FROM não definidas.',
      );
    }
  }

  isConfigured(): boolean {
    return this.client !== null && this.from !== null;
  }

  async send(message: EmailMessage): Promise<void> {
    if (!this.client || !this.from) throw new EmailNotConfiguredError();

    // O SDK não lança em erro da API nem em falha de rede: devolve `error`.
    const { error } = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    if (error)
      throw new EmailDeliveryError(
        `Resend recusou o envio (${error.name}): ${error.message}`,
      );
  }
}
