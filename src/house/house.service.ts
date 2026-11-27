import { Injectable, NotFoundException } from '@nestjs/common';
import { HouseRepository } from '../infra/repository/house.repository';
import { FindAllHousesDTO } from './dto/house.dto';
import { HouseFilterRequestDto } from './dto/house.filter.dto';
import type { UserId } from '../db_types/Users';
import type { BettingHouseId } from '../db_types/BettingHouse';
import { matchHouseIdByName } from '../common/utils/house-match.util';

@Injectable()
export class HouseService {
  constructor(private readonly houseRepository: HouseRepository) {}

  async findHouseById(id: number) {
    const house = await this.houseRepository.findById(id as BettingHouseId);
    if (!house) {
      throw new NotFoundException(`House with ID ${id} not found`);
    }
    return house;
  }

  async getAllHousesBalanceWithFilter(filter: HouseFilterRequestDto, userId: number) {
    const rows = await this.houseRepository.findAllHousesBalance(userId as UserId, filter);

    return rows.map((row) => {
      const totalDeposit = Number(row.totalDeposit);
      const totalWithdrawal = Math.abs(Number(row.totalWithdrawalRaw));
      const totalAdjustment = Number(row.totalAdjustment);
      const totalBetProfit = Number(row.totalBetProfit);
      const settledStake = Number(row.settledStake);
      const netTransactions = totalDeposit - totalWithdrawal + totalAdjustment;
      const realHouseBalance = netTransactions + totalBetProfit;

      return {
        houseId: row.houseId,
        houseName: row.houseName,
        websiteUrl: row.websiteUrl ?? null,
        totalBets: Number(row.totalBets),
        settledBets: Number(row.settledBets),
        totalStake: Number(row.totalStake),
        settledStake,
        // Stake das pendentes: o saldo que a casa mostra e' realHouseBalance
        // menos isto. O "Saldo real" compara contra essa diferenca.
        openStake: Number(row.openStake),
        roi: settledStake > 0 ? totalBetProfit / settledStake : 0,
        totalBetProfit,
        totalDeposit,
        totalWithdrawal,
        totalTransactions: netTransactions,
        realHouseBalance,
        houseBalance: Math.max(0, realHouseBalance),
        pendingBets: Number(row.pendingBets),
        wonBets: Number(row.wonBets),
        lostBets: Number(row.lostBets),
        lastMovementAt: row.lastMovementAt ?? null,
        lastBetAt: row.lastBetAt ?? null,
      };
    });
  }

  async getHouseMetrics(userId: number, filter: HouseFilterRequestDto = {}) {
    const houses = await this.getAllHousesBalanceWithFilter(filter, userId);

    // `totalBalance` soma o saldo clampado: casa nao fica devendo, saldo real
    // negativo e sinal de lancamento faltando, nao de dinheiro. O tamanho do
    // buraco vai em `negativeAmount` (valor negativo) pro detalhe de "a conferir".
    return houses.reduce(
      (acc, h) => ({
        totalBalance: acc.totalBalance + h.houseBalance,
        totalDeposit: acc.totalDeposit + h.totalDeposit,
        totalWithdrawal: acc.totalWithdrawal + h.totalWithdrawal,
        consolidatedProfit: acc.consolidatedProfit + h.totalBetProfit,
        negativeHouses: acc.negativeHouses + (h.realHouseBalance < 0 ? 1 : 0),
        negativeAmount: acc.negativeAmount + Math.min(0, h.realHouseBalance),
        totalHousesUsed: acc.totalHousesUsed + 1,
      }),
      {
        totalBalance: 0,
        totalDeposit: 0,
        totalWithdrawal: 0,
        consolidatedProfit: 0,
        negativeHouses: 0,
        negativeAmount: 0,
        totalHousesUsed: 0,
      },
    );
  }

  async getAllHouses(): Promise<FindAllHousesDTO[]> {
    const rows = await this.houseRepository.findAllHouses();
    return rows.map(({ logoUpdatedAt, ...house }) => ({
      ...house,
      logoVersion: logoUpdatedAt ? new Date(logoUpdatedAt).getTime() : null,
    }));
  }

  async getHouseLogo(id: number) {
    const logo = await this.houseRepository.findLogo(id as BettingHouseId);
    if (!logo?.logo) throw new NotFoundException(`House ${id} has no logo`);
    return { bytes: logo.logo, mime: logo.logoMime || 'image/png' };
  }

  /**
   * Casa da aposta a partir do texto ("🏠 Betano", ou a linha depois de
   * SOBRECARGA/AVISO), casada por nome/apelido com as cadastradas. Morava no
   * GrokService, o que obrigava Tips e bilhete a instanciarem o cliente do Groq
   * (e a exigir a chave dele) só pra comparar string.
   */
  async resolveHouseIdFromText(message: string): Promise<number | null> {
    return (await this.findHouseFromText(message))?.id ?? null;
  }

  /**
   * Casa cadastrada (ativa) da tip, com os requisitos do verificador de
   * acesso. `houses` evita reler o catálogo quando o chamador já tem.
   */
  async findHouseFromText(message: string, houses?: FindAllHousesDTO[]) {
    if (!message) return null;

    let rawHouseName = message.match(/🏠\s*(.+)/)?.[1];
    if (!rawHouseName) {
      // Formato SOBRECARGA/AVISO: sem emoji — o nome da casa é a primeira
      // linha não vazia logo após o cabeçalho SOBRECARGA/AVISO.
      const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
      const headerIndex = lines.findIndex((l) => /^(SOBRECARGA|AVISO)$/i.test(l));
      if (headerIndex !== -1) rawHouseName = lines[headerIndex + 1];
    }
    if (!rawHouseName) return null;

    const list = houses ?? (await this.getAllHouses());
    const id = matchHouseIdByName(rawHouseName, list ?? []);
    return list.find((h) => h.id === id) ?? null;
  }

  async getHouseRanking(userId: number, startDate?: string, endDate?: string, minBets = 20) {
    const rows = await this.houseRepository.findHouseRanking(
      userId as UserId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );

    return rows
      .map((row) => {
        const settledBets = Number(row.settledBets);
        const wonBets = Number(row.wonBets);
        const decided = wonBets + Number(row.lostBets);
        const volume = Number(row.volume);
        const profit = Number(row.profit);
        return {
          houseId: row.houseId,
          houseName: row.houseName,
          settledBets,
          wonBets,
          hitRate: decided > 0 ? wonBets / decided : 0,
          avgOdd: Number(row.avgOdd),
          avgStake: Number(row.avgStake),
          volume,
          profit,
          roi: volume > 0 ? profit / volume : 0,
        };
      })
      .filter((h) => h.settledBets >= minBets);
  }

}
