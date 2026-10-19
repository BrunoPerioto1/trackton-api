import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersRepository } from '../infra/repository/users.repository';
import { TipsGroupService } from '../telegram/tips-group.service';
import { UserDto } from './dto/user.dto';
import { extendAccess, hasAccess } from './access';
import { isPro, planSummary } from './plan';
import { AiQuotaService } from './ai-quota.service';
import { SubscriptionService } from '../billing/subscription.service';
import {
  CreateUserRequestDTO,
  MAX_PERCENT_FILTER,
  MIN_PERCENT_FILTER,
  UpdateUserRequestDTO,
} from './dto/request.dto';
import { CreateUserResponseDTO } from './dto/response.dto';
import type { UserId, UpdateUser } from '../db_types/Users';
import type { RoleId } from '../db_types/Roles';

// Papel de quem se cadastra. Vem fixo do servidor: enquanto o roleId saía do
// corpo da requisição, qualquer um criava (ou promovia) a própria conta como
// admin — por isso os 12 usuários existentes estavam todos em role 1.
const DEFAULT_ROLE_ID = 3 as RoleId; // roles.name = 'user'

// O que nunca sai da API: hash da senha e o do código de "Esqueci a senha".
// Antes só o passwordHash era tirado, e cada coluna nova de segredo teria que
// lembrar de entrar aqui.
function publicUser<T extends { passwordHash: string }>(row: T) {
  const {
    passwordHash: _passwordHash,
    passwordResetCodeHash: _resetHash,
    passwordResetExpiresAt: _resetExpires,
    passwordResetAttempts: _resetAttempts,
    ...safe
  } = row as T & { passwordResetCodeHash?: unknown; passwordResetExpiresAt?: unknown; passwordResetAttempts?: unknown };
  return safe;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    // Porta do grupo Tips: desvincular, trocar de Telegram e excluir a conta
    // tiram a pessoa de lá. Opcional só pros testes que não passam por isso.
    private readonly tipsGroup?: TipsGroupService,
    // Leituras por IA do dia, pro contador do Grátis no /users/me.
    private readonly aiQuota?: AiQuotaService,
    // Excluir a conta cancela a assinatura do Mercado Pago antes.
    private readonly subscriptions?: SubscriptionService,
  ) {}

  async findByEmail(email: string): Promise<UserDto | null> {
    const user = await this.usersRepository.findByEmail(email);
    return user ?? null;
  }

  // Contagem de tentativas de login. `lockedUntil` null limpa um bloqueio
  // vencido; com data, tranca a conta até lá.
  async registerFailedLogin(
    userId: number,
    attempts: number,
    lockedUntil: Date | null,
  ) {
    await this.usersRepository.updateUser(userId as UserId, {
      failedLoginAttempts: attempts,
      lockedUntil,
    });
  }

  async registerSuccessfulLogin(userId: number) {
    await this.usersRepository.updateUser(userId as UserId, {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLogin: new Date(),
    });
  }

  // Linha crua, com passwordHash — usada por quem precisa conferir a senha
  // (troca de senha). Telas continuam usando getMe, que já vem sem o hash.
  async findById(userId: number): Promise<UserDto | null> {
    const user = await this.usersRepository.findById(userId as UserId);
    return user ?? null;
  }

  async deleteAccount(userId: number, password: string): Promise<void> {
    const user = await this.usersRepository.findById(userId as UserId);
    if (!user) throw new BadRequestException('Usuário não encontrado.');
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Senha incorreta');
    }
    // Antes de apagar: se o Mercado Pago não cancelar, a conta fica, senão o
    // cartão seguiria sendo cobrado sem conta pra usar.
    await this.subscriptions?.cancelBeforeDelete(user);
    await this.usersRepository.deleteUserAndData(userId as UserId);
    // Depois de apagar: a conta some mesmo que o Telegram recuse a remoção
    // (aí o leave passa o ID pros admins).
    await this.tipsGroup?.leave(user, 'deleted');
  }

  async createUser(
    params: CreateUserRequestDTO,
  ): Promise<CreateUserResponseDTO> {
    const existingEmail = await this.usersRepository.findByEmail(params.email);
    if (existingEmail) {
      throw new BadRequestException('E-mail já cadastrado');
    }

    // A tela de cadastro não pede username (pedia o "Nome" e usava como
    // username único: dois "Bruno" colidiam). Sem username no corpo, o servidor
    // gera um livre a partir do nome ou do e-mail.
    let username = params.username?.trim();
    if (username) {
      if (await this.usersRepository.findByUsername(username)) {
        throw new BadRequestException('Username já cadastrado');
      }
    } else {
      username = await this.freeUsername(params.fullName || params.email.split('@')[0]);
    }

    const passwordHash = await bcrypt.hash(params.password, 10);
    const created = await this.usersRepository.insertUser({
      username,
      email: params.email,
      passwordHash,
      roleId: DEFAULT_ROLE_ID,
      fullName: params.fullName ?? null,
      // Conta nova nasce sem acesso (ou com TRIAL_DAYS de teste): libera quando o PIX cair.
      accessUntil: extendAccess(null, Number(process.env.TRIAL_DAYS ?? 0)),
    });

    return publicUser(created) as unknown as CreateUserResponseDTO;
  }

  // "Bruno Souza" → "bruno.souza", "bruno.souza2", "bruno.souza3"... Cabe na
  // coluna (50) com folga pro sufixo.
  private async freeUsername(source: string): Promise<string> {
    const base =
      source
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 40) || 'usuario';
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? base : `${base}${n}`;
      if (!(await this.usersRepository.findByUsername(candidate))) return candidate;
    }
    return `${base}${Date.now()}`;
  }

  // Com o plano junto: é daqui que o site tira o cadeado e o "3 de 5 hoje".
  async getMe(userId: number) {
    const user = await this.usersRepository.findById(userId as UserId);
    if (!user) throw new BadRequestException('Usuário não encontrado.');
    const aiUsed = !isPro(user) && this.aiQuota ? await this.aiQuota.usedToday(user.id) : 0;
    return { ...publicUser(user), plan: planSummary(user, aiUsed) };
  }

  async updateMe(
    userId: number,
    params: UpdateUserRequestDTO,
  ): Promise<Omit<UserDto, 'passwordHash'>> {
    const fields: UpdateUser = {};
    if (params.email) {
      const current = await this.usersRepository.findById(userId as UserId);
      if (current && params.email !== current.email) {
        const ok =
          !!params.currentPassword &&
          (await bcrypt.compare(params.currentPassword, current.passwordHash));
        if (!ok) throw new UnauthorizedException('Senha atual incorreta');
      }
    }
    if (params.dashboardPreferences !== undefined)
      fields.dashboardPreferences = params.dashboardPreferences;
    if (params.username) {
      const dono = await this.usersRepository.findByUsername(params.username);
      if (dono && dono.id !== userId) throw new BadRequestException('Username já cadastrado');
      fields.username = params.username;
    }
    if (params.email) fields.email = params.email;
    if (params.fullName !== undefined) fields.fullName = params.fullName;
    if (params.stake !== undefined) fields.stake = params.stake;
    if (params.minPercentFilter !== undefined)
      fields.minPercentFilter = params.minPercentFilter;
    if (params.staleHouseDays !== undefined)
      fields.staleHouseDays = params.staleHouseDays;

    const updated = await this.usersRepository.updateUser(
      userId as UserId,
      fields,
    );
    if (!updated) throw new BadRequestException('Erro ao atualizar usuário.');
    return publicUser(updated);
  }
  /**
   * Confirma o código gerado no app. Só o bot chama, com o `ctx.from.id` que o
   * próprio Telegram garante — por isso não existe mais rota HTTP pra isto: ela
   * aceitava qualquer telegramUserId e deixava chutar os 10^6 códigos.
   */
  async confirmTelegramLink(code: string, telegramUserId: number, telegramUsername: string | null = null) {
    const owner = await this.usersRepository.findByTelegramLinkCode(code.trim());
    const expiresAt = owner?.telegramLinkExpiresAt ? new Date(owner.telegramLinkExpiresAt) : null;
    if (!owner || !expiresAt || expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Código inválido ou expirado.');
    }

    if (await this.usersRepository.findByTelegramUserId(telegramUserId)) {
      throw new BadRequestException('Este ID do Telegram já está vinculado a outra conta.');
    }

    await this.usersRepository.linkTelegram(owner.id, telegramUserId, telegramUsername);

    // Vinculou outro Telegram sem desvincular antes (o código também sai com a
    // conta já vinculada): o antigo perdeu o vínculo e não fica no grupo —
    // senão um acesso pago punha um Telegram atrás do outro lá dentro.
    if (owner.telegramUserId != null && Number(owner.telegramUserId) !== telegramUserId) {
      await this.tipsGroup?.leave(owner, 'relinked');
    }
    return owner;
  }

  /**
   * Vinculou de novo depois de sair do grupo (desvinculou, ou foi tirado pelo
   * painel) e está em dia: manda o convite, como o painel faz no "+30 dias".
   * Fica fora do confirmTelegramLink pro bot confirmar o vínculo antes.
   */
  async rejoinTipsGroup(
    user: { id: number; isActive: boolean | null; accessUntil: Date | null; tipsGroupRemovedAt: Date | null },
    telegramUserId: number,
  ): Promise<void> {
    if (!this.tipsGroup || !user.tipsGroupRemovedAt || !hasAccess(user)) return;
    const result = await this.tipsGroup.readmit(telegramUserId, user.accessUntil, '🔗 Telegram vinculado de novo.');
    // Falhou: a marca fica, e o painel oferece "Convidar".
    if (result !== 'failed') {
      await this.usersRepository.updateUser(user.id as UserId, { tipsGroupRemovedAt: null });
    }
  }

  // Devolve o hash novo: a troca de senha assina com ele o token que mantém
  // logada a sessão de quem trocou.
  async setPassword(userId: number, password: string): Promise<string> {
    const passwordHash = await bcrypt.hash(password, 10);
    await this.usersRepository.updateUser(userId as UserId, { passwordHash });
    return passwordHash;
  }

  async vincularTelegram(userId: number, telegramUserId: number) {
    await this.usersRepository.linkTelegram(userId as UserId, telegramUserId);
  }

  async desvincularTelegram(userId: number) {
    const user = await this.usersRepository.findById(userId as UserId);
    // Antes de apagar o ID: sem ele, nem o painel acha a pessoa no grupo.
    const left = user ? await this.tipsGroup?.leave(user, 'unlinked') : null;
    await this.usersRepository.updateUser(userId as UserId, {
      telegramUserId: null,
      telegramLinkedAt: null,
      telegramUsername: null,
      // Vinculando de novo em dia, o convite volta sozinho (rejoinTipsGroup).
      ...(left === 'removed' && { tipsGroupRemovedAt: new Date() }),
    });
  }

  // Tipo de retorno estendido com telegramUserId/minPercentFilter — a linha
  // de base do UserDto (usado como resposta pública em /users/me) não
  // declara esses campos, mas quem chama esse método específico (telegram
  // service) precisa deles pra montar o fan-out de tips.
  async findByTelegramUserId(telegramUserId: number): Promise<
    | (UserDto & {
        telegramUserId: number | null;
        minPercentFilter: number | null;
      })
    | null
  > {
    const user =
      await this.usersRepository.findByTelegramUserId(telegramUserId);
    return user ?? null;
  }

  async updateUserStake(userId: number, stake: number): Promise<boolean> {
    if (!Number.isFinite(stake) || stake <= 0) {
      throw new Error('Valor da stake deve ser maior que zero');
    }
    return this.usersRepository.updateUserStake(userId as UserId, stake);
  }

  // null = usuário ainda não definiu a banca (/stake ou Perfil). Sem banca não
  // há recomendação: um valor padrão virava stake gravada sem ninguém escolher.
  async getUserStake(userId: number): Promise<number | null> {
    const stake = await this.usersRepository.getUserStake(userId as UserId);
    return stake != null && Number(stake) > 0 ? Number(stake) : null;
  }

  async getUsersForTipsFanout() {
    return this.usersRepository.findLinkedForTipsFanout();
  }

  async syncTelegramUsername(telegramUserId: number, telegramUsername: string | null) {
    await this.usersRepository.syncTelegramUsername(telegramUserId, telegramUsername);
  }

  async setMinPercentFilter(
    telegramUserId: number,
    value: number | null,
  ): Promise<boolean> {
    if (
      value !== null &&
      (!Number.isFinite(value) || value < MIN_PERCENT_FILTER || value > MAX_PERCENT_FILTER)
    ) {
      throw new Error('Filtro de porcentagem inválido.');
    }
    return this.usersRepository.updateMinPercentFilter(telegramUserId, value);
  }
}
