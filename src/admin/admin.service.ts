import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AdminRepository } from '../infra/repository/admin.repository';
import { UsersRepository } from '../infra/repository/users.repository';
import { HouseRepository } from '../infra/repository/house.repository';
import { CreateAdminHouseDTO, UpdateAdminHouseDTO, UpdateAdminUserDTO } from './dto/admin.dto';
import { normalizeName } from '../common/utils/bet.utils';
import { normalizeFederalHouseUrl } from '../common/utils/house-url.util';
import { detectImageMime } from '../bet-slip/bet-slip.service';
import type { BettingHouseId } from '../db_types/BettingHouse';
import { ADMIN_ROLE_ID } from '../common/guards/admin.guard';
import type { UpdateUser, UserId } from '../db_types/Users';
import type { RoleId } from '../db_types/Roles';
import { extendAccess, hasAccess } from '../users/access';
import { TipsGroupService, telegramErrorText } from '../telegram/tips-group.service';

type AdminHouseRow = Awaited<ReturnType<HouseRepository['findAllHousesForAdmin']>>[number];

// O front reduz pra 128px antes de mandar; 200 KB sobra pra isso e barra
// foto crua que alguém subir sem passar pela tela.
export const MAX_HOUSE_LOGO_BYTES = 200 * 1024;

const logoVersion = (at: Date | string | null | undefined) => (at ? new Date(at).getTime() : null);

/** Linha de casa pra resposta: sem os bytes do logo, só a versão dele. */
function toAdminHouse<T extends { logoUpdatedAt?: Date | null; logo?: unknown; logoMime?: unknown }>(row: T) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { logo, logoMime, logoUpdatedAt, ...house } = row;
  return { ...house, logoVersion: logoVersion(logoUpdatedAt) };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly adminRepository: AdminRepository,
    private readonly usersRepository: UsersRepository,
    private readonly houseRepository: HouseRepository,
    private readonly tipsGroup: TipsGroupService,
  ) {}

  async overview(userId: number) {
    const { deliveryFilters, ...data } = await this.adminRepository.overview(userId as UserId);

    /**
     * Tip que passaria pelo filtro de pelo menos um usuário vinculado e mesmo
     * assim não gerou DM. É a única linha da lista que merece cor: as outras
     * são o filtro de % funcionando.
     *
     * Ainda pode dar falso positivo — o fan-out também pula quem saiu do grupo
     * de Tips, e isso só o Telegram sabe. Por isso o card mostra a lista, não
     * um alarme.
     */
    const expected = (percent: number | null) =>
      deliveryFilters.some((f) => f === null || percent === null || Number(percent) >= f);

    const undeliveredTips = data.undeliveredTips.map((tip) => ({
      id: Number(tip.id),
      createdAt: tip.createdAt,
      percent: tip.percent === null ? null : Number(tip.percent),
      // Texto inteiro: quem lê isso é a tela /admin/tips, onde a mensagem é o
      // conteúdo. Cortada, não dava pra saber de que aposta se tratava.
      text: tip.text,
      expectedDelivery: expected(tip.percent),
    }));

    return {
      ...data,
      undeliveredTips,
      undeliveredExpected: undeliveredTips.filter((t) => t.expectedDelivery).length,
    };
  }

  async listUsers() {
    const rows = await this.adminRepository.listUsers();

    return rows.map(({ telegramUserId, betCount, ...user }) => ({
      ...user,
      // O ID do Telegram não tem uso na tela e é dado de outra plataforma:
      // sai só o fato de existir vínculo.
      hasTelegram: telegramUserId !== null,
      betCount: Number(betCount),
    }));
  }

  async listHouses() {
    const rows = await this.houseRepository.findAllHousesForAdmin();
    return rows.map((house) => ({ ...toAdminHouse(house), betCount: Number(house.betCount) }));
  }

  /**
   * Casa nova. O nome é conferido contra os existentes com a mesma
   * normalização que o casamento de tips usa (`normalizeName`): sem isso
   * "Bet 365" entra como casa separada de "Bet365" e as apostas se dividem
   * entre as duas sem ninguém perceber.
   */
  async createHouse(dto: CreateAdminHouseDTO) {
    const houses = await this.houseRepository.findAllHousesForAdmin();
    const name = dto.name.trim();

    this.assertNameIsFree(houses, name);
    const aliases = this.normalizeAliases(dto.aliases ?? [], name, houses, null);
    const websiteUrl = normalizeFederalHouseUrl(dto.websiteUrl);

    const created = await this.houseRepository.createHouse(name, aliases, websiteUrl);
    return { ...toAdminHouse(created), betCount: 0 };
  }

  async updateHouse(id: number, dto: UpdateAdminHouseDTO) {
    const houses = await this.houseRepository.findAllHousesForAdmin();
    const current = houses.find((h) => Number(h.id) === id);
    if (!current) throw new NotFoundException('Casa não encontrada');

    const update: { name?: string; aliases?: string[]; isActive?: boolean; websiteUrl?: string | null } = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      this.assertNameIsFree(houses, name, id);
      update.name = name;
    }

    if (dto.aliases !== undefined) {
      update.aliases = this.normalizeAliases(dto.aliases, update.name ?? current.name, houses, id);
    }

    if (dto.isActive !== undefined) update.isActive = dto.isActive;
    if (dto.websiteUrl !== undefined) update.websiteUrl = normalizeFederalHouseUrl(dto.websiteUrl);

    if (Object.keys(update).length === 0) {
      throw new BadRequestException('Nada para atualizar');
    }

    const updated = await this.houseRepository.updateHouse(id as BettingHouseId, update);
    if (!updated) throw new NotFoundException('Casa não encontrada');
    return { ...toAdminHouse(updated), betCount: Number(current.betCount) };
  }

  /** Troca o avatar da casa. Tipo conferido pelos bytes, não pelo mimetype. */
  async setHouseLogo(id: number, bytes: Buffer | undefined) {
    if (!bytes?.length) throw new BadRequestException('Envie a imagem no campo "logo".');
    if (bytes.length > MAX_HOUSE_LOGO_BYTES) throw new BadRequestException('Imagem grande demais (máx. 200 KB).');
    const mime = detectImageMime(bytes);
    if (!mime) throw new BadRequestException('Formato não suportado: use PNG, JPEG ou WebP.');

    const saved = await this.houseRepository.setLogo(id as BettingHouseId, { bytes, mime });
    if (!saved) throw new NotFoundException('Casa não encontrada');
    return { id: saved.id, logoVersion: logoVersion(saved.logoUpdatedAt) };
  }

  /** Tira o avatar: a casa volta a mostrar as iniciais. */
  async removeHouseLogo(id: number) {
    const saved = await this.houseRepository.setLogo(id as BettingHouseId, null);
    if (!saved) throw new NotFoundException('Casa não encontrada');
    return { id: saved.id, logoVersion: null };
  }

  private assertNameIsFree(houses: AdminHouseRow[], name: string, ignoreId: number | null = null) {
    const normalized = normalizeName(name);
    const clash = houses.find((h) => Number(h.id) !== ignoreId && normalizeName(h.name) === normalized);
    if (clash) {
      throw new BadRequestException(`"${clash.name}" já é a mesma casa com outra grafia`);
    }
  }

  /**
   * Apelido só serve se for único: `matchHouseIdByName` devolve a primeira casa
   * cujo apelido bate, então o mesmo apelido em duas casas faria a tip cair na
   * que aparecer primeiro — silenciosamente, e mudando conforme a ordenação.
   * Apelido igual ao nome da própria casa é redundante e sai fora.
   */
  private normalizeAliases(
    aliases: string[],
    ownName: string,
    houses: AdminHouseRow[],
    ignoreId: number | null,
  ): string[] {
    const seen = new Set<string>([normalizeName(ownName)]);
    const result: string[] = [];

    for (const raw of aliases) {
      const alias = raw.trim();
      const normalized = normalizeName(alias);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);

      const clash = houses.find(
        (h) =>
          Number(h.id) !== ignoreId &&
          (normalizeName(h.name) === normalized ||
            (h.aliases ?? []).some((a) => normalizeName(a) === normalized)),
      );
      if (clash) {
        throw new BadRequestException(`O apelido "${alias}" já aponta para "${clash.name}"`);
      }

      result.push(alias);
    }

    return result;
  }

  /**
   * Mudanças administrativas numa conta alheia. `requesterId` existe pra uma
   * regra só: o admin não se rebaixa. Sem ela, um clique na própria linha
   * tranca o dono do lado de fora da tela — e não sobra nenhum caminho pela
   * aplicação pra desfazer, só o banco.
   */
  async updateUser(requesterId: number, targetId: number, dto: UpdateAdminUserDTO) {
    const target = await this.usersRepository.findById(targetId as UserId);
    if (!target) throw new NotFoundException('Usuário não encontrado');

    if (
      dto.roleId !== undefined &&
      dto.roleId !== ADMIN_ROLE_ID &&
      requesterId === targetId
    ) {
      throw new BadRequestException('Você não pode alterar o próprio papel');
    }
    // Mesmo motivo: um prazo na própria conta tranca o admin quando vencer.
    if ((dto.extendDays || dto.accessUntil !== undefined) && requesterId === targetId) {
      throw new BadRequestException('Sua conta não tem vencimento');
    }
    // Idem: desativar a própria conta tranca o admin do lado de fora na hora.
    if (dto.isActive === false && requesterId === targetId) {
      throw new BadRequestException('Você não pode desativar a própria conta');
    }

    const fields: UpdateUser = {};
    if (dto.roleId !== undefined) fields.roleId = dto.roleId as RoleId;
    if (dto.isActive !== undefined) fields.isActive = dto.isActive;
    if (dto.unlock) {
      fields.failedLoginAttempts = 0;
      fields.lockedUntil = null;
    }
    if (dto.unlinkTelegram) {
      fields.telegramUserId = null;
      fields.telegramLinkedAt = null;
      fields.telegramUsername = null;
    }
    if (dto.extendDays && dto.accessUntil !== undefined) {
      throw new BadRequestException('Use +dias ou uma data, não os dois');
    }
    if (dto.extendDays) fields.accessUntil = extendAccess(target.accessUntil, dto.extendDays);
    if (dto.accessUntil !== undefined) {
      fields.accessUntil = dto.accessUntil === null ? null : new Date(dto.accessUntil);
    }

    if (Object.keys(fields).length === 0 && !dto.tipsGroup) {
      throw new BadRequestException('Nada para atualizar');
    }

    const after = { ...target, ...fields };
    if (dto.tipsGroup) this.assertTipsGroupAction(dto.tipsGroup, after);

    // Desvincular tira do grupo antes de apagar o ID: depois dele o bot não
    // sabe mais quem é a pessoa lá dentro (o grupo é só de conta vinculada).
    if (dto.unlinkTelegram) {
      const left = await this.tipsGroup.leave(target, 'unlinked');
      if (left === 'removed') fields.tipsGroupRemovedAt = new Date();
    }

    if (Object.keys(fields).length > 0) {
      await this.usersRepository.updateUser(targetId as UserId, fields);
    }

    let groupInvite: 'sent' | 'failed' | undefined;
    if (dto.tipsGroup === 'remove') {
      await this.removeFromTipsGroup(targetId, after.telegramUserId as number);
    } else if (this.shouldReadmit(dto, target, after)) {
      // Depois do UPDATE de propósito: o convite pede aprovação, e o bot
      // aprova lendo o vencimento no banco.
      const result = await this.tipsGroup.readmit(after.telegramUserId as number, after.accessUntil ?? null);
      // Falhou: a marca fica, e a tela oferece "Convidar" pra repetir.
      if (result !== 'failed' && target.tipsGroupRemovedAt) {
        await this.usersRepository.updateUser(targetId as UserId, { tipsGroupRemovedAt: null });
      }
      groupInvite = result ?? undefined;
    }

    // A linha volta pela mesma consulta da lista (com contagem de apostas e sem
    // hash), pra tela poder trocar a linha no lugar em vez de refazer o GET.
    const users = await this.listUsers();
    const updated = users.find((u) => Number(u.id) === targetId);
    if (!updated) throw new NotFoundException('Usuário não encontrado');
    // undefined some no JSON: só vem na resposta quando houve convite.
    return { ...updated, groupInvite };
  }

  /**
   * O Telegram não esconde mensagem de membro: quem não pagou só deixa de ler
   * o grupo Tips saindo dele. Sair é pelo painel, só pra quem está sem acesso
   * — em dia e fora do grupo é o estado que "invite" existe pra desfazer.
   */
  private assertTipsGroupAction(action: 'remove' | 'invite', after: { telegramUserId: number | null; isActive: boolean | null; accessUntil: Date | null }) {
    if (!this.tipsGroup.configured) {
      throw new BadRequestException('Grupo Tips não configurado (TIPS_GROUP_CHAT_ID)');
    }
    if (!after.telegramUserId) {
      throw new BadRequestException('Sem Telegram vinculado: o bot não sabe quem é essa pessoa no grupo');
    }
    if (action === 'remove' && hasAccess(after)) {
      throw new BadRequestException('Só sai do grupo quem está com o acesso vencido');
    }
    if (action === 'invite' && !hasAccess(after)) {
      throw new BadRequestException('O acesso está vencido: libere o prazo antes de convidar');
    }
  }

  private async removeFromTipsGroup(targetId: number, telegramUserId: number) {
    try {
      await this.tipsGroup.remove(telegramUserId);
    } catch (error) {
      // Os motivos comuns são de configuração (bot sem "Banir usuários",
      // pessoa é admin do grupo) — a descrição do Telegram já diz qual.
      throw new BadRequestException(`O Telegram recusou a remoção: ${telegramErrorText(error)}`);
    }
    await this.usersRepository.updateUser(targetId as UserId, { tipsGroupRemovedAt: new Date() });
  }

  // Convite só quando o acesso acabou de voltar (estava vencido, ou foi tirado
  // do grupo) — renovar quem está em dia e lá dentro não manda nada.
  private shouldReadmit(
    dto: UpdateAdminUserDTO,
    target: { isActive: boolean | null; accessUntil: Date | null; tipsGroupRemovedAt: Date | null },
    after: { telegramUserId: number | null; isActive: boolean | null; accessUntil: Date | null },
  ): boolean {
    if (!after.telegramUserId || !hasAccess(after)) return false;
    if (dto.tipsGroup === 'invite') return true;
    const accessChanged =
      dto.extendDays !== undefined || dto.accessUntil !== undefined || dto.isActive !== undefined;
    return accessChanged && (!!target.tipsGroupRemovedAt || !hasAccess(target));
  }
}
