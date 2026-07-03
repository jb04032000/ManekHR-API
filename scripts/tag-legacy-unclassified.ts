/**
 * RBAC re-architecture — codemod (design §8, task 8).
 *
 * Tags every NestJS controller that still has >=1 un-classified route handler
 * with a class-level `@LegacyUnclassified()`. Once `RolesGuard` is global +
 * deny-by-default (task 9), an unmarked route is denied; this marker keeps
 * legacy routes reachable by any authenticated user (their pre-flip posture,
 * the controller still doing its own tenant scoping) while making the
 * outstanding classification debt explicit, greppable and tracked.
 *
 * Class-level tagging (not per-route): a handler-level real marker
 * (`@RequirePermission` / `@RequirePermissions` / `@Public` /
 * `@AuthenticatedOnly`) overrides the class fallback via the guard's
 * `getAllAndOverride`, so ONE decorator per controller covers every bare
 * route — no 700-handler diff. Only controllers with >=1 bare route are
 * tagged; fully-classified controllers are left untouched.
 *
 * Idempotent — a controller already carrying `@LegacyUnclassified` (or a
 * class-level `@Public` / `@AuthenticatedOnly` / `@RequirePermission`) is
 * skipped.
 *
 * Usage:  npx ts-node scripts/tag-legacy-unclassified.ts [--check]
 *   (no flag) apply  — insert decorators + imports, then verify.
 *   --check          — report only, write nothing (re-verification / CI gate;
 *                      exits non-zero if any route is still unclassified).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DECORATOR_MODULE = path.resolve(SRC_ROOT, 'common/decorators/legacy-unclassified.decorator');
const DECORATOR_NAME = 'LegacyUnclassified';

/** Decorators that declare a method to be an HTTP route handler. */
const HTTP_METHOD_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'All',
  'Head',
  'Options',
  'Search',
]);

/** Markers that classify a single route when applied at the handler level. */
const HANDLER_MARKERS = new Set([
  'Public',
  'RequirePermission',
  'RequirePermissions',
  'AuthenticatedOnly',
  'LegacyUnclassified',
]);

/**
 * Markers the guard resolves via `getAllAndOverride([handler, class])` — at
 * the CLASS level they classify every route in the controller. Legacy
 * `@RequirePermissions` is a handler-only lookup in the guard, so it is
 * intentionally absent here (a class-level `@RequirePermissions` classifies
 * nothing).
 */
const CLASS_MARKERS = new Set([
  'Public',
  'RequirePermission',
  'AuthenticatedOnly',
  'LegacyUnclassified',
]);

interface ControllerAnalysis {
  className: string;
  /** Source offset of the controller's first decorator — insert point. */
  insertPos: number;
  routeCount: number;
  /** Route handlers with no handler marker AND no class-level marker. */
  bareRouteCount: number;
  classClassified: boolean;
  alreadyTagged: boolean;
}

function decoratorName(decorator: ts.Decorator): string {
  const expr = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  return ts.isIdentifier(expr) ? expr.text : expr.getText();
}

function decoratorNamesOf(node: ts.Node): string[] {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  return (decorators ?? []).map(decoratorName);
}

function analyzeControllers(sourceFile: ts.SourceFile): ControllerAnalysis[] {
  const result: ControllerAnalysis[] = [];
  sourceFile.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;
    const classDecorators = decoratorNamesOf(node);
    if (!classDecorators.includes('Controller')) return;

    const classClassified = classDecorators.some((name) => CLASS_MARKERS.has(name));
    const alreadyTagged = classDecorators.includes(DECORATOR_NAME);

    let routeCount = 0;
    let bareRouteCount = 0;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const methodDecorators = decoratorNamesOf(member);
      if (!methodDecorators.some((name) => HTTP_METHOD_DECORATORS.has(name))) continue;
      routeCount++;
      const handlerMarked = methodDecorators.some((name) => HANDLER_MARKERS.has(name));
      if (!handlerMarked && !classClassified) bareRouteCount++;
    }

    const decorators = ts.getDecorators(node);
    const insertPos =
      decorators && decorators.length > 0
        ? decorators[0].getStart(sourceFile)
        : node.getStart(sourceFile);

    result.push({
      className: node.name.text,
      insertPos,
      routeCount,
      bareRouteCount,
      classClassified,
      alreadyTagged,
    });
  });
  return result;
}

function relativeImportPath(fromFile: string): string {
  let rel = path.relative(path.dirname(fromFile), DECORATOR_MODULE).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function hasDecoratorImport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (stmt) =>
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text.endsWith('legacy-unclassified.decorator'),
  );
}

function lastImportEnd(sourceFile: ts.SourceFile): number {
  let end = 0;
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) end = stmt.end;
  }
  return end;
}

function findControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...findControllerFiles(full));
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const files = findControllerFiles(SRC_ROOT).sort();

  let controllersTotal = 0;
  let routesTotal = 0;
  let bareBefore = 0;
  let controllersTagged = 0;
  const tagged: string[] = [];

  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    const controllers = analyzeControllers(parse(file, original));
    controllersTotal += controllers.length;
    for (const c of controllers) {
      routesTotal += c.routeCount;
      bareBefore += c.bareRouteCount;
    }

    const toTag = controllers.filter(
      (c) => !c.alreadyTagged && !c.classClassified && c.routeCount > 0 && c.bareRouteCount > 0,
    );
    if (toTag.length === 0) continue;

    controllersTagged += toTag.length;
    for (const c of toTag) {
      tagged.push(`${path.relative(SRC_ROOT, file).replace(/\\/g, '/')} :: ${c.className}`);
    }
    if (checkOnly) continue;

    // One decorator insert per controller + one import per file. Apply
    // descending by offset so earlier inserts do not shift later positions.
    const inserts: Array<{ pos: number; text: string }> = toTag.map((c) => ({
      pos: c.insertPos,
      text: `@${DECORATOR_NAME}()\n`,
    }));
    const sourceFile = parse(file, original);
    if (!hasDecoratorImport(sourceFile)) {
      inserts.push({
        pos: lastImportEnd(sourceFile),
        text: `\nimport { ${DECORATOR_NAME} } from '${relativeImportPath(file)}';`,
      });
    }
    inserts.sort((a, b) => b.pos - a.pos);
    let updated = original;
    for (const ins of inserts) {
      updated = updated.slice(0, ins.pos) + ins.text + updated.slice(ins.pos);
    }
    fs.writeFileSync(file, updated, 'utf8');
  }

  // Verification — re-read the on-disk state; every route handler must now
  // resolve to a marker (handler-level, or the class `@LegacyUnclassified`).
  let bareAfter = 0;
  for (const file of files) {
    const controllers = analyzeControllers(parse(file, fs.readFileSync(file, 'utf8')));
    for (const c of controllers) bareAfter += c.bareRouteCount;
  }

  console.log(`\n=== tag-legacy-unclassified (${checkOnly ? 'check' : 'apply'}) ===`);
  console.log(`controller files            : ${files.length}`);
  console.log(`controllers                 : ${controllersTotal}`);
  console.log(`route handlers              : ${routesTotal}`);
  console.log(`unclassified routes (before): ${bareBefore}`);
  console.log(
    `controllers ${checkOnly ? 'needing tag    ' : 'tagged         '}: ${controllersTagged}`,
  );
  for (const entry of tagged) console.log(`  + ${entry}`);
  console.log(`unclassified routes (after) : ${bareAfter}`);

  if (bareAfter > 0) {
    console.error(
      `\nFAIL — ${bareAfter} route handler(s) still unclassified. The global ` +
        `deny-by-default flip (task 9) must NOT ship until this is 0.`,
    );
    process.exit(1);
  }
  console.log('\nOK — every route handler resolves to an RBAC marker.');
}

main();
