import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PushAdapterService } from './push-adapter.service';
import { UserDevice } from './schemas/user-device.schema';
import { RegisterDeviceDto } from './dto/register-device.dto';

interface PushUserPayload {
  title: string;
  body: string;
  /**
   * Free-form key/value bag delivered alongside the visible notification.
   * Mobile clients consume it from `RemoteMessage.data` for routing /
   * deep-linking. Values must be strings (FCM constraint); cast non-strings
   * before passing in.
   */
  data?: Record<string, string>;
}

interface PushUserResult {
  /** How many tokens were attempted. */
  attempted: number;
  /** How many sends succeeded. */
  sent: number;
  /** Tokens removed because FCM reported them dead. */
  pruned: number;
}

@Injectable()
export class UserDevicesService {
  private readonly logger = new Logger(UserDevicesService.name);

  constructor(
    @InjectModel(UserDevice.name)
    private readonly deviceModel: Model<UserDevice>,
    private readonly push: PushAdapterService,
  ) {}

  /**
   * Upsert (userId, fcmToken). If the same FCM token previously belonged to a
   * different user (e.g. account switch on the same device), the row is
   * reassigned so we don't deliver one user's pushes to another.
   */
  async registerDevice(userId: string, dto: RegisterDeviceDto): Promise<UserDevice> {
    const userObjectId = new Types.ObjectId(userId);
    const now = new Date();

    const device = await this.deviceModel
      .findOneAndUpdate(
        { fcmToken: dto.fcmToken },
        {
          $set: {
            userId: userObjectId,
            platform: dto.platform,
            deviceName: dto.deviceName,
            appVersion: dto.appVersion,
            lastUsedAt: now,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    return device;
  }

  async listDevices(userId: string): Promise<UserDevice[]> {
    return this.deviceModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ lastUsedAt: -1 })
      .exec();
  }

  /** A user's WEB push targets only (browser/PWA). Used by the
   *  notifications `browser_push` channel so a browser push never goes to the
   *  mobile app's token (and vice-versa). */
  async listWebDevices(userId: string): Promise<UserDevice[]> {
    return this.deviceModel
      .find({ userId: new Types.ObjectId(userId), platform: 'web' })
      .sort({ lastUsedAt: -1 })
      .exec();
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    const result = await this.deviceModel
      .deleteOne({
        _id: new Types.ObjectId(deviceId),
        userId: new Types.ObjectId(userId),
      })
      .exec();
    if (result.deletedCount === 0) {
      throw new NotFoundException('Device not found');
    }
  }

  async revokeAll(userId: string): Promise<{ deletedCount: number }> {
    const result = await this.deviceModel.deleteMany({ userId: new Types.ObjectId(userId) }).exec();
    return { deletedCount: result.deletedCount ?? 0 };
  }

  /**
   * Fan-out a user-targeted push to every device the user has registered.
   * Dead tokens (FCM `registration-token-not-registered`) are pruned so they
   * don't pile up; the caller still gets the per-device counts.
   */
  async pushUser(userId: string, payload: PushUserPayload): Promise<PushUserResult> {
    const devices = await this.listDevices(userId);
    if (devices.length === 0) {
      return { attempted: 0, sent: 0, pruned: 0 };
    }

    const results = await Promise.all(
      devices.map(async (d) => {
        const res = await this.push.sendUserPush({
          token: d.fcmToken,
          title: payload.title,
          body: payload.body,
          data: payload.data,
        });
        return { device: d, res };
      }),
    );

    const deadTokens = results
      .filter(
        (r) =>
          !r.res.success &&
          (r.res.errorCode === 'messaging/registration-token-not-registered' ||
            r.res.errorCode === 'messaging/invalid-registration-token'),
      )
      .map((r) => r.device.fcmToken);

    let pruned = 0;
    if (deadTokens.length > 0) {
      const del = await this.deviceModel.deleteMany({ fcmToken: { $in: deadTokens } }).exec();
      pruned = del.deletedCount ?? 0;
      this.logger.log(`Pruned ${pruned} dead FCM token(s) for user ${userId}`);
    }

    return {
      attempted: results.length,
      sent: results.filter((r) => r.res.success).length,
      pruned,
    };
  }

  /**
   * Fan-out a user-targeted push to the user's WEB devices only. Same prune
   * behaviour as `pushUser` (dead FCM tokens are deleted) but scoped to
   * `platform: 'web'`. Cross-module: called by
   * notifications `BrowserPushChannel.send`.
   */
  async pushUserWeb(userId: string, payload: PushUserPayload): Promise<PushUserResult> {
    const devices = await this.listWebDevices(userId);
    if (devices.length === 0) {
      return { attempted: 0, sent: 0, pruned: 0 };
    }

    const results = await Promise.all(
      devices.map(async (d) => {
        const res = await this.push.sendUserPush({
          token: d.fcmToken,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          // Browser tokens get a DATA-ONLY message so the FCM SDK does not
          // auto-display a second notification on top of the one our service
          // worker renders (see PushAdapter.sendUserPush dataOnly note).
          dataOnly: true,
        });
        return { device: d, res };
      }),
    );

    const deadTokens = results
      .filter(
        (r) =>
          !r.res.success &&
          (r.res.errorCode === 'messaging/registration-token-not-registered' ||
            r.res.errorCode === 'messaging/invalid-registration-token'),
      )
      .map((r) => r.device.fcmToken);

    let pruned = 0;
    if (deadTokens.length > 0) {
      const del = await this.deviceModel.deleteMany({ fcmToken: { $in: deadTokens } }).exec();
      pruned = del.deletedCount ?? 0;
      this.logger.log(`Pruned ${pruned} dead web FCM token(s) for user ${userId}`);
    }

    return {
      attempted: results.length,
      sent: results.filter((r) => r.res.success).length,
      pruned,
    };
  }
}
