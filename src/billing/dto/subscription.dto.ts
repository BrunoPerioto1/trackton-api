import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class SubscribeDTO {
  // O checkout do Mercado Pago pede login com este e-mail: é o da conta de lá,
  // que pode não ser o do cadastro aqui. A tela já sugere o do cadastro.
  @ApiProperty({ description: 'E-mail da conta do Mercado Pago que vai pagar' })
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  @MaxLength(100)
  payerEmail!: string;
}

export class SubscribeResponseDTO {
  @ApiProperty({ description: 'Link do checkout do Mercado Pago (cartão, Pix ou boleto)' })
  initPoint!: string;
}
