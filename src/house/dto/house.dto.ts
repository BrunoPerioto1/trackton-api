import { IsNumber, IsString, IsOptional, IsBoolean, IsArray } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class FindAllHousesDTO  {

  @ApiProperty({ description: "ID da casa de apostas", example: 1 })
  @IsNumber()
  id!: number;

  @ApiProperty({ description: "Nome da casa de apostas", example: "Bet365" })
  @IsString()
  name!: string;

  @ApiProperty({ description: "Status ativo da casa de apostas", example: true, required: false, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({ description: "Apelidos/variações de nome reconhecidos pelo parser de apostas", example: ["Superbet Brasil"], required: false })
  @IsOptional()
  @IsArray()
  aliases?: string[];

  @ApiProperty({
    description: "Versão do avatar (ms do logo_updated_at): vai como ?v= em /house/:id/logo. null = sem logo, usa as iniciais",
    example: 1791331200000,
    nullable: true,
  })
  logoVersion!: number | null;

  @ApiProperty({ enum: ['federal', 'offshore'], required: false })
  regulation?: 'federal' | 'offshore';

  // Verificador de acesso: null = não informado.
  @ApiProperty({ type: Boolean, nullable: true, required: false, description: 'Só abre com VPN' })
  requiresVpn?: boolean | null;

  @ApiProperty({ type: Boolean, nullable: true, required: false, description: 'Aceita depósito por PIX' })
  acceptsPix?: boolean | null;

  @ApiProperty({ type: Boolean, nullable: true, required: false, description: 'Aceita depósito em cripto' })
  acceptsCrypto?: boolean | null;
}

