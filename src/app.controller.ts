import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { LegacyUnclassified } from './common/decorators/legacy-unclassified.decorator';

@LegacyUnclassified()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
