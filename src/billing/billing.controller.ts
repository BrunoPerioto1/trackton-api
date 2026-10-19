import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../common/decorators/user.decorator';
import { SubscriptionService } from './subscription.service';
import { SubscribeDTO, SubscribeResponseDTO } from './dto/subscription.dto';
import { validWebhookSignature } from './mercadopago.client';

type WebhookBody = { type?: string; topic?: string; action?: string; data?: { id?: string | number } };

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(private readonly subscriptions: SubscriptionService) {}

  @Post('subscription')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Cria a assinatura do Pro e devolve o link do checkout do Mercado Pago' })
  @ApiResponse({ status: HttpStatus.OK, type: SubscribeResponseDTO })
  subscribe(@User('userId') userId: number, @Body() body: SubscribeDTO) {
    return this.subscriptions.subscribe(userId, body.payerEmail.trim());
  }

  @Post('subscription/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Cancela a cobrança automática; o Pro já pago continua até o fim' })
  async cancel(@User('userId') userId: number) {
    await this.subscriptions.cancel(userId);
    return { success: true };
  }

  /**
   * Webhook do Mercado Pago (assinaturas e mensalidades). Público: quem chama
   * é o Mercado Pago, que assina a notificação. Processa antes de responder —
   * na Vercel a function congela depois da resposta —, e erro vira 500 pro
   * Mercado Pago tentar de novo.
   */
  @Post('mercadopago/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async webhook(
    @Body() body: WebhookBody,
    @Query() query: Record<string, string | undefined>,
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    const dataId = query['data.id'] ?? (body?.data?.id != null ? String(body.data.id) : query.id);
    const type = body?.type ?? query.type ?? body?.topic ?? query.topic;

    const secret = process.env.MP_WEBHOOK_SECRET;
    if (secret) {
      if (!validWebhookSignature({ secret, signature, requestId, dataId })) {
        this.logger.warn(`webhook com assinatura invalida (type=${type})`);
        throw new UnauthorizedException();
      }
    } else {
      // Sem a chave ainda dá pra seguir: nada do corpo é usado além do id, e o
      // recurso é buscado na API com o token do servidor.
      this.logger.warn('MP_WEBHOOK_SECRET nao definido: webhook aceito sem conferir assinatura');
    }

    await this.subscriptions.handleNotification(type, dataId);
    return { received: true };
  }
}
