import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Serial, SerialSchema } from './serial.schema';
import { SerialsService } from './serials.service';
import { SerialsController } from './serials.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Serial.name, schema: SerialSchema }]),
  ],
  providers: [SerialsService],
  controllers: [SerialsController],
  exports: [SerialsService],
})
export class SerialsModule {}
