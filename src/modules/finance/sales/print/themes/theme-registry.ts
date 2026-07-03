import type { jsPDF } from 'jspdf';

export type SupportedLocale = 'en' | 'gu' | 'hi';

/**
 * PrintRenderContext — opaque bundle handed to a theme's render(). Themes
 * MUST consume t() / formatINR / amountInWords for ALL system labels and
 * money. Free-text fields (party.name, lineItems[i].itemName, party.address)
 * are printed as-is per D-39.
 *
 * irpQrBase64: pre-generated base64 PNG data URL of the IRP-signed QR code
 * (CGST Rule 48). Present only when invoice.eInvoice.irn is set. Themes that
 * render sale invoices MUST draw this QR when it is provided.
 */
export interface PrintRenderContext {
  pdf: jsPDF;
  locale: SupportedLocale;
  t: (key: string, vars?: Record<string, string | number>) => string;
  fontFamily: string;
  invoice: any;
  party: any;
  firm: any;
  formatINR: (paise: number) => string;
  amountInWords: (paise: number) => string;
  irpQrBase64?: string;
}

export interface PrintTheme {
  id: string;
  label: string;
  render(opts: PrintRenderContext): void;
}

const _registry = new Map<string, PrintTheme>();

/**
 * ThemeRegistry — drop-in registration surface. Theme modules call
 * ThemeRegistry.register(theme) at module-load time. The print service
 * resolves a theme by id at render time.
 */
export const ThemeRegistry = {
  register(theme: PrintTheme): void {
    if (_registry.has(theme.id)) {
      // Idempotent re-registration (e.g. test re-imports) — overwrite
      // silently rather than throw, so multiple test files can import the
      // theme module without bringing down the suite.
      _registry.set(theme.id, theme);
      return;
    }
    _registry.set(theme.id, theme);
  },
  get(id: string): PrintTheme {
    const t = _registry.get(id);
    if (!t) throw new Error(`Theme '${id}' not registered`);
    return t;
  },
  list(): PrintTheme[] {
    return [..._registry.values()];
  },
  has(id: string): boolean {
    return _registry.has(id);
  },
};
