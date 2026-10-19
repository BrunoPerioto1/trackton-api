import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { JwtPayload } from '../../auth/jwt/jwt-payload';
import { ProRequiredException } from '../../users/plan';

/**
 * Recurso do Pro. Sempre depois do AuthGuard('jwt') no mesmo @UseGuards: o
 * `pro` vem do JwtStrategy.validate, que já leu a conta do banco nesta mesma
 * request — aqui não precisa de outro SELECT.
 */
@Injectable()
export class ProGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (!user?.pro) throw new ProRequiredException();
    return true;
  }
}
