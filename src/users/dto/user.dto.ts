import { DashboardPreferencesDTO } from './dashboard-preferences.dto';
import { ApiProperty } from '@nestjs/swagger';

export class UserDto {
  @ApiProperty({ nullable: true, type: DashboardPreferencesDTO })
  dashboardPreferences!: DashboardPreferencesDTO | null;

  @ApiProperty()
  id!: number;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  passwordHash!: string;

  @ApiProperty({ nullable: true })
  fullName!: string | null;

  @ApiProperty({ nullable: true })
  isActive!: boolean | null;

  @ApiProperty({ type: String, nullable: true, description: 'Vencimento do acesso; null = sem prazo' })
  accessUntil!: Date | null;

  @ApiProperty()
  roleId!: number;

  @ApiProperty({ type: String, nullable: true })
  createdAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  updatedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  lastLogin!: Date | null;

  @ApiProperty({ type: Number, nullable: true })
  stake!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  minPercentFilter!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  staleHouseDays!: number | null;

  @ApiProperty()
  hasVpn!: boolean;

  @ApiProperty()
  hasCrypto!: boolean;

  @ApiProperty()
  failedLoginAttempts!: number;

  @ApiProperty({ type: String, nullable: true })
  lockedUntil!: Date | null;
}
