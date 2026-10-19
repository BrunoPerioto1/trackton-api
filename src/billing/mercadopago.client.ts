import { createHmac, timingSafeEqual } from 'crypto';

// Só o pedaço da API de Assinaturas que o Pro usa, por fetch: o SDK oficial
// traria dependência pra quatro chamadas. Todas do servidor, com o
// MP_ACCESS_TOKEN; nada disso vai pro navegador.
const API = 'https://api.mercadopago.com';

export type PreapprovalStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';

export interface Preapproval {
  id: string;
  status: PreapprovalStatus;
  external_reference?: string | null;
  init_point?: string;
  next_payment_date?: string | null;
}

// "Fatura" da assinatura: a mensalidade. O pagamento de verdade vem dentro.
export interface AuthorizedPayment {
  id: number | string;
  preapproval_id: string;
  status: string; // scheduled, processed, recycling, cancelled
  transaction_amount: number;
  payment?: { id: number | string; status: string } | null;
}

export class MercadoPagoError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Mercado Pago respondeu ${status} em ${path}`);
  }
}

export function mercadoPagoConfigured(): boolean {
  return !!process.env.MP_ACCESS_TOKEN;
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw new Error('MP_ACCESS_TOKEN não definido');
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  // O corpo de erro do Mercado Pago não sai daqui: pode trazer dado do pagador.
  if (!response.ok) throw new MercadoPagoError(response.status, path.split('?')[0]);
  return (await response.json()) as T;
}

export const mercadoPago = {
  createPreapproval: (body: {
    reason: string;
    external_reference: string;
    payer_email: string;
    back_url: string;
    status: 'pending';
    auto_recurring: {
      frequency: number;
      frequency_type: 'months';
      transaction_amount: number;
      currency_id: 'BRL';
      start_date?: string;
    };
  }) => call<Preapproval>('POST', '/preapproval', body),

  getPreapproval: (id: string) => call<Preapproval>('GET', `/preapproval/${encodeURIComponent(id)}`),

  cancelPreapproval: (id: string) =>
    call<Preapproval>('PUT', `/preapproval/${encodeURIComponent(id)}`, { status: 'cancelled' }),

  getAuthorizedPayment: (id: string) =>
    call<AuthorizedPayment>('GET', `/authorized_payments/${encodeURIComponent(id)}`),
};

/**
 * Assinatura do webhook (cabeçalho x-signature "ts=...,v1=..."): HMAC-SHA256
 * do manifesto `id:{data.id};request-id:{x-request-id};ts:{ts};` com a chave
 * secreta do painel de Webhooks. O data.id vem da query e, se tiver letra,
 * entra em minúsculas.
 */
export function validWebhookSignature(params: {
  secret: string;
  signature: string | undefined;
  requestId: string | undefined;
  dataId: string | undefined;
}): boolean {
  const parts = Object.fromEntries(
    (params.signature ?? '').split(',').map((part) => {
      const [key, ...value] = part.split('=');
      return [key?.trim(), value.join('=').trim()];
    }),
  );
  const { ts, v1 } = parts as { ts?: string; v1?: string };
  if (!ts || !v1 || !params.dataId || !params.requestId) return false;
  const manifest = `id:${params.dataId.toLowerCase()};request-id:${params.requestId};ts:${ts};`;
  const expected = createHmac('sha256', params.secret).update(manifest).digest('hex');
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
