import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EInvoiceService } from './einvoice.service';

/**
 * BullMQ WorkerHost for the 'einvoice-retry' queue.
 * T-F02-04-05: attempts:3 + exponential backoff (60s base) → at most 3 retries
 * spread over ~30 min; per-job queue ensures one firm's outage doesn't stall others.
 */
@Processor('einvoice-retry')
export class EInvoiceRetryProcessor extends WorkerHost {
  private readonly logger = new Logger(EInvoiceRetryProcessor.name);

  constructor(private readonly einvoiceService: EInvoiceService) {
    super();
  }

  async process(
    job: Job<{ invoiceId: string; firmId: string; wsId: string }>,
  ): Promise<void> {
    this.logger.log(
      `Retry attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 3} for invoice ${job.data.invoiceId}`,
    );

    // CR-04: Guard against re-submitting an invoice that already has an IRN.
    // A prior attempt may have succeeded at NIC but the success response was lost;
    // re-submitting would cause a duplicate IRN error and exhaust retry slots.
    const invoice = await this.einvoiceService.findOneInvoice(
      job.data.wsId,
      job.data.firmId,
      job.data.invoiceId,
    );
    if ((invoice as any).eInvoice?.status === 'generated') {
      this.logger.log(
        `Invoice ${job.data.invoiceId} already has IRN — skipping retry`,
      );
      return;
    }

    await this.einvoiceService.generateIrn(
      job.data.wsId,
      job.data.firmId,
      job.data.invoiceId,
    );
  }
}
