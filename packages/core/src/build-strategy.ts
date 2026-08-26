import { BUILD_MODES, DEFAULT_DOMAIN, DEFAULT_PORT, DEFAULT_REGISTRY, SOURCE_TYPES, WORKLOAD_PIPELINE } from './constants.ts';
import { detectFramework } from './framework-detector.ts';
import { slugify } from './ids.ts';
import { serviceHostname } from './domain-router.ts';
import { discoverSource, filesAtSourceRoot, normalizeSourcePath } from './source-discovery.ts';

type AnyRecord = Record<string, any>;

function normalizeMode(mode: any) {
  if (!mode) return BUILD_MODES.AUTO;
  const value = String(mode).toLowerCase();
  if (['dockerfile', 'docker'].includes(value)) return BUILD_MODES.DOCKERFILE;
  if (['buildpack', 'buildpacks', 'nixpacks'].includes(value)) return BUILD_MODES.BUILDPACK;
  if (['custom', 'custom-command'].includes(value)) return BUILD_MODES.CUSTOM;
  if (['image', 'prebuilt', 'prebuilt-image'].includes(value)) return BUILD_MODES.PREBUILT_IMAGE;
  return BUILD_MODES.AUTO;
}

export function resolveBuildStrategy(service: AnyRecord = {}, files: AnyRecord = {}) {
  const sourceType = service.sourceType || SOURCE_TYPES.GITHUB;
  const requestedMode = normalizeMode(service.buildMode);
  const name = slugify(service.name || 'service');
  const discovery = discoverSource(files, { rootDirectory: service.rootDirectory, serviceName: service.name });
  const rootDirectory = normalizeSourcePath(service.rootDirectory || discovery.rootDirectory);
  const dockerfilePath = normalizeSourcePath(service.dockerfilePath || discovery.dockerfilePath || 'Dockerfile');
  const buildContext = normalizeSourcePath(service.buildContext || rootDirectory);
  const customBuildCommand = service.buildCommand || service.customBuildCommand || null;
  const image = service.image || service.imageUrl || null;

  if (sourceType === SOURCE_TYPES.IMAGE || requestedMode === BUILD_MODES.PREBUILT_IMAGE) {
    if (!image) {
      throw new Error('prebuilt image source requires service.image or service.imageUrl');
    }
    return buildPlan({
      mode: BUILD_MODES.PREBUILT_IMAGE,
      name,
      sourceType,
      image,
      reason: 'prebuilt container image provided',
      buildSteps: [],
      runtime: { port: service.port || DEFAULT_PORT, startCommand: null },
    });
  }

  if (requestedMode === BUILD_MODES.DOCKERFILE || service.dockerfilePath || discovery.dockerfilePath) {
    return buildPlan({
      mode: BUILD_MODES.DOCKERFILE,
      name,
      sourceType,
      image: imageFor(name, service),
      reason: service.dockerfilePath ? 'user configured Dockerfile path' : 'Dockerfile detected before auto build',
      buildSteps: [
        { type: 'clone-or-upload', rootDirectory },
        { type: 'docker-build', dockerfilePath, buildContext, cache: true },
        { type: 'image-scan', scanners: ['trivy-compatible'], required: true },
        { type: 'image-sign', signer: 'cosign-compatible', required: false },
        { type: 'push', registry: service.registry || DEFAULT_REGISTRY },
      ],
      runtime: { port: service.port || DEFAULT_PORT, startCommand: service.startCommand || null },
    });
  }

  if (requestedMode === BUILD_MODES.CUSTOM || customBuildCommand) {
    return buildPlan({
      mode: BUILD_MODES.CUSTOM,
      name,
      sourceType,
      image: imageFor(name, service),
      reason: 'custom build command configured',
      buildSteps: [
        { type: 'clone-or-upload', rootDirectory },
        service.installCommand ? { type: 'install', command: service.installCommand } : null,
        { type: 'custom-build', command: customBuildCommand || 'npm run build' },
        { type: 'package-runtime', startCommand: service.startCommand || 'npm start', outputDirectory: service.outputDirectory || null },
        { type: 'image-scan', scanners: ['trivy-compatible'], required: true },
        { type: 'push', registry: service.registry || DEFAULT_REGISTRY },
      ].filter(Boolean),
      runtime: { port: service.port || DEFAULT_PORT, startCommand: service.startCommand || 'npm start' },
    });
  }

  const detected = detectFramework(filesAtSourceRoot(files, rootDirectory));
  if (requestedMode === BUILD_MODES.AUTO && detected.framework !== 'unknown') {
    const isStatic = detected.runtime === 'static';
    return buildPlan({
      mode: 'framework',
      name,
      sourceType,
      image: imageFor(name, service),
      reason: `framework detected: ${detected.framework}`,
      framework: detected,
      buildSteps: [
        { type: 'clone-or-upload', rootDirectory },
        detected.installCommand ? { type: 'install', command: detected.installCommand } : null,
        detected.buildCommand ? { type: 'framework-build', command: detected.buildCommand, framework: detected.framework } : null,
        isStatic ? { type: 'static-container', server: detected.staticContainer || 'caddy', outputDirectory: detected.outputDirectory || '.' } : { type: 'package-runtime', startCommand: service.startCommand || detected.startCommand },
        { type: 'image-scan', scanners: ['trivy-compatible'], required: true },
        { type: 'push', registry: service.registry || DEFAULT_REGISTRY },
      ].filter(Boolean),
      runtime: { port: service.port || detected.port || DEFAULT_PORT, startCommand: service.startCommand || detected.startCommand },
    });
  }

  return buildPlan({
    mode: BUILD_MODES.BUILDPACK,
    name,
    sourceType,
    image: imageFor(name, service),
    reason: requestedMode === BUILD_MODES.BUILDPACK ? 'buildpack explicitly configured' : 'fallback to Cloud Native Buildpacks/Nixpacks style builder',
    buildSteps: [
      { type: 'clone-or-upload', rootDirectory },
      { type: 'buildpack-detect', builders: ['paketo', 'herokuish', 'nixpacks-compatible'] },
      { type: 'buildpack-build', cache: true, timeoutSeconds: service.buildTimeoutSeconds || 1200 },
      { type: 'image-scan', scanners: ['trivy-compatible'], required: true },
      { type: 'push', registry: service.registry || DEFAULT_REGISTRY },
    ],
    runtime: { port: service.port || DEFAULT_PORT, startCommand: service.startCommand || null },
  });
}

function imageFor(name: string, service: AnyRecord) {
  const registry = service.registry || DEFAULT_REGISTRY;
  const project = slugify(service.projectSlug || service.project || 'project');
  const tag = slugify(service.revision || service.commitHash || 'latest');
  return `${registry}/${project}/${name}:${tag}`;
}

function buildPlan({ mode, name, sourceType, image, reason, buildSteps, runtime, framework = null }: AnyRecord) {
  const [registry, project = 'project'] = image.includes('/') ? image.split('/') : [DEFAULT_REGISTRY, 'project'];
  return {
    service: name,
    mode,
    sourceType,
    image,
    reason,
    framework,
    buildSteps,
    runtime,
    pipeline: WORKLOAD_PIPELINE,
    deploymentTarget: {
      registry,
      workload: 'kubernetes',
      domainPattern: serviceHostname({ serviceName: name, projectSlug: project, organizationSlug: 'org', baseDomain: DEFAULT_DOMAIN }),
      tls: 'automatic',
    },
    controls: {
      buildCache: mode !== BUILD_MODES.PREBUILT_IMAGE,
      logStreaming: true,
      timeoutSeconds: 1200,
      resourceLimits: { cpu: '2', memory: '4Gi' },
      vulnerabilityScan: mode !== BUILD_MODES.PREBUILT_IMAGE,
      rollbackTags: true,
      previewDeployments: true,
    },
  };
}
