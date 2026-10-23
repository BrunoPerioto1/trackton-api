import {
  EmailContent,
  emailButton,
  emailLayout,
  emailStyles,
  escapeHtml,
} from './layout';

/** E-mail do "Esqueci a senha": botão pro link e o mesmo link em texto. */
export function passwordResetEmail({
  resetUrl,
  validMinutes,
}: {
  resetUrl: string;
  validMinutes: number;
}): EmailContent {
  const subject = 'Redefinir sua senha do Trackton';
  const footer =
    'Você recebeu este e-mail porque pediram pra redefinir a senha da conta ligada a este endereço.';

  const body = `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:${emailStyles.text};">Redefinir sua senha</h1>
<p style="margin:0;">Recebemos um pedido pra trocar a senha da sua conta no Trackton. Use o botão abaixo pra escolher uma senha nova.</p>
${emailButton('Redefinir senha', resetUrl)}
<p style="margin:0 0 6px;font-size:13px;color:${emailStyles.muted};">Se o botão não abrir, copie e cole este endereço no navegador:</p>
<p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${escapeHtml(resetUrl)}" target="_blank" style="color:${emailStyles.blue};">${escapeHtml(resetUrl)}</a></p>
<p style="margin:0;padding-top:20px;border-top:1px solid ${emailStyles.border};font-size:13px;color:${emailStyles.muted};">
O link vale por ${validMinutes} minutos e só funciona uma vez. Não foi você? Ignore este e-mail: sua senha continua a mesma. Não compartilhe este link com ninguém.
</p>`;

  const text = [
    'Redefinir sua senha',
    '',
    'Recebemos um pedido pra trocar a senha da sua conta no Trackton. Abra o link abaixo pra escolher uma senha nova:',
    '',
    resetUrl,
    '',
    `O link vale por ${validMinutes} minutos e só funciona uma vez. Não foi você? Ignore este e-mail: sua senha continua a mesma. Não compartilhe este link com ninguém.`,
    '',
    '—',
    footer,
    'Trackton · Controle de apostas',
  ].join('\n');

  return {
    subject,
    html: emailLayout({
      title: subject,
      preheader: `Link pra escolher uma senha nova. Vale ${validMinutes} minutos.`,
      body,
      footer,
    }),
    text,
  };
}
