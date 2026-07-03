import { Injectable } from '@nestjs/common';

/**
 * EwbValidityService
 *
 * Computes e-Way Bill validity days per the CURRENT 2025 NIC rule
 * (RESEARCH Pitfall 1 — REPLACES CONTEXT D-04 old distance-slab table):
 *
 *   Road (regular):  Math.ceil(distance / 200)  — 1 day per 200 km
 *   Road (ODC):      Math.ceil(distance / 20)   — 1 day per 20 km (Over-Dimensional Cargo)
 *   Rail / Air / Ship:  15 days (fixed regardless of distance)
 *
 * Reference: CGST Rule 138(10) as amended by Notification No. 38/2023
 * (effective from 1 August 2023, operative throughout FY 2024-25 and 2025-26).
 *
 * Extension window: ±8 hours before/after validUpto (NIC EWB API requirement).
 */
@Injectable()
export class EwbValidityService {
  /**
   * Returns the number of validity days for the given transport parameters.
   *
   * @param transMode   '1'=Road, '2'=Rail, '3'=Air, '4'=Ship
   * @param vehicleType 'R'=Regular, 'M'=ODC (Over-Dimensional Cargo); only relevant when transMode='1'
   * @param distance    Transport distance in km
   */
  computeValidityDays(
    transMode: string,
    vehicleType: string | undefined,
    distance: number,
  ): number {
    // Rail / Air / Ship: 15 days regardless of distance (RESEARCH Code Example 3)
    if (['2', '3', '4'].includes(transMode)) return 15;

    // Road ODC (Over-Dimensional Cargo): 1 day per 20 km
    if (vehicleType === 'M') return Math.ceil(distance / 20);

    // Road regular: 1 day per 200 km (current 2025 formula — RESEARCH Pitfall 1)
    return Math.ceil(distance / 200);
  }

  /**
   * Computes the validUpto Date from the generation timestamp and transport params.
   *
   * @param generatedAt  Timestamp when EWB was generated (Date)
   * @param transMode    '1'=Road, '2'=Rail, '3'=Air, '4'=Ship
   * @param vehicleType  'R'=Regular, 'M'=ODC
   * @param distance     Transport distance in km
   */
  computeValidUpto(
    generatedAt: Date,
    transMode: string,
    vehicleType: string | undefined,
    distance: number,
  ): Date {
    const days = this.computeValidityDays(transMode, vehicleType, distance);
    return new Date(generatedAt.getTime() + days * 24 * 3600 * 1000);
  }

  /**
   * Returns true if the current time is within the ±8-hour extension window
   * around validUpto.
   *
   * NIC EWB API only allows extension when:
   *   validUpto - 8h  <=  now  <=  validUpto + 8h
   *
   * @param validUpto  The current validUpto Date on the EWB
   */
  isWithinExtensionWindow(validUpto: Date): boolean {
    const now = Date.now();
    const expiry = validUpto.getTime();
    return now >= expiry - 8 * 3600 * 1000 && now <= expiry + 8 * 3600 * 1000;
  }
}
