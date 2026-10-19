import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { User } from '../common/decorators/user.decorator';
import { AI_PARSE_LIMIT, RateLimitService } from '../common/rate-limit/rate-limit.service';
import { AiQuotaService } from '../users/ai-quota.service';
import type { JwtPayload } from '../auth/jwt/jwt-payload';
import {
  BetSlipService,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_SLIP,
} from './bet-slip.service';
import { ParsedBetSlipDto, ParseImageBodyDto } from './dto/parse-image.dto';

// Só o que esta rota usa do arquivo enviado — evita depender de @types/multer
// só para tipar um campo.
interface UploadedImage {
  buffer?: Buffer;
  fieldname?: string;
}

// Controller separado, com o mesmo prefixo do BetController: evita que o
// BetModule tenha que importar tips/casas só por causa desta rota.
@ApiTags('Apostas')
@Controller('bets')
export class BetSlipController {
  constructor(
    private readonly betSlipService: BetSlipService,
    private readonly rateLimit: RateLimitService,
    private readonly aiQuota: AiQuotaService,
  ) {}

  @Post('parse-image')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Lê um print de bilhete e devolve os campos da aposta (não salva)',
    description:
      'Aceita mais de uma imagem quando o bilhete não cabe num print só: todas as partes enviadas são lidas como UMA aposta. Lote (várias apostas) é uma chamada por bilhete.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', format: 'binary' },
        images: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'Partes do mesmo bilhete, na ordem.',
        },
        houseHint: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.OK, type: ParsedBetSlipDto })
  // O limite real em produção é o do body da serverless function do Vercel
  // (~4.5 MB), abaixo destes 5 MB — o app comprime antes de enviar, então na
  // prática o payload fica na casa das centenas de KB.
  // AnyFilesInterceptor no lugar do FileInterceptor: o app manda o bilhete
  // inteiro em "image" ou dividido em "images[]", e a rota aceita os dois sem
  // duplicar endpoint.
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_SLIP },
    }),
  )
  async parseImage(
    @UploadedFiles() files: UploadedImage[] | undefined,
    @Body() body: ParseImageBodyDto,
    @User() user: JwtPayload,
  ): Promise<ParsedBetSlipDto> {
    const { userId } = user;
    const pro = !!user.pro;
    const buffers = (files ?? [])
      .filter((f) => f.fieldname === 'image' || f.fieldname === 'images')
      .map((f) => f.buffer)
      .filter((b): b is Buffer => !!b?.length);
    if (!buffers.length)
      throw new BadRequestException('Envie uma imagem no campo "image".');
    // Grátis: 5 por dia, somando o bot. Barra antes da IA, conta depois.
    await this.aiQuota.assertAvailable(userId, pro);
    // Cada leitura é uma chamada paga à OpenAI.
    await this.rateLimit.consume(`ai:user:${userId}`, AI_PARSE_LIMIT);
    const parsed = await this.betSlipService.parseImage({
      userId,
      buffers,
      houseHint: body.houseHint,
    });
    await this.aiQuota.record(userId, pro);
    return parsed;
  }
}
