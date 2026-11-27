-- Verificador de acesso: o que cada casa exige x o que o usuário tem.
-- Casa: NULL = não informado (o bot não avisa nada sobre aquele item).
--   requires_vpn   casa só abre com IP fora do Brasil
--   accepts_pix    aceita depósito em reais por PIX
--   accepts_crypto aceita depósito em cripto
-- Usuário: o que ele tem disponível, marcado no Perfil do app.
-- Nullable / default false: não reescreve as tabelas.
BEGIN;
ALTER TABLE betting_houses ADD COLUMN IF NOT EXISTS requires_vpn BOOLEAN;
ALTER TABLE betting_houses ADD COLUMN IF NOT EXISTS accepts_pix BOOLEAN;
ALTER TABLE betting_houses ADD COLUMN IF NOT EXISTS accepts_crypto BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_vpn BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_crypto BOOLEAN NOT NULL DEFAULT FALSE;
COMMIT;
