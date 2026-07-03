import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { PortalContext as PortalCtx } from '../portal-token.service';

/**
 * @PortalContext() handler-param decorator — extracts the portal context
 * (`{ jti, wsId, firmId, partyId, scope }`) attached by PortalTokenGuard.
 */
export const PortalContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PortalCtx => {
    const req = ctx.switchToHttp().getRequest();
    return req.portalContext;
  },
);
