import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { User } from '../common/decorators/user.decorator';
import { ProGuard } from '../common/guards/pro.guard';
import type { JwtPayload } from '../auth/jwt/jwt-payload';
import { UserId } from '../db_types/Users';
import { BetId } from '../db_types/Bet';
import { SettlementService } from './settlement.service';
import { MARKET_REGISTRY } from './market-registry';
import {
  ConfirmSettlementDto,
  SettlementQueueDto,
  SettlementSuggestionDto,
} from './dto/settlement.dto';

// Conferência pelo placar é do Pro (ProGuard em cada rota). Só o `queue`
// atende o Grátis: é dele o contador "pendentes de jogo encerrado" do menu.
@ApiTags('Liquidação')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('settlement')
export class SettlementController {
  constructor(private readonly settlementService: SettlementService) {}

  @Get('support')
  @ApiOperation({ summary: 'Capacidades, dados exigidos e limitações dos mercados' })
  support() {
    return MARKET_REGISTRY.map(({ parser, evaluator, ...support }) => support);
  }

  @Get('queue')
  @ApiOperation({
    summary: 'Contadores da fila de conferência',
    description:
      'Pendentes, quantas entrariam no próximo lote, quantas propostas ' +
      'aguardam confirmação e quantas o bot não soube resolver. A tela usa ' +
      'isso no load, sem depender da resposta do último compute.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: SettlementQueueDto })
  queue(@User() user: JwtPayload) {
    return this.settlementService.queue(user.userId as UserId, !!user.pro);
  }

  @Get('review')
  @UseGuards(ProGuard)
  @ApiOperation({ summary: 'Apostas indefinidas e motivos para revisão manual' })
  review(@User('userId') userId: number) {
    return this.settlementService.listReview(userId as UserId);
  }

  @Post('compute')
  @UseGuards(ProGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recalcula as sugestões das apostas pendentes já encerradas',
    description:
      'Não altera nenhum resultado: apenas prepara as sugestões que a tela ' +
      'de conferência exibe. Depende do job jobs/sofascore/results.py ter ' +
      'trazido o placar.',
  })
  compute(@User('userId') userId: number) {
    return this.settlementService.computeSuggestions(userId as UserId);
  }

  @Get('suggestions')
  @UseGuards(ProGuard)
  @ApiOperation({ summary: 'Lista as sugestões aguardando confirmação' })
  @ApiResponse({ status: HttpStatus.OK, type: [SettlementSuggestionDto] })
  list(@User('userId') userId: number) {
    return this.settlementService.listSuggestions(userId as UserId);
  }

  @Post('confirm')
  @UseGuards(ProGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Planilha as sugestões aceitas',
    description:
      'Único caminho pelo qual a liquidação automática vira resultado real. ' +
      'Usa o mesmo fluxo de finalização manual, com o mesmo cálculo de lucro.',
  })
  confirm(@Body() body: ConfirmSettlementDto, @User('userId') userId: number) {
    return this.settlementService.confirm(
      body.betIds as BetId[],
      userId as UserId,
    );
  }

  @Post('dismiss')
  @UseGuards(ProGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Descarta sugestões que o usuário não quer aceitar',
    description: 'A aposta segue pendente e a sugestão não volta a aparecer.',
  })
  dismiss(@Body() body: ConfirmSettlementDto, @User('userId') userId: number) {
    return this.settlementService.dismiss(
      body.betIds as BetId[],
      userId as UserId,
    );
  }
}
