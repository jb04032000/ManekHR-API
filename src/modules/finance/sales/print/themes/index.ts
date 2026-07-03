/**
 * Theme barrel — side-effect imports trigger ThemeRegistry.register
 * for both themes at module-load. Future themes drop in by adding a
 * line here + a `theme-{id}.ts` module that calls ThemeRegistry.register
 * at module-load time.
 */
import './theme-classic';
import './theme-modern';

export { ThemeRegistry } from './theme-registry';
export type { PrintTheme, PrintRenderContext, SupportedLocale } from './theme-registry';
