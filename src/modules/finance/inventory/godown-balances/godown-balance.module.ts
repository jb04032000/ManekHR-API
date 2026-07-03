import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  GodownBalance,
  GodownBalanceSchema,
} from './godown-balance.schema';
import { GodownBalanceService } from './godown-balance.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GodownBalance.name, schema: GodownBalanceSchema },
    ]),
  ],
  providers: [GodownBalanceService],
  exports: [GodownBalanceService],
})
export class GodownBalanceModule {}
