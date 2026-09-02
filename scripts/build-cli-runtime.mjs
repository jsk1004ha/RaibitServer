import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
const target = realpathSync.native(process.argv[2]);
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};
if (target === root || inside(root, target)) {
  throw new Error('CLI runtime output must be a separate deployed directory, not the source checkout');
}
const client = realpathSync.native(path.join(target, 'node_modules/@raibitserver/api-client'));
const schemas = realpathSync.native(path.join(target, 'node_modules/@raibitserver/schemas'));
if (!inside(target, client) || !inside(target, schemas)) throw new Error('Deployed workspace packages must resolve inside the deployment');
if (JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')).name !== '@raibitserver/cli') {
  throw new Error('Expected an isolated @raibitserver/cli deployment');
}

const build = mkdtempSync(path.join(tmpdir(), 'cli-runtime-build-'));
const common = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true, strict: true, resolveJsonModule: true, rewriteRelativeImportExtensions: true,
  noEmit: false, noEmitOnError: true, declaration: false, incremental: false,
};
function compile(rootNames, options) {
  const program = ts.createProgram(rootNames, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  const emitted = program.emit();
  if (emitted.emitSkipped) throw new Error('CLI runtime compiler skipped emission');
}
function install(packageDir, entry, output) {
  const dist = path.join(packageDir, 'dist');
  mkdirSync(dist);
  cpSync(output, dist, { recursive: true, errorOnExist: true, force: false });
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.main = entry;
  delete manifest.types;
  if (packageDir === target) manifest.bin = { raibitserver: 'dist/index.js' };
  else manifest.exports = { '.': entry };
  // Atomic replacement does not mutate a pnpm content-store hardlink.
  const replacement = `${manifestPath}.runtime`;
  writeFileSync(replacement, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  renameSync(replacement, manifestPath);
}
try {
  const cliConfig = ts.readConfigFile(path.join(root, 'apps/cli/tsconfig.json'), ts.sys.readFile);
  if (cliConfig.error) throw new Error(ts.flattenDiagnosticMessageText(cliConfig.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(cliConfig.config, ts.sys, path.join(root, 'apps/cli'));
  if (parsed.errors.length) throw new Error('Invalid CLI compiler configuration');
  compile(parsed.fileNames, { ...parsed.options, ...common, strict: false, rootDir: path.join(root, 'apps/cli/src'), outDir: path.join(build, 'cli') });
  compile([path.join(root, 'packages/api-client/src/index.ts')], { ...common, rootDir: path.join(root, 'packages/api-client/src'), outDir: path.join(build, 'client') });
  // Keep the relative schema graph intact, including pure core imports and JSON.
  compile([path.join(root, 'packages/schemas/src/index.ts')], { ...common, rootDir: path.join(root, 'packages'), outDir: path.join(build, 'schemas') });
  install(target, './dist/index.js', path.join(build, 'cli'));
  install(client, './dist/index.js', path.join(build, 'client'));
  install(schemas, './dist/schemas/src/index.js', path.join(build, 'schemas'));
} finally {
  rmSync(build, { recursive: true, force: true });
}
