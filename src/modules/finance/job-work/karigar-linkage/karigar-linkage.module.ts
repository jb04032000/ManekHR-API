import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { KarigarLinkage, KarigarLinkageSchema } from './karigar-linkage.schema';
import { KarigarLinkageService } from './karigar-linkage.service';
import { TeamModule } from '../../../team/team.module';

/**
 * Shape A — TeamModule exports MongooseModule, so we import TeamModule
 * to gain access to the TeamMember model without re-registering it.
 * This avoids duplicate schema registration errors.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: KarigarLinkage.name, schema: KarigarLinkageSchema },
    ]),
    forwardRef(() => TeamModule),
  ],
  providers: [KarigarLinkageService],
  exports: [KarigarLinkageService, MongooseModule],
})
export class KarigarLinkageModule {}
