import { createHmac } from 'crypto';
import { mercadoPago, validWebhookSignature } from './mercadopago.client';
import {
  SubscriptionService,
  paidProUntil,
  subscriptionReference,
  userIdFromReference,
} from './subscription.service';

const DAY = 86_400_000;

describe('assinatura do webhook', () => {
  const secret = 'segredo-teste';
  const sign = (manifest: string) => createHmac('sha256', secret).update(manifest).digest('hex');

  it('aceita a assinatura certa, com o data.id em minúsculas', () => {
    const v1 = sign('id:abc123;request-id:req-1;ts:1700000000;');
    expect(
      validWebhookSignature({ secret, signature: `ts=1700000000,v1=${v1}`, requestId: 'req-1', dataId: 'ABC123' }),
    ).toBe(true);
  });

  it('recusa assinatura errada, de outro id ou faltando partes', () => {
    const v1 = sign('id:abc123;request-id:req-1;ts:1700000000;');
    expect(validWebhookSignature({ secret, signature: `ts=1700000000,v1=${v1}`, requestId: 'req-1', dataId: 'outro' })).toBe(false);
    expect(validWebhookSignature({ secret, signature: 'ts=1700000000,v1=deadbeef', requestId: 'req-1', dataId: 'abc123' })).toBe(false);
    expect(validWebhookSignature({ secret, signature: undefined, requestId: 'req-1', dataId: 'abc123' })).toBe(false);
    expect(validWebhookSignature({ secret, signature: `ts=1700000000,v1=${v1}`, requestId: undefined, dataId: 'abc123' })).toBe(false);
  });
});

describe('referência e prazo', () => {
  it('o dono vai e volta pelo external_reference', () => {
    expect(userIdFromReference(subscriptionReference(42))).toBe(42);
    expect(userIdFromReference('outra-coisa-42')).toBeNull();
    expect(userIdFromReference(null)).toBeNull();
  });

  it('um mês depois mais 3 dias de folga; 31/01 vira fim de fevereiro', () => {
    expect(paidProUntil(new Date('2026-10-19T12:00:00Z')).toISOString()).toBe('2026-11-22T12:00:00.000Z');
    expect(paidProUntil(new Date('2027-01-31T12:00:00Z')).toISOString()).toBe('2027-03-03T12:00:00.000Z');
  });
});

describe('SubscriptionService.handleNotification', () => {
  const user = {
    id: 7,
    username: 'bruno',
    email: 'b@x.com',
    fullName: 'Bruno',
    telegramUserId: 99,
    accessUntil: new Date(Date.now() - DAY),
    mpPreapprovalId: 'pre-1',
    subscriptionStatus: 'pending',
  };

  function setup(recordPayment = true) {
    const usersRepository = {
      findById: jest.fn().mockResolvedValue(user),
      findAdminsWithTelegram: jest.fn().mockResolvedValue([{ telegramUserId: 1 }]),
    };
    const billingRepository = {
      findUserByPreapprovalId: jest.fn().mockResolvedValue(user),
      recordPayment: jest.fn().mockResolvedValue(recordPayment),
      setSubscriptionStatus: jest.fn().mockResolvedValue(undefined),
      setSubscription: jest.fn(),
    };
    const bot = { telegram: { sendMessage: jest.fn().mockResolvedValue({}) } };
    const service = new SubscriptionService(usersRepository as any, billingRepository as any, bot as any);
    return { service, usersRepository, billingRepository, bot };
  }

  afterEach(() => jest.restoreAllMocks());

  it('mensalidade aprovada: grava, liga a assinatura e avisa usuário e admin', async () => {
    jest.spyOn(mercadoPago, 'getAuthorizedPayment').mockResolvedValue({
      id: 'inv-1',
      preapproval_id: 'pre-1',
      status: 'processed',
      transaction_amount: 40,
      payment: { id: 555, status: 'approved' },
    });
    const { service, billingRepository, bot } = setup();

    await service.handleNotification('subscription_authorized_payment', 'inv-1');

    expect(billingRepository.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, mpPaymentId: '555', mpPreapprovalId: 'pre-1', amount: 40 }),
    );
    const { proUntil } = billingRepository.recordPayment.mock.calls[0][0] as { proUntil: Date };
    expect(proUntil.getTime()).toBeGreaterThan(Date.now() + 30 * DAY);
    expect(billingRepository.setSubscriptionStatus).toHaveBeenCalledWith(7, 'pre-1', 'authorized');
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('notificação repetida do mesmo pagamento: não avisa de novo', async () => {
    jest.spyOn(mercadoPago, 'getAuthorizedPayment').mockResolvedValue({
      id: 'inv-1',
      preapproval_id: 'pre-1',
      status: 'processed',
      transaction_amount: 40,
      payment: { id: 555, status: 'approved' },
    });
    const { service, billingRepository, bot } = setup(false);

    await service.handleNotification('subscription_authorized_payment', 'inv-1');

    expect(billingRepository.setSubscriptionStatus).not.toHaveBeenCalled();
    expect(bot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('mensalidade recusada ou pendente (Pix/boleto ainda não pago): não libera nada', async () => {
    for (const payment of [{ id: 1, status: 'rejected' }, { id: 2, status: 'pending' }, null]) {
      jest.spyOn(mercadoPago, 'getAuthorizedPayment').mockResolvedValue({
        id: 'inv-2',
        preapproval_id: 'pre-1',
        status: 'recycling',
        transaction_amount: 40,
        payment,
      });
      const { service, billingRepository } = setup();
      await service.handleNotification('subscription_authorized_payment', 'inv-2');
      expect(billingRepository.recordPayment).not.toHaveBeenCalled();
    }
  });

  it('status da assinatura: grava o que a API do Mercado Pago diz', async () => {
    jest.spyOn(mercadoPago, 'getPreapproval').mockResolvedValue({
      id: 'pre-1',
      status: 'cancelled',
      external_reference: subscriptionReference(7),
    });
    const { service, billingRepository } = setup();

    await service.handleNotification('subscription_preapproval', 'pre-1');

    expect(billingRepository.setSubscriptionStatus).toHaveBeenCalledWith(7, 'pre-1', 'cancelled');
  });

  it('tipo que não é de assinatura: ignora sem chamar a API', async () => {
    const spy = jest.spyOn(mercadoPago, 'getPreapproval');
    const { service } = setup();
    await service.handleNotification('payment', '123');
    expect(spy).not.toHaveBeenCalled();
  });
});
