import { compileProject } from './manifest-compiler.ts';
import { importCompose } from './compose-importer.ts';
import { listCatalog } from './catalog.ts';
import { resolveBuildStrategy } from './build-strategy.ts';
import { ControlPlaneStore } from './store.ts';
import { checkQuota } from './quota.ts';
import { validateServiceSecurity, guardDatabaseQuery } from './security.ts';
import { metricSeries, alertPolicies } from './observability.ts';
import { sourceCheckoutPlan } from './source-control.ts';
import { buildExecutionPlan } from './build-executor.ts';
import { registryPushPlan } from './registry.ts';
import { kubernetesApplyPlan } from './kubernetes.ts';
import { compileProjectProvisioning } from './provisioner.ts';
import { runtimeConfigStatus } from './config.ts';
import { parseDotEnv } from './env-file.ts';
import { parseGitHubRepository } from './github-integration.ts';
import type { ProjectSpec, ResourceSpec, ServiceSpec } from './types.ts';

export class RAIBITSERVERControlPlane {
  store: ControlPlaneStore;
  private readonly manifestOptions: Record<string, unknown>;

  constructor(store = new ControlPlaneStore(), options: Record<string, unknown> = {}) {
    this.store = store;
    this.manifestOptions = {
      ingressGatewayNamespace: options.ingressGatewayNamespace ?? process.env.RAIBITSERVER_INGRESS_GATEWAY_NAMESPACE,
    };
  }

  catalog() {
    return listCatalog();
  }

  configStatus(env: Record<string, any> = process.env) {
    return runtimeConfigStatus(env);
  }

  planBuild(service: ServiceSpec, files: Record<string, string> = {}) {
    return resolveBuildStrategy(service, files);
  }

  importCompose(text: string, options: Record<string, unknown> = {}) {
    return importCompose(text, options);
  }

  compileManifests(projectSpec: ProjectSpec, filesByService: Record<string, Record<string, string>> = {}) {
    return compileProject(projectSpec, filesByService, this.manifestOptions);
  }

  planSourceCheckout(service: ServiceSpec, options: Record<string, unknown> = {}) {
    return sourceCheckoutPlan(service, options);
  }

  planBuildExecution(service: ServiceSpec, files: Record<string, string> = {}, options: Record<string, unknown> = {}) {
    return buildExecutionPlan(service, files, options);
  }

  planRegistryPush(image: string) {
    return registryPushPlan(image);
  }

  planKubernetesApply(projectSpec: ProjectSpec, filesByService: Record<string, Record<string, string>> = {}, options: Record<string, unknown> = {}) {
    const compiled = compileProject(projectSpec, filesByService, this.manifestOptions);
    return { compiled, apply: kubernetesApplyPlan(compiled.manifests, options) };
  }

  planProvisioning(projectSpec: ProjectSpec) {
    return compileProjectProvisioning(projectSpec);
  }

  parseEnvFile(text: string, options: Record<string, unknown> = {}) {
    return parseDotEnv(text, options);
  }

  parseGitHubRepository(input: string | Record<string, unknown>) {
    return parseGitHubRepository(input);
  }

  validateProject(projectSpec: ProjectSpec) {
    const serviceFindings = (projectSpec.services || []).map((service) => ({
      service: service.name,
      security: validateServiceSecurity(service),
      metrics: metricSeries(service),
    }));
    const quota = checkQuota({
      plan: projectSpec.organization?.plan || 'free',
      current: projectSpec.currentUsage || {},
      requested: {
        apps: (projectSpec.services || []).length,
        projects: 1,
        dbStorageGb: (projectSpec.resources || []).reduce((sum, resource) => sum + Number(resource.storageGb || 0), 0),
        customDomains: (projectSpec.services || []).filter((service) => service.domain).length,
      },
    });
    return {
      ok: serviceFindings.every((row) => row.security.ok) && quota.ok,
      serviceFindings,
      quota,
      alertPolicies: alertPolicies(),
    };
  }

  guardQuery(query: string, options: Record<string, unknown> = {}) {
    return guardDatabaseQuery(query, options);
  }
}
