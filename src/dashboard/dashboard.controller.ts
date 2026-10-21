// dashboard.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto, DashboardMetricsComparisonQueryDto } from './dto/dashboard-query.dto';
import { User } from '../common/decorators/user.decorator';
import { UserId } from '../db_types/Users';

@ApiTags('Dashboard')
@Controller('dashboard')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('date-range')
  @ApiOperation({ summary: 'Obtém a data da primeira e da última aposta do usuário' })
  @ApiResponse({ status: 200, description: 'Intervalo retornado com sucesso.' })
  async getDateRange(@User('userId') userId: UserId) {
    return this.dashboardService.getBetDateRange(userId);
  }

  @Get('by-house')
  @ApiOperation({ summary: 'Obtém o lucro por casa no período' })
  @ApiResponse({ status: 200, description: 'Lucro por casa retornado com sucesso.' })
  async getProfitByHouse(
    @Query() query: DashboardQueryDto,
    @User('userId') userId: UserId,
  ) {
    return this.dashboardService.getProfitByHouse(userId, query);
  }

  @Get('by-sport')
  @ApiOperation({ summary: 'Obtém apostas e lucro por esporte no período' })
  @ApiResponse({ status: 200, description: 'Apostas por esporte retornadas com sucesso.' })
  async getBetsBySport(
    @Query() query: DashboardQueryDto,
    @User('userId') userId: UserId,
  ) {
    return this.dashboardService.getBetsBySport(userId, query);
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Obtém métricas do dashboard' })
  @ApiResponse({ status: 200, description: 'Métricas retornadas com sucesso.' })
  async getMetrics(
    @Query() query: DashboardQueryDto,
    @User('userId') userId: UserId,
  ) {
    return this.dashboardService.getDashboardMetrics(userId, query);
  }

  @Get('metrics-comparison')
  @ApiOperation({ summary: 'Obtém métricas do período atual e do período anterior, para comparação' })
  @ApiResponse({ status: 200, description: 'Métricas de comparação retornadas com sucesso.' })
  async getMetricsComparison(
    @Query() query: DashboardMetricsComparisonQueryDto,
    @User('userId') userId: UserId,
  ) {
    return this.dashboardService.getDashboardMetricsComparison(userId, query);
  }

  @Get('monthly-summary')
  @ApiOperation({ summary: 'Obtém resumo mensal para gráficos' })
  @ApiResponse({ status: 200, description: 'Resumo mensal retornado com sucesso.' })
  async getMonthlySummary(
    @Query() query: DashboardQueryDto,
    @User('userId') userId: UserId,
  ) {
    return this.dashboardService.getMonthlySummary(userId, query);
  }

  @Get('daily-summary')
  @ApiOperation({ summary: 'Obtém resumo diário para gráficos' })
  @ApiResponse({ status: 200, description: 'Resumo diário retornado com sucesso.' })
  async getDailySummary(
    @Query() query: DashboardQueryDto,
    @User('userId') userId: UserId,
  ) {
    return this.dashboardService.getDailySummary(userId, query);
  }
}