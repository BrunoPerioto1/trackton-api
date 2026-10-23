const send = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send } })),
}));

import { Resend } from 'resend';
import {
  EmailDeliveryError,
  EmailNotConfiguredError,
  EmailService,
} from './email.service';
import { passwordResetEmail } from './templates/password-reset';

const message = {
  to: 'f@x.com',
  subject: 'Assunto',
  html: '<p>oi</p>',
  text: 'oi',
};

function withEnv(env: { RESEND_API_KEY?: string; MAIL_FROM?: string }) {
  process.env.RESEND_API_KEY = env.RESEND_API_KEY ?? '';
  process.env.MAIL_FROM = env.MAIL_FROM ?? '';
  return new EmailService();
}

beforeEach(() => {
  send.mockReset();
  (Resend as unknown as jest.Mock).mockClear();
});

describe('EmailService', () => {
  it('sem RESEND_API_KEY fica desligado e nem cria o cliente', async () => {
    const service = withEnv({ MAIL_FROM: 'onboarding@resend.dev' });
    expect(service.isConfigured()).toBe(false);
    expect(Resend).not.toHaveBeenCalled();
    await expect(service.send(message)).rejects.toBeInstanceOf(
      EmailNotConfiguredError,
    );
  });

  it('sem MAIL_FROM fica desligado', async () => {
    const service = withEnv({ RESEND_API_KEY: 're_teste' });
    expect(service.isConfigured()).toBe(false);
    await expect(service.send(message)).rejects.toBeInstanceOf(
      EmailNotConfiguredError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('manda pelo Resend com o remetente da env', async () => {
    send.mockResolvedValueOnce({ data: { id: 'abc' }, error: null });
    const service = withEnv({
      RESEND_API_KEY: 're_teste',
      MAIL_FROM: 'Trackton <onboarding@resend.dev>',
    });
    await service.send(message);
    expect(Resend).toHaveBeenCalledWith('re_teste');
    expect(send).toHaveBeenCalledWith({
      from: 'Trackton <onboarding@resend.dev>',
      ...message,
    });
  });

  it('erro devolvido pelo Resend vira EmailDeliveryError, sem a chave na mensagem', async () => {
    send.mockResolvedValueOnce({
      data: null,
      error: { name: 'application_error', message: 'Unable to fetch data.' },
    });
    const service = withEnv({
      RESEND_API_KEY: 're_segredo',
      MAIL_FROM: 'onboarding@resend.dev',
    });
    const error = await service.send(message).catch((e: Error) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as Error).message).toContain('application_error');
    expect((error as Error).message).not.toContain('re_segredo');
  });
});

describe('template de redefinir senha', () => {
  const resetUrl = 'https://app.exemplo.com/redefinir-senha?token=abc_DEF-123';

  it('traz botão, o link em texto, a validade e a versão sem HTML', () => {
    const { subject, html, text } = passwordResetEmail({
      resetUrl,
      validMinutes: 30,
    });
    expect(subject).toContain('Trackton');
    expect(html.split(resetUrl)).toHaveLength(4); // href do botão + href e texto do link alternativo
    expect(html).toContain('30 minutos');
    expect(text).toContain(resetUrl);
    expect(text).toContain('30 minutos');
  });

  it('escapa o que entra no HTML', () => {
    const { html } = passwordResetEmail({
      resetUrl: 'https://x.com/?a=1&b="<script>',
      validMinutes: 30,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&amp;b=&quot;&lt;script&gt;');
  });
});
