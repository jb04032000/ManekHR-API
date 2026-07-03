import { registerAs } from '@nestjs/config';
import { env } from './env';

export default registerAs('google', () => ({
  clientId: env.googleOAuth.clientId,
  clientSecret: env.googleOAuth.clientSecret,
}));
