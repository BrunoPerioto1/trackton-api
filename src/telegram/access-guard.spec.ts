import { BotCommandsService } from './bot-commands.service';
import type { BotContext } from './utils/bot-context';

// Contexto parcial: só o que o porteiro lê.
const asCtx = (ctx: object) => ctx as unknown as BotContext;

const DAY = 86_400_000;
const FREE = { isActive: true, accessUntil: new Date(Date.now() - DAY) };
const PRO = { isActive: true, accessUntil: new Date(Date.now() + DAY) };

function setup(user: object | null) {
  const usersService = {
    findByTelegramUserId: jest.fn().mockResolvedValue(user),
  };
  const service = new BotCommandsService(usersService as any, {} as any, {} as any);
  return { service, usersService };
}

function privateMessage(text: string) {
  return {
    chat: { type: 'private' },
    from: { id: 7 },
    message: { text },
    reply: jest.fn(),
  };
}

function click(data: string) {
  return {
    chat: { type: 'private' },
    from: { id: 7 },
    callbackQuery: { data },
    answerCbQuery: jest.fn().mockResolvedValue(true),
    reply: jest.fn(),
  };
}

describe('blockIfNoAccess', () => {
  it('Grátis registrando aposta (texto, print, áudio): passa', async () => {
    const { service } = setup(FREE);
    await expect(
      service.blockIfNoAccess(asCtx(privateMessage('Flamengo vence @1.80 50'))),
    ).resolves.toBe(false);
  });

  it('Grátis clicando em Planilhar de tip: só pop-up do Pro, sem responder no chat', async () => {
    for (const data of ['planilhar:1', 'lista_planilhar:1:0']) {
      const { service } = setup(FREE);
      const ctx = click(data);

      await expect(service.blockIfNoAccess(asCtx(ctx))).resolves.toBe(true);
      expect(ctx.answerCbQuery).toHaveBeenCalledWith(
        expect.stringContaining('plano Pro'),
        { show_alert: true },
      );
      expect(ctx.reply).not.toHaveBeenCalled();
    }
  });

  it('Grátis planilhando o próprio print ou áudio: passa', async () => {
    const { service } = setup(FREE);
    await expect(
      service.blockIfNoAccess(asCtx(click('planilhar_ts:1760000000:image'))),
    ).resolves.toBe(false);
  });

  it('Pro clicando em Planilhar de tip: passa', async () => {
    const { service } = setup(PRO);
    await expect(service.blockIfNoAccess(asCtx(click('planilhar:1')))).resolves.toBe(false);
  });

  it('desativado: barra, no chat e no botão', async () => {
    const { service } = setup({ isActive: false, accessUntil: null });
    const ctx = privateMessage('/pendentes');
    await expect(service.blockIfNoAccess(asCtx(ctx))).resolves.toBe(true);
    const [text] = ctx.reply.mock.calls[0] as [string];
    expect(text).toContain('desativada');

    const button = click('planilhar_ts:1760000000:image');
    const { service: again } = setup({ isActive: false, accessUntil: null });
    await expect(again.blockIfNoAccess(asCtx(button))).resolves.toBe(true);
    expect(button.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('desativada'), {
      show_alert: true,
    });
  });

  it('sem prazo ou sem vínculo: passa', async () => {
    for (const user of [{ isActive: null, accessUntil: null }, null]) {
      const { service } = setup(user);
      await expect(service.blockIfNoAccess(asCtx(click('planilhar:1')))).resolves.toBe(false);
    }
  });

  it('/start e /vincular passam sem consultar o banco', async () => {
    const { service, usersService } = setup({ isActive: false, accessUntil: null });
    await expect(
      service.blockIfNoAccess(asCtx(privateMessage('/start'))),
    ).resolves.toBe(false);
    await expect(
      service.blockIfNoAccess(asCtx(privateMessage('/vincular 123456'))),
    ).resolves.toBe(false);
    expect(usersService.findByTelegramUserId).not.toHaveBeenCalled();
  });

  it('grupo de Tips e banco fora do ar: passa', async () => {
    const { service } = setup(null);
    await expect(
      service.blockIfNoAccess(
        asCtx({ chat: { type: 'supergroup' }, from: { id: 7, is_bot: true } }),
      ),
    ).resolves.toBe(false);

    const usersService = {
      findByTelegramUserId: jest.fn().mockRejectedValue(new Error('db')),
    };
    const failing = new BotCommandsService(usersService as any, {} as any, {} as any);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(failing.blockIfNoAccess(asCtx(privateMessage('oi')))).resolves.toBe(
      false,
    );
  });
});
