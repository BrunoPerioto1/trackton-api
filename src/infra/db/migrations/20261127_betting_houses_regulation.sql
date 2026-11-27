-- Aplicar antes do deploy da API: admin e /house/all leem a coluna.
--
-- Depois da MP que tirou as bets do ar, as tips passaram a vir de casas de
-- fora (Cloudbet, Stake.com, 99play...). `regulation` separa as duas:
--   federal  = autorizada pela SPA/MF (site .bet.br, ou judicial tipo zeroum.bet)
--   offshore = casa estrangeira, site em qualquer domínio cadastrado à mão
-- Default federal: tudo que já existe é .bet.br.
BEGIN;
ALTER TABLE betting_houses
  ADD COLUMN IF NOT EXISTS regulation TEXT NOT NULL DEFAULT 'federal';
ALTER TABLE betting_houses DROP CONSTRAINT IF EXISTS betting_houses_regulation_check;
ALTER TABLE betting_houses
  ADD CONSTRAINT betting_houses_regulation_check CHECK (regulation IN ('federal', 'offshore'));
COMMIT;
