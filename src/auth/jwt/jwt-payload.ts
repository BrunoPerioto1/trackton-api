// O que vai no token (AuthService.login) e volta em `req.user` depois do
// JwtStrategy.validate. Quem decide acesso é o banco; isto só identifica.
export interface JwtPayload {
  userId: number;
  email: string;
  name: string;
  roleId: number;
  // Versão da sessão (session-version.ts). Token sem ela é de antes da regra
  // e não vale mais.
  sv?: string;
  iat?: number;
  exp?: number;
  // Não vai no token: o JwtStrategy.validate preenche a cada request, lido do
  // banco. É o que o ProGuard e a cota de IA consultam sem outro SELECT.
  pro?: boolean;
}
