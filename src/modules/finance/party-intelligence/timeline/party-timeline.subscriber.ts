/**
 * Phase 17 / FIN-16-03 — PartyTimelineSubscriber.
 *
 * Listens for `party.timeline` events emitted by voucher / payment / reminder
 * services and persists them via PartyTimelineService.
 *
 * Design (CONTEXT D-17, RESEARCH Pattern 2 / Pitfall 4):
 *  - `async: true` — the listener runs on a microtask AFTER `emit()` returns,
 *    so a slow/failing persist NEVER blocks the producer's voucher write.
 *  - try/catch — listener exceptions are logged but never re-thrown. Losing
 *    a single timeline row is recoverable; rolling back a tax invoice is not.
 *  - All ObjectId casting is delegated to PartyTimelineService.append.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  PartyTimelineService,
  PartyTimelineEventPayload,
} from './party-timeline.service';

@Injectable()
export class PartyTimelineSubscriber {
  private readonly logger = new Logger(PartyTimelineSubscriber.name);

  constructor(private readonly service: PartyTimelineService) {}

  @OnEvent('party.timeline', { async: true })
  async handle(payload: PartyTimelineEventPayload): Promise<void> {
    try {
      await this.service.append(payload);
    } catch (err: unknown) {
      const message =
        (err as { message?: string })?.message ?? String(err);
      this.logger.warn(
        `party.timeline subscriber failed (swallowed): type=${payload?.type} ` +
          `wsId=${payload?.workspaceId} partyId=${payload?.partyId} err=${message}`,
      );
      // NEVER rethrow — D-17 non-blocking guarantee.
    }
  }
}
