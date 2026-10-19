import type { DashboardPreferencesDTO } from '../users/dto/dashboard-preferences.dto';
import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { RoleId } from './Roles';

export type UserId = number & { __type: 'UserId' };

export default interface UsersTable {
  dashboardPreferences: ColumnType<
    DashboardPreferencesDTO | null,
    DashboardPreferencesDTO | null | undefined,
    DashboardPreferencesDTO | null
  >;
  id: ColumnType<UserId, UserId | undefined, never>;
  username: ColumnType<string, string, string>;
  email: ColumnType<string, string, string>;
  passwordHash: ColumnType<string, string, string>;
  fullName: ColumnType<string | null, string | null, string | null>;
  isActive: ColumnType<boolean | null, boolean | null, boolean | null>;
  roleId: ColumnType<RoleId, RoleId, RoleId>;
  createdAt: ColumnType<Date, Date | undefined, never>;
  updatedAt: ColumnType<Date, Date | undefined, Date>;
  lastLogin: ColumnType<Date | null, Date | null, Date | null>;
  telegramUserId: ColumnType<number | null, number | null, number | null>; // bigint como number
  stake: ColumnType<number | null, number | null, number | null>; // NUMERIC como number
  minPercentFilter: ColumnType<number | null, number | null, number | null>; // NUMERIC; null = sem filtro
  staleHouseDays: ColumnType<number | null, number | null | undefined, number | null>; // null = padrão do app
  failedLoginAttempts: ColumnType<number, number | undefined, number>;
  lockedUntil: ColumnType<Date | null, Date | null, Date | null>;
  telegramLinkCode: ColumnType<string | null, string | null, string | null>;
  telegramLinkExpiresAt: ColumnType<Date | null, Date | null, Date | null>;
  telegramLinkedAt: ColumnType<Date | null, Date | null, Date | null>;
  telegramUsername: ColumnType<string | null, string | null | undefined, string | null>; // @ sem o arroba; null = sem @ ou nao vinculado
  accessUntil: ColumnType<Date | null, Date | null | undefined, Date | null>; // Pro até; vencido = Grátis; NULL = Pro sem prazo
  tipsGroupRemovedAt: ColumnType<Date | null, Date | null | undefined, Date | null>; // ban do grupo Tips pelo painel; NULL = dentro ou convidado de volta
  paymentClaimedAt: ColumnType<Date | null, Date | null | undefined, Date | null>; // "Ja paguei" do PIX manual; sem uso desde a assinatura do Mercado Pago
  passwordResetCodeHash: ColumnType<string | null, string | null | undefined, string | null>; // bcrypt do codigo mandado pelo bot
  passwordResetExpiresAt: ColumnType<Date | null, Date | null | undefined, Date | null>;
  passwordResetAttempts: ColumnType<number, number | undefined, number>;
  mpPreapprovalId: ColumnType<string | null, string | null | undefined, string | null>; // assinatura mais recente no Mercado Pago
  subscriptionStatus: ColumnType<string | null, string | null | undefined, string | null>; // status dela lá (pending, authorized, paused, cancelled); NULL = nunca assinou
}

export type User = Selectable<UsersTable>; // SELECT
export type NewUser = Insertable<UsersTable>; // INSERT
export type UpdateUser = Updateable<UsersTable>; // UPDATE
