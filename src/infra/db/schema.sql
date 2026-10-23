-- Betting Tracker schema
-- Idempotent: safe to re-run against an existing database.
--
-- Banco novo: `npm run db:setup` (este arquivo + todas as migrations, em ordem,
-- registradas em schema_migrations). Banco existente: `npm run db:migrate`.
-- Mudança de estrutura nova entra como migration em ./migrations, não aqui.

-- === Reference tables ===============================================

CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    permissions JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS results (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

INSERT INTO results (id, name) VALUES
    (1, 'WON'),
    (2, 'LOST'),
    (3, 'CANCELED'),
    (4, 'HALF_WON'),
    (5, 'HALF_LOST'),
    (6, 'CASHOUT'),
    (9, 'PENDING')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS transaction_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

INSERT INTO transaction_types (id, name) VALUES
    (1, 'DEPOSIT'),
    (2, 'WITHDRAWAL'),
    (3, 'ADJUSTMENT')
ON CONFLICT (id) DO NOTHING;

-- === Users =============================================================

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    telegram_user_id BIGINT,
    stake NUMERIC(12,2),          -- bankroll used to size Telegram-bot bets from a stated %
    min_percent_filter NUMERIC(5,2), -- minimum tip % to forward from the Tips group; NULL = no filter
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent for pre-existing databases created before this column was added.
ALTER TABLE users ADD COLUMN IF NOT EXISTS min_percent_filter NUMERIC(5,2);

-- Personalização opcional; NULL preserva os padrões de usuários existentes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_preferences JSONB;

-- Dias sem apostar numa casa com saldo até sugerir saque; NULL = padrão (20).
ALTER TABLE users ADD COLUMN IF NOT EXISTS stale_house_days SMALLINT;

-- Login lockout. Counted per user in the database, not per IP in memory: the
-- API runs serverless, so an in-process counter resets whenever a request
-- lands on a fresh instance and would never actually lock anyone out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;

-- Telegram linking. The code lives in the row, not in the API process: the bot
-- confirms the link on a second request that lands on a different serverless
-- instance, so an in-memory map never had the code by then.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code VARCHAR(6);
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(32);

-- Accounts linked before the column existed have no date to show. updated_at is
-- an approximation (any profile change moves it), but it beats leaving the
-- screen with nothing. Guarded by IS NULL so re-running never overwrites a real
-- link date.
UPDATE users
   SET telegram_linked_at = updated_at
 WHERE telegram_user_id IS NOT NULL
   AND telegram_linked_at IS NULL;

-- Acesso pago: vencimento renovado pelo admin a cada PIX. NULL = sem prazo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_until TIMESTAMP;

-- Tirado do grupo Tips pelo painel (ban no Telegram). NULL = nunca tirado ou
-- ja convidado de volta.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tips_group_removed_at TIMESTAMP;

-- "Ja paguei" e redefinir senha (hoje: SHA-256 do token do link). Ver
-- migrations/20260926_users_payment_and_password_reset.sql.
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_claimed_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_code_hash VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_attempts SMALLINT NOT NULL DEFAULT 0;

-- Assinatura do Pro no Mercado Pago. Ver
-- migrations/20261019_mercadopago_subscription.sql.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_preapproval_id VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mp_preapproval_id ON users (mp_preapproval_id);

-- === Bookmakers =========================================================

CREATE TABLE IF NOT EXISTS betting_houses (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Apelidos/variações de nome (ex.: "Superbet Brasil", "Pagol Bet") que o
-- parser de apostas do Telegram deve reconhecer como a mesma casa — usado
-- como candidato extra no fuzzy-match do GrokService além do próprio name.
ALTER TABLE betting_houses ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';

-- Site da casa; só domínio .bet.br (autorização federal), validado na API.
ALTER TABLE betting_houses ADD COLUMN IF NOT EXISTS website_url TEXT;

-- Avatar da casa (bytes da imagem); logo_updated_at versiona a URL.
ALTER TABLE betting_houses ADD COLUMN IF NOT EXISTS logo BYTEA;
ALTER TABLE betting_houses ADD COLUMN IF NOT EXISTS logo_mime TEXT;
ALTER TABLE betting_houses ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS house_transactions (
    id SERIAL PRIMARY KEY,
    house_id INTEGER NOT NULL REFERENCES betting_houses(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    transaction_type_id INTEGER NOT NULL REFERENCES transaction_types(id) ON DELETE RESTRICT,
    value NUMERIC(12,2) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- === Bets ===============================================================

CREATE TABLE IF NOT EXISTS bets (
    id SERIAL PRIMARY KEY,
    game VARCHAR(255) NOT NULL,
    stake DECIMAL(10,2) NOT NULL,
    odd DECIMAL(5,2) NOT NULL,
    house_id INTEGER REFERENCES betting_houses(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    market VARCHAR(255) NOT NULL,
    sport VARCHAR(50) NOT NULL,
    profit NUMERIC(12,2),
    cashout_value NUMERIC(12,2),   -- amount actually received; only set when result = CASHOUT
    bet_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bet_results (
    id SERIAL PRIMARY KEY,
    bet_id INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
    result_id INTEGER NOT NULL DEFAULT 9 REFERENCES results(id), -- 9 = PENDING
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- === Tips (grupo do Telegram) ===========================================
-- Existiam no banco e faltavam aqui: quem subia um banco novo pelo schema.sql
-- ficava sem /pendentes, sem tela de Tips e sem bets.tip_id. Tirado da
-- estrutura de producao (information_schema) em 2026-09-26.

-- Cada mensagem do grupo Tips. (chat_id, message_id) unico: o Telegram
-- reentrega o mesmo update e a tip nao pode duplicar.
CREATE TABLE IF NOT EXISTS tips (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    text TEXT NOT NULL,
    percent NUMERIC(5,2),
    is_aviso BOOLEAN NOT NULL DEFAULT FALSE,
    has_media BOOLEAN NOT NULL DEFAULT FALSE,
    entities JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_tips_created_at ON tips (created_at);

-- "Aposta caiu" do usuario pra uma tip.
CREATE TABLE IF NOT EXISTS tip_dismissals (
    id BIGSERIAL PRIMARY KEY,
    tip_id BIGINT NOT NULL REFERENCES tips(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tip_id, user_id)
);

-- A copia que o fan-out mandou na DM de cada usuario (texto com a
-- "Recomendacao de aposta" dele), pra editar a mensagem depois.
CREATE TABLE IF NOT EXISTS tip_deliveries (
    id BIGSERIAL PRIMARY KEY,
    tip_id BIGINT NOT NULL REFERENCES tips(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    message_id BIGINT NOT NULL,
    has_media BOOLEAN NOT NULL DEFAULT FALSE,
    text TEXT NOT NULL,
    entities JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tip_id, user_id)
);

-- Aposta que uma tip gerou. Uma aposta viva por (usuario, tip): ver
-- migrations/20260925_bets_unique_tip_per_user.sql.
ALTER TABLE bets ADD COLUMN IF NOT EXISTS tip_id BIGINT REFERENCES tips(id);
CREATE INDEX IF NOT EXISTS idx_bets_tip_id ON bets (tip_id);

-- === Indexes ============================================================

CREATE INDEX IF NOT EXISTS idx_bets_bet_time ON bets(bet_time DESC);
CREATE INDEX IF NOT EXISTS idx_bets_house_id ON bets(house_id);
CREATE INDEX IF NOT EXISTS idx_bets_user_id ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_bet_results_bet_id ON bet_results(bet_id);
CREATE INDEX IF NOT EXISTS idx_bet_results_result_id ON bet_results(result_id);
CREATE INDEX IF NOT EXISTS idx_house_transactions_house_id ON house_transactions(house_id);
CREATE INDEX IF NOT EXISTS idx_house_transactions_user_id ON house_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_house_transactions_type_id ON house_transactions(transaction_type_id);
CREATE INDEX IF NOT EXISTS idx_house_transactions_created_at ON house_transactions(created_at DESC);

-- === updated_at triggers ===============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_bets_updated_at ON bets;
CREATE TRIGGER update_bets_updated_at
    BEFORE UPDATE ON bets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bet_results_updated_at ON bet_results;
CREATE TRIGGER update_bet_results_updated_at
    BEFORE UPDATE ON bet_results
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_house_transactions_updated_at ON house_transactions;
CREATE TRIGGER update_house_transactions_updated_at
    BEFORE UPDATE ON house_transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- === Seed: bookmakers ===================================================
-- A starter list of Brazilian bookmakers. Extend via `POST /house` at runtime.

INSERT INTO betting_houses (name) VALUES
    ('BET365'), ('BETANO'), ('BETFAIR'), ('SUPERBET'), ('PIXBET'),
    ('KTO'), ('ESTRELABET'), ('NOVIBET'), ('SPORTINGBET'), ('RIVALO')
ON CONFLICT (name) DO NOTHING;

-- AI ingestion provenance: NULL means legacy/unknown; do not backfill guesses.
ALTER TABLE bets ADD COLUMN IF NOT EXISTS source VARCHAR(16);
ALTER TABLE bets ADD COLUMN IF NOT EXISTS source_type VARCHAR(16);
ALTER TABLE bets ADD COLUMN IF NOT EXISTS telegram_message_id INTEGER;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bets_duplicate_candidates ON bets (user_id, house_id, created_at);

-- === Event dates ========================================================
-- `bet_time` is when the bet was placed; it is NOT when the match kicks off.
-- The job in jobs/sofascore fills this cache; the API only reads it. Provider
-- is a column, not a code path: swapping SofaScore out means swapping the job.
CREATE TABLE IF NOT EXISTS sport_events (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(32) NOT NULL,
    external_id VARCHAR(64) NOT NULL,
    sport VARCHAR(32) NOT NULL,
    tournament_name VARCHAR(120),
    -- name/short/code are the provider's own aliases ("Manchester City",
    -- "Man City", "MCI"). The matcher scores against all three.
    home_name VARCHAR(120) NOT NULL,
    home_short VARCHAR(120),
    home_code VARCHAR(16),
    away_name VARCHAR(120) NOT NULL,
    away_short VARCHAR(120),
    away_code VARCHAR(16),
    start_at TIMESTAMP NOT NULL,
    status VARCHAR(24),
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_sport_events_start ON sport_events (start_at);

-- Matched event. NULL everywhere means "no confident match": the bet is still
-- created, it just has no real kickoff time. Never backfilled with a guess.
ALTER TABLE bets ADD COLUMN IF NOT EXISTS event_external_id VARCHAR(64);
ALTER TABLE bets ADD COLUMN IF NOT EXISTS event_provider VARCHAR(32);
ALTER TABLE bets ADD COLUMN IF NOT EXISTS event_start_at TIMESTAMP;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS event_match_confidence NUMERIC(4,3);

-- The job rewrites event_start_at on the bets pointing at a rescheduled event.
CREATE INDEX IF NOT EXISTS idx_bets_event ON bets (event_provider, event_external_id);

-- === Final scores =======================================================
-- Placar de jogo ja' terminado. Tabela separada de sport_events de proposito:
-- aquela e' cache de jogos FUTUROS e se apaga sozinha 2 dias depois do jogo,
-- enquanto o placar precisa sobreviver enquanto houver aposta apontando pra
-- ele. A chave e' a mesma que a aposta ja' guarda (provider + external_id),
-- entao liquidar nao refaz o matching de time — ele ja' foi feito na criacao.
CREATE TABLE IF NOT EXISTS event_results (
    provider VARCHAR(32) NOT NULL,
    external_id VARCHAR(64) NOT NULL,
    -- Tempo normal (90min). O provider tambem expoe o placar com prorrogacao;
    -- mercado de futebol liquida em tempo normal, entao e' este que vale.
    home_score SMALLINT NOT NULL,
    away_score SMALLINT NOT NULL,
    -- Status do provider: so' 'finished' libera liquidacao. 'postponed' e
    -- 'canceled' ficam gravados pra nao rebuscar o mesmo evento toda hora.
    status VARCHAR(24) NOT NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, external_id)
);

-- === Settlement suggestions =============================================
-- Liquidacao NUNCA escreve em bet_results: ela propoe aqui e o usuario
-- confirma na tela de conferencia. Errar um resultado mexe no lucro sem
-- ninguem perceber, entao a decisao continua sendo humana.
CREATE TABLE IF NOT EXISTS bet_settlement_suggestions (
    bet_id INTEGER PRIMARY KEY REFERENCES bets(id) ON DELETE CASCADE,
    -- results(id): 1=WON, 2=LOST, 3=CANCELED (linha inteira empatada numa
    -- aposta simples devolve o stake). NULL = nao deu pra decidir; `reason`
    -- explica.
    suggested_result_id INTEGER REFERENCES results(id),
    -- Codigo curto quando nao ha sugestao (MERCADO_NAO_RECONHECIDO,
    -- FORA_DE_ESCOPO, JOGO_NAO_FINALIZADO, SEM_PLACAR...).
    reason VARCHAR(40),
    -- Frase que a tela mostra: "3 gols no jogo, mais de 2.5". E' o que deixa o
    -- usuario conferir sem abrir a casa de aposta.
    explanation TEXT,
    home_score SMALLINT,
    away_score SMALLINT,
    computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Usuario recusou a sugestao: nao some da lista por acidente na proxima
    -- recomputacao, e nao volta a aparecer.
    dismissed_at TIMESTAMP
);

-- A tela pede sempre o mesmo subconjunto: sugestao decidida e nao recusada.
-- Indexar `suggested_result_id` nao servia pra isso — sao 3 valores possiveis e
-- nenhuma consulta filtra por um deles, so' por IS NOT NULL. Parcial por bet_id
-- deixa o join com bets tocar so' as sugestoes vivas, sem varrer o historico.
DROP INDEX IF EXISTS idx_settlement_pending;
CREATE INDEX IF NOT EXISTS idx_settlement_live
    ON bet_settlement_suggestions (bet_id)
    WHERE dismissed_at IS NULL AND suggested_result_id IS NOT NULL;
-- Aplicar antes do deploy da API e do job. Não modifica bet_results.
BEGIN;
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS score_scope VARCHAR(24) NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS sport VARCHAR(64);
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS home_name TEXT;
ALTER TABLE event_results ADD COLUMN IF NOT EXISTS away_name TEXT;
ALTER TABLE event_results ALTER COLUMN home_score DROP NOT NULL;
ALTER TABLE event_results ALTER COLUMN away_score DROP NOT NULL;
ALTER TABLE bet_settlement_suggestions ADD COLUMN IF NOT EXISTS engine_version VARCHAR(64);
-- Snapshot por evento: metadados de escopo e completude vivem no payload
-- tipado. Snapshot e placar devem ser gravados na MESMA transação/timestamp.
CREATE TABLE IF NOT EXISTS event_facts (
  provider VARCHAR(32) NOT NULL,
  external_id VARCHAR(64) NOT NULL,
  format_version INTEGER NOT NULL DEFAULT 1,
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data_json) = 'object'),
  fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, external_id),
  FOREIGN KEY (provider, external_id) REFERENCES event_results(provider, external_id) ON DELETE CASCADE
);
COMMIT;

-- === Bet events (multipla de varios jogos) ==============================
-- Um evento por confronto, na ordem do mercado. Ver
-- migrations/20260915_bet_events.sql.
CREATE TABLE IF NOT EXISTS bet_events (
  bet_id INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position >= 0),
  confronto TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  external_id VARCHAR(64) NOT NULL,
  start_at TIMESTAMP NOT NULL,
  match_confidence NUMERIC(4,3) NOT NULL,
  PRIMARY KEY (bet_id, position)
);
CREATE INDEX IF NOT EXISTS idx_bet_events_event ON bet_events (provider, external_id);

-- Dashboard e listagem filtram/ordenam por coalesce(event_start_at, bet_time)
-- (ver bet-date.ts); idx_bets_bet_time não serve pra essa expressão.
-- A expressão aqui tem que ser idêntica à do betDate pro planner casar.
CREATE INDEX IF NOT EXISTS idx_bets_user_bet_date ON bets (user_id, (coalesce(event_start_at, bet_time)));

-- Soft delete: apagar aposta so' preenche deleted_at; toda leitura filtra is null.
ALTER TABLE bets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Esporte normalizado (tabela sports, bets.sport_id e trigger que canoniza
-- bets.sport): ver migrations/20260923_sports.sql.

-- Contador de limite de uso (parse-image, /vincular): ver
-- migrations/20260926_rate_limit_hits.sql.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
    bucket VARCHAR(100) NOT NULL,
    window_start TIMESTAMP NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
);

-- Mensalidades do Pro aprovadas no Mercado Pago (webhook): ver
-- migrations/20261019_mercadopago_subscription.sql.
CREATE TABLE IF NOT EXISTS subscription_payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    mp_payment_id VARCHAR(64) NOT NULL UNIQUE,
    mp_preapproval_id VARCHAR(64) NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    pro_until TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_user ON subscription_payments (user_id);

-- Controle das migrations aplicadas (scripts/migrate.cjs).
CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(200) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
