import type { ColumnType } from 'kysely';
import type { UserId } from './Users';

// Mensalidade do Pro aprovada no Mercado Pago (ver
// migrations/20261019_mercadopago_subscription.sql).
export default interface SubscriptionPaymentsTable {
  id: ColumnType<number, number | undefined, never>;
  userId: ColumnType<UserId | null, UserId | null, UserId | null>; // NULL = conta excluída
  mpPaymentId: ColumnType<string, string, never>;
  mpPreapprovalId: ColumnType<string, string, never>;
  amount: ColumnType<number, number, never>; // NUMERIC como number
  proUntil: ColumnType<Date, Date, never>; // até quando esta mensalidade deixou o Pro
  createdAt: ColumnType<Date, Date | undefined, never>;
}
