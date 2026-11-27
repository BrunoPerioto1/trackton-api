// Desde as casas offshore o canal manda "🚦 Limite da aposta: US$8,70
// (R$50,00)". A banca do usuário é em reais, então vale o R$ entre
// parênteses; o US$ nunca pode ser lido como real. Linha só em US$ (ou
// "US$??,00") não tem limite em R$ → null, sem chutar conversão.
export function extractLimitFromText(text: string): number | null {
  if (!text) return null;
  const limitLine =
    text.match(/^.*🚦.*$/m)?.[0] ??
    text.match(/^.*\b(limite|limit|max|máximo)\b.*$/im)?.[0];
  if (limitLine && /US\$/i.test(limitLine)) {
    const brl = limitLine.match(/R\$\s*([\d.,]+)/);
    return brl ? parseMoney(brl[1]) : null;
  }

  const limitEmojiRegex = /🚦[^0-9]{0,15}([\d.,]+)/i;
  const wordsRegex = /(limite|limit|max|máximo)[^0-9]{0,15}([\d.,]+)/i;
  const m1 = text.match(limitEmojiRegex);
  const m2 = text.match(wordsRegex);
  const raw = (m1?.[1] || m2?.[2] || '').trim();
  if (!raw) return null;

  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.') // Caso brasileiro
    : raw; // Caso internacional

  const val = Number(normalized);
  return Number.isFinite(val) && val > 0 ? val : null;
}

export function isAvisoMessage(text: string): boolean {
  if (!text) return false;
  return /\b(SOBRECARGA|AVISO)\b/i.test(text);
}

// Mensagens de SOBRECARGA/AVISO vêm num template diferente — texto puro,
// sem 🏠/🆚/🏷 nenhum — mas sempre na mesma ordem depois da palavra-chave:
// casa, jogo, esporte, mercado, odd. Serve de fallback pros extractors acima
// quando o regex com emoji não bate.
function getAvisoLines(text: string): string[] | null {
  if (!isAvisoMessage(text)) return null;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const markerIndex = lines.findIndex((l) => /\b(SOBRECARGA|AVISO)\b/i.test(l));
  if (markerIndex === -1) return null;
  return lines.slice(markerIndex + 1);
}

export function extractOddFromText(text: string): number | null {
  if (!text) return null;
  const m = text.match(/🏷\s*([\d]+(?:[.,][\d]+)?)/);
  const raw = m?.[1] ?? getAvisoLines(text)?.[4];
  if (!raw) return null;
  const val = Number(raw.replace(',', '.'));
  return Number.isFinite(val) && val > 1 ? val : null;
}

export function extractHouseFromText(text: string): string | null {
  if (!text) return null;
  const m = text.match(/^🏠\s*(.+)$/m);
  return m ? m[1].trim() : (getAvisoLines(text)?.[0] ?? null);
}

export function extractGameFromText(text: string): string | null {
  if (!text) return null;
  const m = text.match(/^🆚\s*(.+)$/m);
  return m ? m[1].trim() : (getAvisoLines(text)?.[1] ?? null);
}

export function extractMarketFromText(text: string): string | null {
  if (!text) return null;
  const m = text.match(/^📌\s*(.+)$/m);
  return m ? m[1].trim() : (getAvisoLines(text)?.[3] ?? null);
}

export function extractLinkFromText(text: string): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}

// O "Odd mudou? Clique AQUI e calcule quanto vale" é um text_link: a URL do
// calculador (calc.peixeesperto.com.br/?justa=X) só existe em `entities`,
// nunca no texto puro — por isso extractLinkFromText não a enxerga (e pegaria
// o link da casa, que vem antes). Pega SÓ essa: primeiro pela URL do
// calculador, e se o domínio mudar, pelo texto que o link cobre.
const CALC_LINK_HOST = /^https?:\/\/(?:[\w-]+\.)*peixeesperto\.com\.br\b/i;
const CALC_LINK_LABEL = /odd mudou|calcule quanto vale|quanto vale/i;

export function extractCalcLinkFromEntities(
  text: string,
  entities:
    | { type: string; offset: number; length: number; url?: string }[]
    | null
    | undefined,
): string | null {
  const links = (Array.isArray(entities) ? entities : []).filter(
    (e) => e.type === 'text_link' && typeof e.url === 'string',
  );

  const byHost = links.find((e) => CALC_LINK_HOST.test(e.url as string));
  if (byHost) return byHost.url as string;

  const byLabel = links.find((e) =>
    CALC_LINK_LABEL.test((text ?? '').slice(e.offset, e.offset + e.length)),
  );
  if (byLabel) return byLabel.url as string;

  // Fallback pro caso raro da URL vir colada no texto em vez de embutida.
  const raw = (text ?? '').match(/https?:\/\/\S*peixeesperto\.com\.br\S*/i);
  return raw ? raw[0] : null;
}

export function extractPercent(text: string): number | null {
  if (!text) return null;

  // O emoji usado antes do percentual varia por ADM/fonte (🛑, 🔴, etc.) e o
  // formato SOBRECARGA/AVISO nem tem emoji — então não fixa em nenhum
  // específico: aceita qualquer linha que seja só "[algo curto] número%".
  const standaloneLineRegex =
    /^[^\n%\d]{0,6}(\d{1,3}(?:[.,]\d{1,2})?)[ \t]*%[ \t]*$/m;
  let m = text.match(standaloneLineRegex);

  if (!m) {
    // Último recurso: pega o primeiro "número%" em qualquer lugar do texto.
    m = text.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s*%/);
  }
  if (!m) return null;

  const raw = m[1];
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;

  const val = Number(normalized);
  return Number.isFinite(val) && val >= 0 ? val : null;
}

export function extractSportFromText(text: string): string | null {
  if (!text) return null;
  const m = text.match(/^⚽\ufe0f?\s*(.+)$/m);
  return m ? m[1].trim() : (getAvisoLines(text)?.[2] ?? null);
}

// Parse 100% local dos 4 campos que a IA extraía. Cobre os dois formatos
// (emoji e SOBRECARGA/AVISO). Retorna null se faltar qualquer campo — aí o
// chamador cai pro Groq.
export function parseBetLocal(
  text: string,
): { game: string; sport: string; market: string; odd: number } | null {
  const game = extractGameFromText(text);
  const sport = extractSportFromText(text);
  const market = extractMarketFromText(text);
  const odd = extractOddFromText(text);
  if (!game || !sport || !market || odd === null) return null;
  return { game, sport, market, odd };
}

// Stake absoluta em R$ — só existe nos cards gerados a partir de print
// (fluxo de imagem), onde o valor apostado já vem pronto em vez de uma %.
// Casa o rótulo inteiro de propósito: card de tip tem "💰 Lucro potencial:
// R$ X", que NÃO é stake e não pode ser confundido com uma.
export function extractStakeFromText(text: string): number | null {
  return matchMoneyLine(text, /^💰\s*Stake:\s*R?\$?\s*([\d.,]+)/im);
}

// A stake de verdade da tip: linha que o fan-out acrescenta na cópia enviada
// pro usuário, já com a banca dele aplicada. O 💰 sem rótulo que vem do canal
// NÃO é isso — o valor certo é sempre esta última recomendação.
export function extractRecommendedStakeFromText(text: string): number | null {
  return matchMoneyLine(
    text,
    /^🎯\s*Recomendação de aposta:\s*R?\$?\s*([\d.,]+)/im,
  );
}

export function extractPotentialProfitFromText(text: string): number | null {
  return matchMoneyLine(text, /^💰\s*Lucro potencial:\s*R?\$?\s*([\d.,]+)/im);
}

/**
 * Campo da tip como o usuário vê: a cópia entregue no privado
 * (tip_deliveries.text) vence o texto do canal, porque o "✏️ Editar" do bot
 * muda odd, limite e casa nela. Campo que não aparece na cópia cai no canal.
 */
export function fromDelivery<T>(
  deliveryText: string | null | undefined,
  channelText: string,
  extract: (text: string) => T | null,
): T | null {
  return (deliveryText ? extract(deliveryText) : null) ?? extract(channelText);
}

function matchMoneyLine(text: string, regex: RegExp): number | null {
  const m = text?.match(regex);
  if (!m) return null;
  return parseMoney(m[1]);
}

function parseMoney(raw: string): number | null {
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  const val = Number(normalized);
  return Number.isFinite(val) && val > 0 ? val : null;
}
