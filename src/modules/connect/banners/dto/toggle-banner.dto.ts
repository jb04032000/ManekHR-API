import { IsBoolean } from 'class-validator';

/** Body for `PUT /admin/connect/banners/:id/toggle`. */
export class ToggleBannerDto {
  @IsBoolean()
  isActive: boolean;
}
