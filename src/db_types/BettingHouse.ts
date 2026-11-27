import type { ColumnType, Insertable, Selectable, Updateable } from "kysely";

export type BettingHouseId = number & { __type: 'BettingHouseId' };

export const HOUSE_REGULATIONS = ['federal', 'offshore'] as const;
export type HouseRegulation = (typeof HOUSE_REGULATIONS)[number];

export default interface BettingHousesTable {
  id: ColumnType<BettingHouseId, BettingHouseId | undefined, never>;
  name: ColumnType<string, string, string>;
  isActive: ColumnType<boolean, boolean | undefined, boolean>;
  createdAt: ColumnType<Date, Date | undefined, never>;
  updatedAt: ColumnType<Date, Date | undefined, Date>;
  aliases: ColumnType<string[], string[] | undefined, string[]>;
  websiteUrl: ColumnType<string | null, string | null | undefined, string | null>; // federal: só .bet.br
  // Verificador de acesso: null = não informado.
  requiresVpn: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  acceptsPix: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  acceptsCrypto: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  regulation: ColumnType<HouseRegulation, HouseRegulation | undefined, HouseRegulation>;
  logo: ColumnType<Buffer | null, Buffer | null | undefined, Buffer | null>;
  logoMime: ColumnType<string | null, string | null | undefined, string | null>;
  logoUpdatedAt: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export type BettingHouse = Selectable<BettingHousesTable>;   // SELECT
export type NewBettingHouse = Insertable<BettingHousesTable>; // INSERT
export type UpdateBettingHouse = Updateable<BettingHousesTable>; // UPDATE
