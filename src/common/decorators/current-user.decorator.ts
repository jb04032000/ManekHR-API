import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Inject the authenticated user from the request.
 *   `@CurrentUser() user: { sub, email, ... }` — full user object
 *   `@CurrentUser('sub') userId: string`       — single field (e.g. user id)
 *
 * Honoring the data argument is required by call sites like
 * `sessions.controller.ts` which expect a primitive `userId` and pass the
 * result straight into `new Types.ObjectId(userId)`. Returning the whole
 * user object there throws BSONError at the ObjectId constructor.
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
