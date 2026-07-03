import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Godown, GodownSchema } from './godown.schema';
import { GodownsService } from './godowns.service';
import { GodownsController } from './godowns.controller';
import { GodownBalanceModule } from '../godown-balances/godown-balance.module';
import { WorkspacesModule } from '../../../workspaces/workspaces.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Godown.name, schema: GodownSchema }]),
    WorkspacesModule, // provides WorkspaceCounterService
    GodownBalanceModule, // provides GodownBalanceService for delete guard
  ],
  providers: [GodownsService],
  controllers: [GodownsController],
  exports: [GodownsService],
})
export class GodownsModule {}
