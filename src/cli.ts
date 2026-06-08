#!/usr/bin/env node
import fs from 'node:fs/promises';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { maskSecrets } from '../packages/core/src/secrets.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { runtimeConfigStatus } from '../packages/core/src/config.ts';
import { maskEnvEntries, parseDotEnv } from '../packages/core/src/env-file.ts';
import { parseGitHubRepository } from '../packages/core/src/github-integration.ts';
import { applyProject, cloneRepository, executeBuildWorkflow, provisionProjectResources, pushImage as pushRegistryImage } from '../packages/core/src/execution.ts';

const controlPlane = new RAIBITSERVERControlPlane();

async function main(argv: string[]) {
  const [command, file, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) return help();

  if (command === 'catalog') {
    return print({ resources: controlPlane.catalog() });
  }
  if (command === 'config') {
    return print({ keys: runtimeConfigStatus(process.env) });
  }
  if (command === 'env-parse') {
    const text = await fs.readFile(file, 'utf8');
    const parsed = parseDotEnv(text, { source: file });
    return print({ ...parsed, entries: maskEnvEntries(parsed.entries) });
  }
  if (command === 'github-repo') {
    return print(parseGitHubRepository(file || ''));
  }
  if (command === 'build') {
    const payload = await readJsonFile(file);
    if (payload.services) {
      const projectSlug = payload.project?.slug || payload.slug || payload.project?.name || 'project';
      return print({
        buildPlans: payload.services.map((service: Record<string, unknown>) => controlPlane.planBuild(
          { projectSlug, registry: payload.registry, ...service },
          payload.filesByService?.[String(service.name)] || {},
        )),
      });
    }
    return print(controlPlane.planBuild(payload.service || payload, payload.files || {}));
  }
  if (command === 'source-plan') {
    const payload = await readJsonFile(file);
    const service = selectService(payload, rest);
    return print(controlPlane.planSourceCheckout(service, cliOptions(rest)));
  }
  if (command === 'clone') {
    const payload = await readJsonFile(file);
    const service = selectService(payload, rest);
    return print(await cloneRepository({ ...cliOptions(rest), repoUrl: service.repoUrl, branch: service.branch, name: service.name, commitSha: service.commitSha || service.commitHash, dryRun: !hasFlag(rest, '--execute') }));
  }
  if (command === 'build-execute') {
    const payload = await readJsonFile(file);
    const service = selectService(payload, rest);
    return print(await executeBuildWorkflow({ projectSlug: payload.project?.slug || payload.slug || payload.project?.name, registry: payload.registry, ...service }, payload.filesByService?.[String(service.name)] || payload.files || {}, {
      ...cliOptions(rest),
      push: hasFlag(rest, '--push'),
      pushAfterBuild: hasFlag(rest, '--push-after-build'),
      dryRun: !hasFlag(rest, '--execute'),
    }));
  }
  if (command === 'registry-push') {
    const image = file;
    if (!image) throw new Error('image is required');
    return print(hasFlag(rest, '--execute') ? await pushRegistryImage({ image, dryRun: false }) : controlPlane.planRegistryPush(image));
  }
  if (command === 'manifest') {
    const payload = await readJsonFile(file);
    return print(controlPlane.compileManifests(projectSpecFromPayload(payload), payload.filesByService || {}));
  }
  if (command === 'k8s-apply') {
    const payload = await readJsonFile(file);
    const options = { ...cliOptions(rest), dryRun: !hasFlag(rest, '--execute') };
    return print(await applyProject(projectSpecFromPayload(payload), payload.filesByService || {}, options));
  }
  if (command === 'provision-plan') {
    const payload = await readJsonFile(file);
    return print(controlPlane.planProvisioning(projectSpecFromPayload(payload)));
  }
  if (command === 'provision') {
    const payload = await readJsonFile(file);
    return print(await provisionProjectResources(projectSpecFromPayload(payload), { ...cliOptions(rest), dryRun: !hasFlag(rest, '--execute') }));
  }
  if (command === 'validate') {
    const payload = await readJsonFile(file);
    return print(controlPlane.validateProject(projectSpecFromPayload(payload)));
  }
  if (command === 'compose') {
    const text = await fs.readFile(file, 'utf8');
    return print(controlPlane.importCompose(text, { projectName: rest.find((arg) => !arg.startsWith('--')) || 'compose-import' }));
  }
  if (command === 'guard-query') {
    const queryArgs = [file, ...rest].filter(Boolean) as string[];
    const queryFile = valueForFlag(queryArgs, '--file');
    const legacyQueryFile = !queryFile && queryArgs.length === 1 && await readableFile(queryArgs[0]);
    const query = queryFile
      ? await fs.readFile(queryFile, 'utf8')
      : legacyQueryFile
        ? await fs.readFile(queryArgs[0], 'utf8')
        : queryArgs.join(' ');
    return print(controlPlane.guardQuery(query, { role: process.env.RAIBITSERVER_ROLE || 'developer', confirmed: process.env.RAIBITSERVER_CONFIRMED === '1' }));
  }
  if (command === 'auth-token') {
    const secret = process.env.RAIBITSERVER_AUTH_JWT_SECRET;
    if (!secret) throw new Error('RAIBITSERVER_AUTH_JWT_SECRET is required');
    const authArgs = [file, ...rest].filter(Boolean) as string[];
    const role = valueForFlag(authArgs, '--role') || 'developer';
    const sub = valueForFlag(authArgs, '--sub') || 'cli-user';
    const organizationId = valueForFlag(authArgs, '--organization-id') || valueForFlag(authArgs, '--org');
    const projectId = valueForFlag(authArgs, '--project-id') || valueForFlag(authArgs, '--project');
    const global = hasFlag(authArgs, '--global');
    return printUnmasked({ token: signJwtHs256({ sub, role, organizationId, projectId, global }, secret, { expiresInSeconds: Number(valueForFlag(rest, '--ttl') || 3600) }) });
  }

  throw new Error(`unknown command: ${command}`);
}

async function readJsonFile(path: string | undefined) {
  if (!path) throw new Error('JSON file path is required');
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

function selectService(payload: Record<string, any>, args: string[]) {
  if (!payload.services) return payload.service || payload;
  const serviceName = valueForFlag(args, '--service') || payload.services[0]?.name;
  const service = payload.services.find((candidate: Record<string, any>) => candidate.name === serviceName);
  if (!service) throw new Error(`service not found: ${serviceName}`);
  return service;
}

function cliOptions(args: string[]) {
  const options: Record<string, any> = {};
  for (const [flag, key] of [['--workspace', 'workspaceDir'], ['--source-dir', 'sourceDir'], ['--builder', 'builder'], ['--kubeconfig', 'kubeconfig'], ['--context', 'context'], ['--output-dir', 'outputDir']]) {
    const value = valueForFlag(args, flag);
    if (value) options[key] = value;
  }
  return options;
}

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function valueForFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readableFile(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(maskSecrets(value), null, 2)}\n`);
}

function printUnmasked(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function projectSpecFromPayload(payload: Record<string, any>) {
  if (payload.projectSpec) return payload.projectSpec;
  if (payload.services || payload.resources || payload.organization) return payload;
  return payload.project || payload;
}

function help() {
  process.stdout.write(`RAIBITSERVER CLI\n\nUsage:\n  node src/cli.js catalog\n  node src/cli.js config\n  node src/cli.js env-parse <.env>\n  node src/cli.js github-repo <owner/repo|https://github.com/owner/repo>\n  node src/cli.js build <service-or-project.json>\n  node src/cli.js source-plan <project.json> [--service web]\n  node src/cli.js clone <service-or-project.json> [--service web] [--workspace .work] [--execute]\n  node src/cli.js build-execute <project.json> [--service web] [--builder docker-buildx|buildctl] [--push] [--execute]\n  node src/cli.js registry-push <image> [--execute]\n  node src/cli.js manifest <project.json>\n  node src/cli.js k8s-apply <project.json> [--execute] [--kubeconfig path] [--context name]\n  node src/cli.js provision-plan <project.json>\n  node src/cli.js provision <project.json> [--execute]\n  node src/cli.js validate <project.json>\n  node src/cli.js compose <docker-compose.yml> [project-name]\n  node src/cli.js guard-query <SQL text>\n  RAIBITSERVER_AUTH_JWT_SECRET=... node src/cli.js auth-token --role owner --sub user-1 --organization-id org-1\n\nSide-effecting commands default to dry-run. Add --execute to run git/docker/kubectl commands.\n\n`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
