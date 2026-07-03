import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditService } from './audit.service';
import { AuditEvent, AuditEventSchema } from './schemas/audit-event.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Workspace, WorkspaceSchema } from '../workspaces/schemas/workspace.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditEvent.name, schema: AuditEventSchema },
      { name: User.name, schema: UserSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
    ]),
  ],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
