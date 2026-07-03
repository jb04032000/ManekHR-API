import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PushModule } from '../finance/reminders/adapters/push.module';
import { UserDevicesController } from './user-devices.controller';
import { UserDevicesService } from './user-devices.service';
import { UserDevice, UserDeviceSchema } from './schemas/user-device.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: UserDevice.name, schema: UserDeviceSchema }]),
    PushModule,
  ],
  controllers: [UserDevicesController],
  providers: [UserDevicesService],
  exports: [UserDevicesService],
})
export class UserDevicesModule {}
