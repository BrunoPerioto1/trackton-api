import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { User } from '../common/decorators/user.decorator';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { ChangePasswordDTO, ForgotPasswordDTO, LoginDTO, ResetPasswordDTO } from './dto/login.dto';
import type { JwtPayload } from './jwt/jwt-payload';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Post('login')
  @ApiOperation({ summary: 'Autentica um usuário e retorna o token JWT' })
  @ApiResponse({ status: 201, description: 'Login realizado com sucesso.' })
  @ApiUnauthorizedResponse({ description: 'Credenciais inválidas (mesma resposta exista ou não o e-mail).' })
  @ApiResponse({ status: 429, description: 'Conta travada por tentativas seguidas; o corpo traz `lockedUntil`.' })
  async login(@Body() loginDto: LoginDTO) {
    return this.authService.login(loginDto);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('jwt')
  @Post('change-password')
  @ApiOperation({
    summary: 'Troca a senha do usuário logado',
    description:
      'Derruba todas as sessões abertas. Devolve `access_token` novo, com a mesma duração da sessão atual, ' +
      'pra quem trocou continuar logado.',
  })
  @ApiUnauthorizedResponse({ description: 'Senha atual incorreta.' })
  async changePassword(@User() session: JwtPayload, @Body() dto: ChangePasswordDTO) {
    return this.authService.changePassword(session.userId, dto, session);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manda o link pra redefinir a senha (e-mail e, se vinculado, bot do Telegram)',
    description:
      'Responde igual exista ou não a conta: a tela não pode revelar quais e-mails estão cadastrados. ' +
      'O link vale 30 minutos e só funciona uma vez.',
  })
  @ApiResponse({ status: 503, description: 'Envio de e-mail não configurado no servidor (RESEND_API_KEY / MAIL_FROM).' })
  async forgotPassword(@Body() dto: ForgotPasswordDTO) {
    await this.passwordReset.request(dto.email);
    return { sent: true };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Troca a senha com o token do link (derruba as sessões abertas)' })
  @ApiResponse({ status: 400, description: 'Token inválido, vencido ou já usado.' })
  async resetPassword(@Body() dto: ResetPasswordDTO) {
    await this.passwordReset.reset(dto.token, dto.newPassword);
    return { success: true };
  }
}
