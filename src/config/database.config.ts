import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModuleAsyncOptions } from '@nestjs/mongoose';

export const databaseConfig: MongooseModuleAsyncOptions = {
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({
    uri:
      configService.get<string>('MONGODB_URI') ||
      'mongodb://localhost:27017/manekhr',
  }),
  inject: [ConfigService],
};
