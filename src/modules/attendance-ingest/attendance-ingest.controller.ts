import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  Res,
  UsePipes,
  ValidationPipe,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AttendanceIngestService } from './attendance-ingest.service';

/**
 * ADMS ingest controller — handles ZKTeco/eSSL/Realtime/Biomax device pushes.
 *
 * CRITICAL: All handlers use @Res() to bypass the global ResponseInterceptor
 * and respond with raw text/plain (T-B-02-06). Do NOT return values from handlers.
 *
 * Route prefix: /iclock — outside /workspaces/* and JwtGuard scope.
 * @Public() ensures JwtAuthGuard is skipped for all routes in this controller.
 */
@Controller('iclock')
@Public()
@UsePipes(new ValidationPipe({ forbidNonWhitelisted: false }))
export class AttendanceIngestController {
  private readonly logger = new Logger(AttendanceIngestController.name);

  constructor(private readonly ingestService: AttendanceIngestService) {}

  /**
   * Sanitise the raw SN query parameter.
   * Strips control characters and caps length to prevent log injection (CR-02).
   * Returns an empty string if the value is not a string.
   */
  private sanitiseSN(raw: string | undefined): string {
    if (typeof raw !== 'string') return '';
    // Strip all ASCII control characters (\x00–\x1f and \x7f) and cap at 64 chars
    return raw.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);
  }

  /**
   * GET /iclock/:wsToken/cdata?SN=X&pushver=2&language=0
   * Device handshake — validates token, auto-registers device if needed,
   * responds with ADMS option block (text/plain).
   */
  @Get(':wsToken/cdata')
  async handshake(
    @Param('wsToken') wsToken: string,
    @Query('SN') sn: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Sanitise SN before any use in logs or downstream calls (CR-02)
    const serial = this.sanitiseSN(sn);
    if (!serial) {
      res.status(400).type('text/plain').send('BAD REQUEST\n');
      return;
    }

    const wsId = await this.ingestService.resolveToken(wsToken);

    if (!wsId) {
      this.logger.warn(
        `[ADMS] Handshake rejected for SN=${serial} token=***${wsToken.slice(-8)}`,
      );
      await this.ingestService.writeIngestLog({
        wsId: null,
        deviceSerial: serial,
        method: 'GET',
        table: null,
        bodyBytes: 0,
        responseStatus: 403,
        error: 'invalid_token',
      });
      res.status(403).type('text/plain').send('UNAUTHORIZED\n');
      return;
    }

    await this.ingestService.handleHandshake(wsId, serial);

    this.logger.log(`[ADMS] Handshake OK ws=${wsId} SN=${serial}`);

    await this.ingestService.writeIngestLog({
      wsId,
      deviceSerial: serial,
      method: 'GET',
      table: null,
      bodyBytes: 0,
      responseStatus: 200,
    });

    // ADMS handshake response (D-14)
    const body = [
      `GET OPTION FROM: ${serial}`,
      'ATTLOGStamp=9999',
      'OPERLOGStamp=9999',
      'ATTPHOTOStamp=9999',
      'ErrorDelay=60',
      'Delay=30',
      'TransTimes=00:00;14:05',
      'TimeZone=5.5',
      'Realtime=1',
      'Encrypt=None',
      '',
    ].join('\n');

    res.type('text/plain').send(body);
  }

  /**
   * POST /iclock/:wsToken/cdata?table=ATTLOG&SN=X
   * Receives ATTLOG (or USER / OPERLOG) payload from device.
   * Body is text/plain — parsed by express.text() middleware in main.ts.
   */
  @Post(':wsToken/cdata')
  async postCdata(
    @Param('wsToken') wsToken: string,
    @Query('table') table: string,
    @Query('SN') sn: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Sanitise SN before any use in logs or downstream calls (CR-02)
    const serial = this.sanitiseSN(sn);
    if (!serial) {
      res.status(400).type('text/plain').send('BAD REQUEST\n');
      return;
    }

    const rawBody: string =
      typeof req.body === 'string' ? req.body : '';
    const bodyBytes = Buffer.byteLength(rawBody, 'utf8');

    const wsId = await this.ingestService.resolveToken(wsToken);

    if (!wsId) {
      this.logger.warn(
        `[ADMS] POST rejected for SN=${serial} table=${table} token=***${wsToken.slice(-8)}`,
      );
      await this.ingestService.writeIngestLog({
        wsId: null,
        deviceSerial: serial,
        method: 'POST',
        table: table ?? null,
        bodyBytes,
        responseStatus: 403,
        error: 'invalid_token',
      });
      res.status(403).type('text/plain').send('UNAUTHORIZED\n');
      return;
    }

    // Handle ATTLOG table
    if (table === 'ATTLOG') {
      const count = await this.ingestService.handleAttlog(wsId, serial, rawBody);
      this.logger.log(
        `[ADMS] ATTLOG ws=${wsId} SN=${serial} submitted=${rawBody.split('\n').filter(Boolean).length} inserted=${count}`,
      );
      await this.ingestService.writeIngestLog({
        wsId,
        deviceSerial: serial,
        method: 'POST',
        table: 'ATTLOG',
        bodyBytes,
        responseStatus: 200,
      });
      res.type('text/plain').send(`OK: ${count}\n`);
      return;
    }

    // Other tables (USER, OPERLOG, OPLOG) — acknowledge and discard in Phase B
    this.logger.log(
      `[ADMS] POST table=${table} ws=${wsId} SN=${serial} — acknowledged`,
    );
    await this.ingestService.writeIngestLog({
      wsId,
      deviceSerial: serial,
      method: 'POST',
      table: table ?? null,
      bodyBytes,
      responseStatus: 200,
    });
    res.type('text/plain').send('OK\n');
  }

  /**
   * GET /iclock/:wsToken/getrequest?SN=X
   * Dequeues the next queued command for this device.
   */
  @Get(':wsToken/getrequest')
  async getRequest(
    @Param('wsToken') wsToken: string,
    @Query('SN') sn: string,
    @Res() res: Response,
  ): Promise<void> {
    // Sanitise SN before any use in logs or downstream calls (CR-02)
    const serial = this.sanitiseSN(sn);
    if (!serial) {
      res.status(400).type('text/plain').send('BAD REQUEST\n');
      return;
    }

    const wsId = await this.ingestService.resolveToken(wsToken);

    if (!wsId) {
      res.status(403).type('text/plain').send('UNAUTHORIZED\n');
      return;
    }

    const commandText = await this.ingestService.handleGetRequest(wsId, serial);

    this.logger.log(
      `[ADMS] getrequest ws=${wsId} SN=${serial} cmd=${commandText === 'OK' ? 'none' : commandText.slice(0, 40)}`,
    );

    res.type('text/plain').send(`${commandText}\n`);
  }

  /**
   * POST /iclock/:wsToken/fdata
   * Biometric template upload — ignored in Phase B MVP, respond OK.
   */
  @Post(':wsToken/fdata')
  async postFdata(@Res() res: Response): Promise<void> {
    res.type('text/plain').send('OK\n');
  }
}
