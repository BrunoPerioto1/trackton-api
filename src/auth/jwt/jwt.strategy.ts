import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { UsersRepository } from "../../infra/repository/users.repository";
import type { UserId } from "../../db_types/Users";
import { assertAccess } from "../../users/access";
import { isPro } from "../../users/plan";
import type { JwtPayload } from "./jwt-payload";
import { sessionVersion } from "./session-version";




@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly usersRepository: UsersRepository) {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error("JWT_SECRET is not defined in environment variables");
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: jwtSecret,
      algorithms: ["HS256"],
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    const currentTimestamp = Date.now() / 1000;
    if (payload.exp !== undefined && payload.exp < currentTimestamp) {
      throw new UnauthorizedException("TokenExpiredError");
    }
    // Um SELECT por PK por request: o token vale 1d e quem vence/é desativado
    // tem que cair na hora, não no dia seguinte.
    const user = await this.usersRepository.findById(payload.userId as UserId);
    if (!user) throw new UnauthorizedException();
    // Senha trocada derruba os tokens de antes da troca. Fica antes da
    // checagem de acesso de propósito: token que não vale mais cai no login,
    // não no aviso de conta desativada.
    if (payload.sv !== sessionVersion(user.passwordHash)) throw new UnauthorizedException();
    assertAccess(user);
    return { ...payload, pro: isPro(user) };
  }
}
