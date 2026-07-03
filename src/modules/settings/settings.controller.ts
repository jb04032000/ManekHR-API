import { Controller, Get, UseGuards } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { AdminService } from '../admin/admin.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly adminService: AdminService) {}

  @Get('default-branding')
  @Public()
  getDefaultBranding() {
    return this.adminService.getDefaultBranding();
  }
}
