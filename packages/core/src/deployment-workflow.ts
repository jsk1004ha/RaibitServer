import { assertLegacyBuildDryRun, executeBuildWorkflow } from './build-executor.ts';
import { deepClone, nowIso } from './ids.ts';
import { INTERNAL_SERVICE_MUTATION } from './desired-state-mutations.ts';
import { sanitizeLogRecord } from './security.ts';
import { maskSecrets } from './secrets.ts';
import { DEPLOYMENT_STATUSES, normalizeDeploymentStatus } from './deployments.ts';
import { WORKFLOW_TYPES } from './workflows.ts';
import { errorSpecForCode } from './error-spec.ts';

const BUILD_WORKFLOW_TYPES = new Set([WORKFLOW_TYPES.BUILD_AND_DEPLOY, WORKFLOW_TYPES.PREVIEW_DEPLOY, 'build', 'builder']);

type AnyRecord = Record<string, any>;

export function createDeploymentWorkflowHandlers(repository: any, options: AnyRecord = {}) {
  return {
    [WORKFLOW_TYPES.BUILD_AND_DEPLOY]: (job: AnyRecord, context: AnyRecord = {}) => processBuilderWorkflowJob(repository, job, { ...options, ...context }),
    [WORKFLOW_TYPES.PREVIEW_DEPLOY]: (job: AnyRecord, context: AnyRecord = {}) => processBuilderWorkflowJob(repository, job, { ...options, ...context }),
  };
}

export async function processBuilderWorkflowJob(repository: any, job: AnyRecord, options: AnyRecord = {}) {
  assertLegacyBuildDryRun(options);
  if (!BUILD_WORKFLOW_TYPES.has(String(job.type || WORKFLOW_TYPES.BUILD_AND_DEPLOY))) {
    throw new Error(`unsupported deployment workflow type: ${job.type}`);
  }
  const state = await resolveDeploymentWorkflowState(repository, job);
  const dryRun = options.dryRun !== false;
  await updateDeployment(repository, state.deployment.id, {
    status: DEPLOYMENT_STATUSES.BUILDING,
    buildStartedAt: nowIso(),
    errorCode: null,
    errorMessage: null,
  });
  await appendDeploymentEvent(repository, {
    deploymentId: state.deployment.id,
    type: 'build.started',
    message: 'builder claimed deployment and started image workflow',
    metadata: { jobId: job.id, workerId: options.workerId || options.worker || job.lockedBy || 'typescript-builder', dryRun },
  });
  await appendBuildLog(repository, { deploymentId: state.deployment.id, step: 'claim', line: `claimed workflow job ${job.id || state.deployment.id}` });

  try {
    if (options.failBuild) throw errorFromOption(options.failBuild, 'simulated build failure');
    const buildInput = buildServiceInput(state, job, options);
    const files = filesForService(state.service, options);
    const buildOptions = {
      dryRun,
      push: options.push === true,
      pushAfterBuild: options.pushAfterBuild === true,
      builder: options.builder || state.service.builder || job.payload?.builder || 'docker-buildx',
      workspaceDir: options.workspaceDir,
      sourceDir: sourceDirForService(state.service, job, options),
      metadataFile: options.metadataFile || metadataFileForService(state.service, options),
      includeCommandOutput: options.includeCommandOutput === true,
      buildArgs: { ...(state.service.buildArgs || {}), ...(job.payload?.buildArgs || {}), ...(options.buildArgs || {}) },
      registryUsername: options.registryUsername,
      registryPassword: options.registryPassword,
      registry: options.registry || state.service.registry,
      timeoutMs: options.timeoutMs,
    };
    const build = await executeBuildWorkflow(buildInput, files, buildOptions);
    await writeBuildLogs(repository, state.deployment.id, build);
    if (build.mode !== 'dockerfile' && build.mode !== 'prebuilt-image') {
      await appendBuildLog(repository, { deploymentId: state.deployment.id, step: 'dockerfile', line: `generated Dockerfile workflow selected for ${build.mode}` });
    }
    const image = build.image || build.buildPlan?.image || buildInput.image || buildInput.imageUrl;
    const imageDigest = build.imageDigest || state.deployment.imageDigest || null;
    await updateDeployment(repository, state.deployment.id, {
      status: DEPLOYMENT_STATUSES.IMAGE_READY,
      imageUrl: image,
      imageDigest,
      buildFinishedAt: nowIso(),
      errorCode: null,
      errorMessage: null,
    });
    await updateService(repository, state.service.id, { image, imageUrl: image, status: 'image-ready' });
    await appendDeploymentEvent(repository, {
      deploymentId: state.deployment.id,
      type: 'build.image_ready',
      message: 'image built and ready for orchestration',
      metadata: { image, imageDigest, dryRun, mode: build.mode },
    });
    return {
      deploymentId: state.deployment.id,
      serviceId: state.service.id,
      projectId: state.project.id,
      image,
      imageDigest,
      status: DEPLOYMENT_STATUSES.IMAGE_READY,
      dryRun,
      mode: build.mode,
      steps: build.steps || [],
    };
  } catch (error) {
    const errorSpec = errorSpecForCode('BUILD_FAILED');
    const safeMessage = sanitizeLogRecord(error?.message || String(error));
    await appendBuildLog(repository, { deploymentId: state.deployment.id, step: 'error', line: safeMessage, level: 'error' });
    await updateDeployment(repository, state.deployment.id, {
      status: DEPLOYMENT_STATUSES.BUILD_FAILED,
      buildFinishedAt: nowIso(),
      errorCode: errorSpec.code,
      errorMessage: safeMessage,
    });
    await appendDeploymentEvent(repository, {
      deploymentId: state.deployment.id,
      type: 'build.failed',
      message: safeMessage,
      metadata: { jobId: job.id, dryRun, errorSpec },
    });
    throw error;
  }
}

export async function reconcileDeploymentRollout(repository: any, deploymentId: string, options: AnyRecord = {}) {
  assertLegacyRolloutDryRun(options);
  const deployment = await getDeployment(repository, deploymentId);
  if (!deployment) throw new Error(`deployment not found: ${deploymentId}`);
  const status = normalizeDeploymentStatus(deployment.status);
  if (status !== DEPLOYMENT_STATUSES.IMAGE_READY && status !== DEPLOYMENT_STATUSES.DEPLOYING) {
    return { processed: false, deploymentId, status, reason: 'deployment_not_image_ready' };
  }
  const service = await getService(repository, deployment.serviceId);
  if (!service) throw new Error(`service not found: ${deployment.serviceId}`);
  const dryRun = options.dryRun !== false;
  try {
    if (status !== DEPLOYMENT_STATUSES.DEPLOYING) {
      await updateDeployment(repository, deploymentId, { status: DEPLOYMENT_STATUSES.DEPLOYING });
      await appendDeploymentEvent(repository, { deploymentId, type: 'rollout.started', message: 'orchestrator started Kubernetes rollout', metadata: { dryRun } });
    }
    if (options.failRollout) throw errorFromOption(options.failRollout, 'simulated rollout failure');
    const host = options.host || options.urlHost || null;
    await appendRuntimeLog(repository, { serviceId: service.id, deploymentId, podName: dryRun ? 'dry-run' : `${service.slug || service.name}-pod`, sourceInstanceId: `deployment-rollout:${deploymentId}`, containerName: service.slug || service.name || 'app', line: host ? `HTTP 200 ${host}` : 'rollout status ready' });
    await updateDeployment(repository, deploymentId, { status: DEPLOYMENT_STATUSES.READY, deployedAt: nowIso(), finishedAt: nowIso(), errorCode: null, errorMessage: null });
    await updateService(repository, service.id, { status: 'ready', imageUrl: deployment.imageUrl || service.imageUrl || service.image || null });
    await appendDeploymentEvent(repository, { deploymentId, type: 'rollout.ready', message: 'Kubernetes rollout is ready', metadata: { dryRun, host, image: deployment.imageUrl || service.imageUrl || service.image || null } });
    return { processed: true, deploymentId, serviceId: service.id, status: DEPLOYMENT_STATUSES.READY, dryRun };
  } catch (error) {
    const errorSpec = errorSpecForCode('ROLLOUT_FAILED');
    const safeMessage = sanitizeLogRecord(error?.message || String(error));
    await appendRuntimeLog(repository, { serviceId: service.id, deploymentId, podName: dryRun ? 'dry-run' : `${service.slug || service.name}-pod`, sourceInstanceId: `deployment-rollout:${deploymentId}`, containerName: 'orchestrator', line: safeMessage, level: 'error' });
    await updateDeployment(repository, deploymentId, { status: DEPLOYMENT_STATUSES.FAILED, finishedAt: nowIso(), errorCode: errorSpec.code, errorMessage: safeMessage });
    await appendDeploymentEvent(repository, { deploymentId, type: 'rollout.failed', message: safeMessage, metadata: { dryRun, errorSpec } });
    throw error;
  }
}

export function assertLegacyRolloutDryRun(options: AnyRecord = {}) {
  if (options.dryRun === false) {
    throw new Error('legacy TypeScript rollout is dry-run only; use the Go orchestrator control-plane worker for live deployments');
  }
}

export async function processBuildAndRolloutWorkflowJob(repository: any, job: AnyRecord, options: AnyRecord = {}) {
  const build = await processBuilderWorkflowJob(repository, job, options);
  const rollout = await reconcileDeploymentRollout(repository, build.deploymentId, options);
  return { ...build, rollout, status: rollout.status || build.status };
}

async function resolveDeploymentWorkflowState(repository: any, job: AnyRecord) {
  const payload = job.payload || {};
  const deploymentId = payload.deploymentId || (job.targetType === 'deployment' ? job.targetId : null);
  if (!deploymentId) throw new Error('workflow job payload.deploymentId or deployment targetId is required');
  const deployment = await getDeployment(repository, deploymentId);
  if (!deployment) throw new Error(`deployment not found: ${deploymentId}`);
  const serviceId = deployment.serviceId || payload.serviceId;
  const service = await getService(repository, serviceId);
  if (!service) throw new Error(`service not found: ${serviceId}`);
  const projectId = deployment.projectId || service.projectId || payload.projectId;
  const project = await getProject(repository, projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  return { deployment, service, project };
}

function buildServiceInput(state: AnyRecord, job: AnyRecord, options: AnyRecord) {
  const desired = { ...(state.service.desiredSpec || {}), ...(state.service.desiredState || {}) };
  const payload = job.payload || {};
  return maskSecrets({
    ...desired,
    ...state.service,
    project: state.project.slug || state.project.name,
    projectSlug: state.project.slug || state.project.name,
    organizationId: state.project.organizationId,
    sourceType: payload.sourceType || state.service.sourceType,
    buildMode: payload.buildMode || state.service.buildMode,
    repoUrl: payload.repoUrl || state.service.repoUrl,
    branch: payload.branch || state.deployment.branch || state.service.branch || 'main',
    commitSha: payload.commitSha || state.deployment.commitSha || state.deployment.commitHash || null,
    image: state.deployment.imageUrl || payload.image || state.service.image || state.service.imageUrl,
    imageUrl: state.deployment.imageUrl || payload.imageUrl || state.service.imageUrl || state.service.image,
    imageDigest: state.deployment.imageDigest || payload.imageDigest || null,
    registry: payload.registry || options.registry || state.service.registry || desired.registry,
    revision: payload.revision || payload.commitSha || state.deployment.commitSha || state.deployment.commitHash || desired.revision,
    localPath: payload.localPath || state.service.localPath || desired.localPath,
  });
}

function filesForService(service: AnyRecord, options: AnyRecord) {
  const byService = options.filesByService || {};
  return byService[service.id] || byService[service.slug] || byService[service.name] || options.files || {};
}

function sourceDirForService(service: AnyRecord, job: AnyRecord, options: AnyRecord) {
  const byService = options.sourceDirsByService || {};
  return byService[service.id] || byService[service.slug] || byService[service.name] || job.payload?.sourceDir || job.payload?.localPath || options.sourceDir || service.localPath || undefined;
}

function metadataFileForService(service: AnyRecord, options: AnyRecord) {
  const byService = options.metadataFilesByService || {};
  return byService[service.id] || byService[service.slug] || byService[service.name] || null;
}

async function writeBuildLogs(repository: any, deploymentId: string, build: AnyRecord) {
  await appendBuildLog(repository, { deploymentId, step: 'plan', line: `${build.mode} build selected for image ${build.image}` });
  for (const step of build.steps || []) {
    const line = step.command || step.detail || step.type;
    await appendBuildLog(repository, { deploymentId, step: step.type || 'build', line: sanitizeLogRecord(line || '') });
  }
}

function errorFromOption(option: any, fallback: string) {
  if (option instanceof Error) return option;
  if (typeof option === 'string') return new Error(option);
  return new Error(fallback);
}

async function getProject(repository: any, projectId: string) {
  if (typeof repository.getProject === 'function') return repository.getProject(projectId);
  if (repository.projects?.get) return deepClone(repository.projects.get(projectId) || null);
  if (repository.store?.projects?.get) return deepClone(repository.store.projects.get(projectId) || null);
  throw new Error('repository must implement getProject');
}

async function getService(repository: any, serviceId: string) {
  if (typeof repository.getService === 'function') return repository.getService(serviceId);
  if (repository.services?.get) return deepClone(repository.services.get(serviceId) || null);
  if (repository.store?.services?.get) return deepClone(repository.store.services.get(serviceId) || null);
  throw new Error('repository must implement getService');
}

async function getDeployment(repository: any, deploymentId: string) {
  if (typeof repository.getDeployment === 'function') return repository.getDeployment(deploymentId);
  if (repository.deployments?.get) return deepClone(repository.deployments.get(deploymentId) || null);
  if (repository.store?.deployments?.get) return deepClone(repository.store.deployments.get(deploymentId) || null);
  throw new Error('repository must implement getDeployment');
}

async function updateDeployment(repository: any, deploymentId: string, updates: AnyRecord) {
  if (typeof repository.updateDeployment === 'function') return repository.updateDeployment(deploymentId, updates);
  if (repository.store && typeof repository.store.updateDeployment === 'function') return repository.store.updateDeployment(deploymentId, updates);
  throw new Error('repository must implement updateDeployment');
}

async function updateService(repository: any, serviceId: string, updates: AnyRecord) {
  if (typeof repository.updateService === 'function') return repository.updateService(serviceId, updates, { mutation: INTERNAL_SERVICE_MUTATION });
  if (repository.store && typeof repository.store.updateService === 'function') return repository.store.updateService(serviceId, updates, { mutation: INTERNAL_SERVICE_MUTATION });
  throw new Error('repository must implement updateService');
}

async function appendBuildLog(repository: any, input: AnyRecord) {
  if (typeof repository.appendBuildLog === 'function') return repository.appendBuildLog(input);
  if (repository.store && typeof repository.store.appendBuildLog === 'function') return repository.store.appendBuildLog(input);
  throw new Error('repository must implement appendBuildLog');
}

async function appendRuntimeLog(repository: any, input: AnyRecord) {
  if (typeof repository.appendRuntimeLog === 'function') return repository.appendRuntimeLog(input);
  if (repository.store && typeof repository.store.appendRuntimeLog === 'function') return repository.store.appendRuntimeLog(input);
  throw new Error('repository must implement appendRuntimeLog');
}

async function appendDeploymentEvent(repository: any, input: AnyRecord) {
  if (typeof repository.appendDeploymentEvent === 'function') return repository.appendDeploymentEvent(input);
  if (repository.store && typeof repository.store.appendDeploymentEvent === 'function') return repository.store.appendDeploymentEvent(input);
  throw new Error('repository must implement appendDeploymentEvent');
}
