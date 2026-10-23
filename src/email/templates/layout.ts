import { frontUrl } from '../../common/utils/front-url';

/** O que cada template devolve: assunto e as duas versões do corpo. */
export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

// Cores da marca (DESIGN.md do front): o azul do bilhete conferido. O e-mail é
// claro mesmo com o app escuro: fundo escuro em e-mail quebra em metade dos
// clientes, que invertem ou ignoram a cor.
const BRAND_BLUE = '#2563eb';
const TEXT = '#18181b';
const MUTED = '#71717a';
const BORDER = '#e4e4e7';
const PAGE = '#f4f4f5';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Botão de ação: tabela e estilo inline, que é o que o Outlook e o Gmail respeitam. */
export function emailButton(label: string, href: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
  <tr><td style="border-radius:8px;background:${BRAND_BLUE};">
    <a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

export const emailStyles = {
  text: TEXT,
  muted: MUTED,
  border: BORDER,
  blue: BRAND_BLUE,
};

/**
 * Casca de todo e-mail: logo e nome no topo, o conteúdo num cartão branco e o
 * rodapé. `preheader` é a linha que a caixa de entrada mostra ao lado do assunto.
 */
export function emailLayout({
  title,
  preheader,
  body,
  footer,
}: {
  title: string;
  preheader: string;
  body: string;
  footer: string;
}): string {
  // O ícone é o mesmo do app (public/icon-192.png do front). Cliente que
  // bloqueia imagem mostra só o nome ao lado, que já identifica.
  const logo = frontUrl('/icon-192.png');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${PAGE};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:480px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="padding:0 4px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
          <td style="padding-right:10px;"><img src="${escapeHtml(logo)}" width="32" height="32" alt="" style="display:block;border:0;border-radius:8px;"></td>
          <td style="font-size:18px;font-weight:700;color:${TEXT};letter-spacing:-0.01em;">Trackton</td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid ${BORDER};border-radius:12px;padding:32px 28px;color:${TEXT};font-size:15px;line-height:1.55;">
${body}
      </td></tr>
      <tr><td style="padding:20px 4px 0;font-size:12px;line-height:1.5;color:${MUTED};">
        ${footer}<br>
        Trackton · Controle de apostas
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
