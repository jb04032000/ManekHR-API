import { AppModule, ModuleAction } from '../../../common/enums/modules.enum';
import { PermissionDto } from '../dto/rbac.dto';

export const hasPermission = (
  permissions: PermissionDto[],
  requiredModule: AppModule,
  requiredAction: ModuleAction,
): boolean => {
  const modulePerms = permissions.find((p) => p.module === requiredModule);
  if (!modulePerms) return false;
  return modulePerms.actions.includes(requiredAction);
};
