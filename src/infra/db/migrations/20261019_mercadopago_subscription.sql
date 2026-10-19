-- Aplicar antes do deploy da API: o /users/me, a tela Plano e o webhook do
-- Mercado Pago passam a ler estas colunas. Nullable, nao reescreve a tabela.
--
-- mp_preapproval_id: a assinatura (preapproval) mais recente da conta no
--   Mercado Pago. E' por ela que o webhook acha o dono e o cancelamento acha
--   o que cancelar.
-- subscription_status: o status dela la' (pending, authorized, paused,
--   cancelled). NULL = nunca assinou. Quem decide o Pro continua sendo o
--   access_until; isto so' diz se tem cobranca automatica rodando.
-- subscription_payments: cada mensalidade aprovada que o webhook recebeu. O id
--   do pagamento e' unico: notificacao repetida nao conta duas vezes. Conta
--   excluida deixa o historico (user_id vira NULL) pra conciliar o extrato.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_preapproval_id VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mp_preapproval_id ON users (mp_preapproval_id);

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
COMMIT;
