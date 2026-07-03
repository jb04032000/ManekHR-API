import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { SessionsService } from '../../modules/sessions/sessions.service';

declare global {
  namespace Express {
    interface Request {
      _sessionTokenHash?: string;
    }
  }
}

@Injectable()
export class SessionActivityMiddleware implements NestMiddleware {
  private lastUpdateTime: Map<string, number> = new Map();
  private readonly THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private sessionsService: SessionsService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const user = req.user as { sub?: string };

    if (!user?.sub) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    req._sessionTokenHash = tokenHash;

    const now = Date.now();
    const lastUpdate = this.lastUpdateTime.get(tokenHash) || 0;

    if (now - lastUpdate >= this.THROTTLE_MS) {
      this.lastUpdateTime.set(tokenHash, now);

      this.sessionsService.updateLastActive(tokenHash).catch((error) => {
        console.error(
          '[SessionActivity] Failed to update lastActiveAt:',
          error?.message,
        );
      });
    }

    next();
  }
}
