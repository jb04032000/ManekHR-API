import { Injectable } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { FirmsService } from '../firms/firms.service';
import { withFinanceSpan } from '../common/finance-observability';

@Injectable()
export class SetupChecklistService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Read-only delegate to FirmsService.getSetupChecklist - span only, no PostHog.
  private readonly tracer = trace.getTracer('finance');

  constructor(private readonly firmsService: FirmsService) {}

  async getChecklist(workspaceId: string, firmId: string): Promise<any[]> {
    return withFinanceSpan(this.tracer, 'finance.getSetupChecklist', { workspaceId, firmId }, () =>
      this.firmsService.getSetupChecklist(workspaceId, firmId),
    );
  }
}
