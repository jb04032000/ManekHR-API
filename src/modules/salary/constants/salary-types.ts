/**
 * Phase 23 (D-01, MACH-P2-XC-01): canonical SalaryType enum.
 * Single source of truth for ['monthly','hourly','piece_rate'].
 * Mirrors MACHINE_STATUSES / REASON_CATEGORIES export pattern.
 */
export const SALARY_TYPES = ['monthly', 'hourly', 'piece_rate'] as const;
export type SalaryType = (typeof SALARY_TYPES)[number];
