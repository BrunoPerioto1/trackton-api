import type BetsTable from '../../db_types/Bet';
import type BetResultsTable from '../../db_types/BetsResults';
import type BettingHousesTable from '../../db_types/BettingHouse';
import type ResultsTable from '../../db_types/Results';
import RolesTable from '../../db_types/Roles';
import UsersTable from '../../db_types/Users';
import TransactionTypesTable from '../../db_types/TransactionsTypes';
import HouseTransactionsTable from '../../db_types/HouseTransactions';
import type TipsTable from '../../db_types/Tips';
import type TipDismissalsTable from '../../db_types/TipDismissals';
import type TipDeliveriesTable from '../../db_types/TipDeliveries';
import type SportEventsTable from '../../db_types/SportEvents';
import type EventResultsTable from '../../db_types/EventResults';
import type EventFactsTable from '../../db_types/EventFacts';
import type BetSettlementSuggestionsTable from '../../db_types/BetSettlementSuggestions';
import type BetEventsTable from '../../db_types/BetEvents';
import type SportsTable from '../../db_types/Sports';
import type RateLimitHitsTable from '../../db_types/RateLimitHits';
import type ScannerTournamentsTable from '../../db_types/ScannerTournaments';
import type SubscriptionPaymentsTable from '../../db_types/SubscriptionPayments';

export interface Database {
  bets: BetsTable;
  betResults: BetResultsTable;
  bettingHouses: BettingHousesTable;
  results: ResultsTable;
  roles: RolesTable;
  users: UsersTable;
  transactionTypes: TransactionTypesTable
  houseTransactions: HouseTransactionsTable
  tips: TipsTable
  tipDismissals: TipDismissalsTable
  tipDeliveries: TipDeliveriesTable
  sportEvents: SportEventsTable
  eventResults: EventResultsTable
  eventFacts: EventFactsTable
  betSettlementSuggestions: BetSettlementSuggestionsTable
  betEvents: BetEventsTable
  sports: SportsTable
  rateLimitHits: RateLimitHitsTable
  scannerTournaments: ScannerTournamentsTable
  subscriptionPayments: SubscriptionPaymentsTable
}
