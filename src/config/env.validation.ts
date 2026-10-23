// Conferido uma vez, no boot (ConfigModule). Antes cada arquivo chamava
// dotenv.config() por conta própria e uma env faltando só aparecia quando a
// primeira request batia no código que a usava — ou nunca, se ela caísse num
// valor padrão silencioso.

// Sem estas a API não tem como funcionar: banco, login e bot.
const REQUIRED = ['DB_HOST', 'DB_USER', 'DB_NAME', 'JWT_SECRET', 'TELEGRAM_BOT_TOKEN'] as const;
const NUMERIC = ['DB_PORT', 'ACCESS_PRICE', 'TRIAL_DAYS'] as const;
const URLS = ['FRONT_URL', 'APP_URL'] as const;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const problems: string[] = [];
  const text = (key: string) => (typeof config[key] === 'string' ? (config[key]).trim() : '');

  for (const key of REQUIRED) if (!text(key)) problems.push(`${key} não definida`);

  for (const key of NUMERIC) {
    if (text(key) && !Number.isFinite(Number(text(key)))) problems.push(`${key} precisa ser número`);
  }

  for (const key of URLS) {
    if (!text(key)) continue;
    try {
      new URL(text(key));
    } catch {
      problems.push(`${key} não é uma URL válida`);
    }
  }

  // E-mail é opcional no boot (sem ele só o "Esqueci a senha" responde 503),
  // mas se veio tem que ter um endereço: "x@dominio" ou "Nome <x@dominio>".
  const mailFrom = text('MAIL_FROM');
  if (mailFrom && !/^(?:[^<>]*<\s*)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>?$/.test(mailFrom)) {
    problems.push('MAIL_FROM precisa ser um e-mail ("nao-responda@dominio" ou "Trackton <nao-responda@dominio>")');
  }

  // Formato que o Telegram aceita no secret_token do setWebhook.
  const webhookSecret = text('TELEGRAM_WEBHOOK_SECRET');
  if (webhookSecret && !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
    problems.push('TELEGRAM_WEBHOOK_SECRET: 16 a 256 caracteres, só letras, números, _ e -');
  }

  if (problems.length) {
    throw new Error(`Configuração inválida (.env / variáveis da Vercel):\n- ${problems.join('\n- ')}`);
  }
  return config;
}
