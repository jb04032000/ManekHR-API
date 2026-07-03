import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PushAdapterService } from './push-adapter.service';
import { UserDevicesController } from './user-devices.controller';
import { UserDevicesService } from './user-devices.service';
import { UserDevice, UserDeviceSchema } from './schemas/user-device.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: UserDevice.name, schema: UserDeviceSchema }])],
  controllers: [UserDevicesController],
  providers: [UserDevicesService, PushAdapterService],
  exports: [UserDevicesService],
})
export class UserDevicesModule {}
