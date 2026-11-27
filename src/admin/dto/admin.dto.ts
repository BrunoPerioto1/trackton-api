import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { HOUSE_REGULATIONS, type HouseRegulation } from '../../db_types/BettingHouse';

// Os dois papéis em uso: 1 admin, 3 usuário. O 2 (moderator) continua na tabela
// `roles` mas ninguém nunca esteve nele e nenhuma regra do sistema o consulta —
// oferecer na tela era convidar a criar um papel sem significado.
//
// IsIn em vez de IsInt: roleId 7 não é erro de digitação, é usuário com papel
// órfão que ninguém consegue arrumar pela tela depois.
export const ROLE_IDS = [1, 3] as const;

export class UpdateAdminUserDTO {
  @ApiProperty({
    required: false,
    enum: ROLE_IDS,
    description: '1 admin, 3 usuário',
  })
  @IsOptional()
  @IsIn(ROLE_IDS as unknown as number[])
  roleId?: number;

  @ApiProperty({
    required: false,
    description: 'Zera o bloqueio por tentativas de login',
  })
  @IsOptional()
  @IsBoolean()
  unlock?: boolean;

  @ApiProperty({
    required: false,
    description: 'Desvincula a conta do Telegram',
  })
  @IsOptional()
  @IsBoolean()
  unlinkTelegram?: boolean;

  @ApiProperty({
    required: false,
    description: 'false desativa a conta (sem login, sem API, sem tips); true reativa',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    required: false,
    description: 'Soma dias ao acesso (a partir de hoje se já venceu)',
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(366)
  extendDays?: number;

  // null tira o prazo (volta a "sem prazo"); ausente não mexe.
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'Vencimento exato em ISO 8601 com fuso; null = sem prazo',
    example: '2026-10-24T23:30:00-03:00',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  accessUntil?: string | null;

  @ApiProperty({
    required: false,
    enum: ['remove', 'invite'],
    description:
      'remove: tira do grupo Tips quem está sem acesso (ban). invite: manda de novo o convite a quem está em dia e ficou de fora',
  })
  @IsOptional()
  @IsIn(['remove', 'invite'])
  tipsGroup?: 'remove' | 'invite';
}

export class CreateAdminHouseDTO {
  @ApiProperty({ example: 'Bet365' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({
    required: false,
    type: [String],
    description: 'Variações de nome que o parser de tips deve reconhecer',
    example: ['Bet 365', 'bet365 brasil'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Site da casa. Federal: só domínio .bet.br; offshore: qualquer domínio. Vazio ou null apaga o link.',
    example: 'https://betano.bet.br',
  })
  @IsOptional()
  @IsString()
  websiteUrl?: string | null;

  @ApiProperty({
    required: false,
    enum: HOUSE_REGULATIONS,
    description: 'federal (.bet.br/judicial) ou offshore (casa estrangeira). Padrão federal.',
  })
  @IsOptional()
  @IsIn(HOUSE_REGULATIONS as unknown as string[])
  regulation?: HouseRegulation;

  // Verificador de acesso. null = não informado (a tip sai sem aviso).
  @ApiProperty({ required: false, nullable: true, description: 'Só abre com VPN' })
  @IsOptional()
  @IsBoolean()
  requiresVpn?: boolean | null;

  @ApiProperty({ required: false, nullable: true, description: 'Aceita depósito por PIX' })
  @IsOptional()
  @IsBoolean()
  acceptsPix?: boolean | null;

  @ApiProperty({ required: false, nullable: true, description: 'Aceita depósito em cripto' })
  @IsOptional()
  @IsBoolean()
  acceptsCrypto?: boolean | null;
}

export class UpdateAdminHouseDTO extends PartialType(CreateAdminHouseDTO) {
  @ApiProperty({
    required: false,
    description: 'Casa inativa some das listas de seleção',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ---- Scanner do SofaScore (/admin/scanner, docs/scanner.md)

export class UpdateScannerFlagsDTO {
  @ApiProperty({
    required: false,
    description: 'Coletor busca os próximos jogos (é o que casa aposta com jogo)',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    required: false,
    description: 'Depois do jogo: escanteios, chutes, cartões, faltas (1 GET por jogo, só futebol)',
  })
  @IsOptional()
  @IsBoolean()
  statistics?: boolean;

  @ApiProperty({
    required: false,
    description: 'Depois do jogo: ordem dos gols, pênaltis, vermelhos (1 GET por jogo, só futebol)',
  })
  @IsOptional()
  @IsBoolean()
  incidents?: boolean;

  @ApiProperty({
    required: false,
    description: 'Depois do jogo: estatística por jogador (1 GET por jogo, só futebol)',
  })
  @IsOptional()
  @IsBoolean()
  lineups?: boolean;
}

export class CreateScannerTournamentDTO {
  @ApiProperty({ example: 17, description: 'Id do torneio no SofaScore: o número no fim da URL, antes do #' })
  @IsInt()
  @Min(1)
  id!: number;

  @ApiProperty({ example: 'Premier League' })
  // Apara antes de validar: "   " passava no MinLength e gravava nome vazio.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 1, description: 'Agrupa na tela; o esporte do jogo vem do próprio SofaScore' })
  @IsInt()
  sportId!: number;
}
