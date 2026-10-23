import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { EmailMessage } from '../email/email.service';
import { PasswordResetService, hashResetToken } from './password-reset.service';

process.env.FRONT_URL = 'https://app.exemplo.com';

const MINUTE = 60_000;

function setup({
  configured = true,
  user = {} as Record<string, unknown> | null,
} = {}) {
  const row =
    user === null
      ? undefined
      : {
          id: 7,
          email: 'f@x.com',
          isActive: true,
          telegramUserId: null as number | null,
          passwordResetCodeHash: null as string | null,
          passwordResetExpiresAt: null as Date | null,
          ...user,
        };
  const repo = {
    findByEmail: jest.fn(async () => row),
    findByPasswordResetHash: jest.fn(async (hash: string) =>
      row?.passwordResetCodeHash === hash ? row : undefined,
    ),
    updateUser: jest.fn<Promise<typeof row>, [number, Record<string, unknown>]>(
      async () => row,
    ),
    consumePasswordReset: jest.fn<Promise<boolean>, [number, string, string]>(
      async () => true,
    ),
  };
  const email = {
    isConfigured: jest.fn(() => configured),
    send: jest.fn<Promise<void>, [EmailMessage]>(async () => undefined),
  };
  const bot = { telegram: { sendMessage: jest.fn(async () => undefined) } };
  const service = new PasswordResetService(
    repo as any,
    email as any,
    bot as any,
  );
  return { service, repo, email, bot, row };
}

// O link que saiu no e-mail: o token é o que vem depois de ?token=.
function sentLink(email: { send: jest.Mock }) {
  const { text } = email.send.mock.calls[0][0] as { text: string };
  const link = text.match(
    /https:\/\/app\.exemplo\.com\/redefinir-senha\?token=([A-Za-z0-9_-]+)/,
  );
  if (!link) throw new Error('o e-mail não trouxe o link');
  return { url: link[0], token: link[1] };
}

describe('esqueci a senha: pedido', () => {
  it('sem e-mail configurado responde 503 antes de olhar a conta', async () => {
    const { service, repo } = setup({ configured: false });
    await expect(service.request('f@x.com')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(repo.findByEmail).not.toHaveBeenCalled();
  });

  it('e-mail que não existe responde igual e não manda nada', async () => {
    const { service, repo, email, bot } = setup({ user: null });
    await expect(service.request('ninguem@x.com')).resolves.toBeUndefined();
    expect(repo.updateUser).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('conta desativada não recebe link', async () => {
    const { service, email } = setup({ user: { isActive: false } });
    await service.request('f@x.com');
    expect(email.send).not.toHaveBeenCalled();
  });

  it('guarda só o hash do token, com 30 minutos de validade, e manda o link por e-mail', async () => {
    const { service, repo, email, bot } = setup();
    const before = Date.now();
    await service.request(' f@x.com ');

    expect(repo.findByEmail).toHaveBeenCalledWith('f@x.com');
    const { token, url } = sentLink(email);
    expect(token).toHaveLength(43);
    const saved = repo.updateUser.mock.calls[0][1] as {
      passwordResetCodeHash: string;
      passwordResetExpiresAt: Date;
    };
    expect(saved.passwordResetCodeHash).toBe(hashResetToken(token));
    expect(saved.passwordResetCodeHash).not.toContain(token);
    expect(saved.passwordResetExpiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 30 * MINUTE,
    );
    expect(email.send.mock.calls[0][0]).toMatchObject({
      to: 'f@x.com',
      subject: expect.any(String),
    });
    expect((email.send.mock.calls[0][0] as { html: string }).html).toContain(
      url,
    );
    // Sem Telegram vinculado, só o e-mail.
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('quem tem Telegram recebe o mesmo link no bot', async () => {
    const { service, email, bot } = setup({ user: { telegramUserId: 123 } });
    await service.request('f@x.com');
    const { url } = sentLink(email);
    const [chatId, , extra] = bot.telegram.sendMessage.mock
      .calls[0] as unknown as [
      number,
      string,
      { reply_markup: { inline_keyboard: { url: string }[][] } },
    ];
    expect(chatId).toBe(123);
    expect(extra.reply_markup.inline_keyboard[0][0].url).toBe(url);
  });

  it('dois tokens seguidos nunca se repetem', async () => {
    const a = setup();
    const b = setup();
    await a.service.request('f@x.com');
    await b.service.request('f@x.com');
    expect(sentLink(a.email).token).not.toBe(sentLink(b.email).token);
  });

  it('pedido repetido em menos de um minuto não gera outro link', async () => {
    const { service, repo, email } = setup({
      user: {
        passwordResetCodeHash: 'x',
        passwordResetExpiresAt: new Date(Date.now() + 30 * MINUTE - 20_000),
      },
    });
    await service.request('f@x.com');
    expect(repo.updateUser).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('Resend fora do ar não vira erro na resposta (diria que a conta existe)', async () => {
    const { service, email } = setup();
    email.send.mockRejectedValueOnce(
      new Error('Resend recusou o envio (application_error): fora do ar'),
    );
    await expect(service.request('f@x.com')).resolves.toBeUndefined();
  });
});

describe('esqueci a senha: troca', () => {
  const token = 'A'.repeat(43);
  const valid = {
    passwordResetCodeHash: hashResetToken(token),
    passwordResetExpiresAt: new Date(Date.now() + 10 * MINUTE),
  };

  it('token válido troca a senha e queima o token no mesmo UPDATE', async () => {
    const { service, repo } = setup({ user: valid });
    await service.reset(token, 'senha-nova');
    const [id, hash, passwordHash] = repo.consumePasswordReset.mock
      .calls[0] as unknown as [number, string, string];
    expect(id).toBe(7);
    expect(hash).toBe(hashResetToken(token));
    expect(await bcrypt.compare('senha-nova', passwordHash)).toBe(true);
  });

  it('token que não existe dá 400', async () => {
    const { service, repo } = setup({ user: valid });
    await expect(
      service.reset('B'.repeat(43), 'senha-nova'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.consumePasswordReset).not.toHaveBeenCalled();
  });

  it('token vencido dá 400 e não troca nada', async () => {
    const { service, repo } = setup({
      user: { ...valid, passwordResetExpiresAt: new Date(Date.now() - 1000) },
    });
    await expect(service.reset(token, 'senha-nova')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.consumePasswordReset).not.toHaveBeenCalled();
  });

  it('token já usado (o UPDATE não pegou a linha) dá 400', async () => {
    const { service, repo } = setup({ user: valid });
    repo.consumePasswordReset.mockResolvedValueOnce(false);
    await expect(service.reset(token, 'senha-nova')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('conta desativada não troca a senha', async () => {
    const { service, repo } = setup({ user: { ...valid, isActive: false } });
    await expect(service.reset(token, 'senha-nova')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.consumePasswordReset).not.toHaveBeenCalled();
  });
});
