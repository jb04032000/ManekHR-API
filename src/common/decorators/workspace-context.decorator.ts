import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const WorkspaceContext = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    // In actual implementation, we'll put the parsed workspace details into request.workspace
    return request.workspace;
  },
);
