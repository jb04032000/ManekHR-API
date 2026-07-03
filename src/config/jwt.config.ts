import { registerAs } from '@nestjs/config';
import { env } from './env';

export default registerAs('jwt', () => ({
  accessSecret: env.jwt.accessSecret,
  accessExpiry: env.jwt.accessExpiry,
  refreshSecret: env.jwt.refreshSecret,
  refreshExpiry: env.jwt.refreshExpiry,
}));
