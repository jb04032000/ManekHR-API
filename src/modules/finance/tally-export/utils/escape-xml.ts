/**
 * Escapes the five XML-significant characters required by Tally's importer.
 *
 * Tally's XML parser (ERP 9 v6.6 + TallyPrime v3.x) accepts only these five
 * predefined entity references in attribute and element content. Numeric
 * entity references (&#nn;) are rejected silently for some Tally elements.
 *
 * @param s — raw user-derived string (party name, narration, voucher number, …)
 * @returns escaped string safe to embed verbatim in `<…>{value}</…>`.
 */
export function escapeXml(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  const str = String(s);
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
