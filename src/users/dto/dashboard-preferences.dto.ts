import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  ValidateBy,
  ValidateNested,
} from 'class-validator';

export const DASHBOARD_KPI_IDS = [
  'roi',
  'units',
  'bets',
  'pending',
  'totalStaked',
  'averageStake',
  'averageOdd',
  'hitRate',
  'profit',
  'totalReturn',
  'wonLost',
  'canceled',
  'streak',
  'biggestWin',
  'biggestLoss',
  'maxDrawdown',
  // Banca das casas (saldo no fim do período). Entrou com o dash de 4 KPIs.
  'bankroll',
] as const;
export const MAX_VISIBLE_KPIS = 4;
export const DASHBOARD_ICON_IDS = [
  'trending-up',
  'coins',
  'database',
  'clock',
  'credit-card',
  'chart-bar',
  'target',
  'chart-line',
  'percent',
  'activity',
  'layers',
  'list',
  'ticket',
  'timer',
  'hourglass',
  'wallet',
  'banknote',
  'crosshair',
  'trophy',
  'check-circle',
] as const;

class DashboardKpiDTO {
  @IsIn(DASHBOARD_KPI_IDS)
  id!: (typeof DASHBOARD_KPI_IDS)[number];

  @IsBoolean()
  visible!: boolean;

  @IsIn(DASHBOARD_ICON_IDS)
  icon!: (typeof DASHBOARD_ICON_IDS)[number];
}

class PerformanceColorsDTO {
  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  customEnabled!: boolean;

  @IsIn(['default-positive', 'emerald', 'turquoise', 'blue'])
  positive!: 'default-positive' | 'emerald' | 'turquoise' | 'blue';

  @IsIn(['default-negative', 'coral', 'orange', 'pink'])
  negative!: 'default-negative' | 'coral' | 'orange' | 'pink';
}

export class DashboardPreferencesDTO {
  @IsArray()
  // Min 2 em vez de "todos": cliente antigo ainda manda só os 8 originais, e o
  // front completa os que faltam ao ler.
  @ArrayMinSize(2)
  @ArrayMaxSize(DASHBOARD_KPI_IDS.length)
  @ArrayUnique((kpi: DashboardKpiDTO) => kpi?.id)
  @ValidateBy({
    name: 'minimumVisibleKpis',
    validator: {
      validate: (value: unknown) => {
        if (!Array.isArray(value)) return false;
        const visible = value.filter((kpi: DashboardKpiDTO | null) => kpi?.visible === true).length;
        return visible >= 2 && visible <= MAX_VISIBLE_KPIS;
      },
      defaultMessage: () => `Selecione de 2 a ${MAX_VISIBLE_KPIS} indicadores.`,
    },
  })
  @ValidateNested({ each: true })
  @Type(() => DashboardKpiDTO)
  kpis!: DashboardKpiDTO[];

  @IsObject()
  @ValidateNested()
  @Type(() => PerformanceColorsDTO)
  performanceColors!: PerformanceColorsDTO;
}
