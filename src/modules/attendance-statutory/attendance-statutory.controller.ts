import { Body, Controller, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AttendanceStatutoryService } from './attendance-statutory.service';
import { GenerateStatutoryDto } from './dto/generate-statutory.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SubscriptionGuard, RequireSubscription } from '../../common/guards/subscription.guard';
import { AppModule } from '../../common/enums/modules.enum';

@Controller('workspaces/:workspaceId/attendance/statutory')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
export class AttendanceStatutoryController {
  constructor(private readonly service: AttendanceStatutoryService) {}

  @Post('generate')
  @RequirePermission('attendance.export.export')
  @RequireSubscription({ module: AppModule.ATTENDANCE, subFeature: 'statutory_exports' })
  async generate(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: GenerateStatutoryDto,
    @Req() req: { user?: { name?: string; email?: string } },
    @Res() res: Response,
  ): Promise<void> {
    const generatedByName = req.user?.name ?? req.user?.email;
    const { buffer, filename, mimeType } = await this.service.generate(
      workspaceId,
      dto,
      generatedByName,
    );
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.length),
    });
    res.end(buffer);
  }
}
