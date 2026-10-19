import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class SubscribeDTO {
  // E-mail dos avisos de cobrança. Quem entra com conta do Mercado Pago no
  // checkout usa o dela, que pode não ser o do cadastro aqui; dá pra pagar sem
  // conta também. A tela já sugere o do cadastro.
  @ApiProperty({ description: 'E-mail de quem paga (o da conta do Mercado Pago, se tiver)' })
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  @MaxLength(100)
  payerEmail!: string;
}

export class SubscribeResponseDTO {
  @ApiProperty({ description: 'Link do checkout do Mercado Pago (cartão, Pix ou boleto)' })
  initPoint!: string;
}
