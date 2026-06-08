import { getCatalogEntry, normalizeResourceEngine } from './catalog.ts';
import { connectionEnvForResource } from './env-injection.ts';
import { slugify } from './ids.ts';
import { applyManifests } from './kubernetes.ts';
import { splitEnvForSecret } from './security.ts';
import { maskSecrets } from './secrets.ts';
import { buildPostgresProviderPlan, buildResourceProviderPlan, provisionResourceProvider, providerConsoleSurface, publicProviderPlan, publicResourceProviderPlan } from './resource-providers.ts';

export function compileResourceProvisioningPlan(resource: Record<string, any>, { namespace = 'default', projectSlug = 'project', organizationSlug = 'org' } = {}) {
  const engine = normalizeResourceEngine(resource.engine || resource.type);
  const entry = getCatalogEntry(engine);
  const name = slugify(resource.name || engine);
  const kind = managedKindFor(entry.type, entry.key);
  const labels = {
    'app.kubernetes.io/managed-by': 'raibitserver',
    'raibitserver.io/project': slugify(projectSlug),
    'raibitserver.io/resource': name,
    'raibitserver.io/resource-engine': entry.key,
    'raibitserver.io/resource-type': entry.type,
  };
  const env = connectionEnvForResource(resource, projectSlug);
  const { secret } = splitEnvForSecret(env);
  const providerGeneratedCredentials = secretContainsProviderPlaceholder(secret);
  const credentialsSecretName = `${name}-connection`;
  const manifests: any[] = [
    {
      apiVersion: 'raibitserver.io/v1alpha1',
      kind,
      metadata: { name, namespace, labels },
      spec: {
        type: entry.type,
        engine: entry.key,
        version: resource.version || entry.defaultVersion,
        plan: resource.plan || 'shared-small',
        region: resource.region || 'local',
        storageGb: Number(resource.storageGb || defaultStorageGb(entry.key)),
        databaseName: databaseLike(entry.type) ? (resource.databaseName || slugify(resource.database || resource.name || 'app')) : undefined,
        bucket: entry.key === 'object-storage' ? (resource.bucket || slugify(resource.name || 'bucket')) : undefined,
        collection: ['vector-db', 'qdrant'].includes(entry.key) ? (resource.collection || slugify(resource.name || 'collection')) : undefined,
        topic: ['message-queue', 'nats'].includes(entry.key) ? (resource.topic || slugify(resource.name || 'events')) : undefined,
        username: supportsUsername(entry.type) ? (resource.username || slugify(resource.username || resource.name || 'app')) : undefined,
        provider: resource.provider || 'shared-provider',
        backup: resource.backup || defaultBackup(entry.type),
        credentialsMode: providerGeneratedCredentials ? 'provider-generated' : (Object.keys(secret).length ? 'provided-secret' : 'none'),
        ...(providerGeneratedCredentials ? { generatedCredentialsSecretName: credentialsSecretName } : {}),
        ...(!providerGeneratedCredentials && Object.keys(secret).length ? { credentialsSecretName } : {}),
      },
    },
  ];
  if (Object.keys(secret).length && !providerGeneratedCredentials) {
    manifests.push({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: credentialsSecretName, namespace, labels },
      type: 'Opaque',
      stringData: secret,
    });
  }
  return {
    name,
    namespace,
    organizationSlug,
    projectSlug,
    catalogKey: entry.key,
    resourceKind: kind,
    operator: entry.operator,
    provider: resource.provider || 'shared-provider',
    lifecycle: providerLifecycle(entry.key, resource.provider),
    envKeys: entry.env,
    providerPlan: providerPlanForResource(entry.key, resource),
    consoleSurface: providerConsoleSurface(resource),
    manifests,
  };
}

function secretContainsProviderPlaceholder(secret: Record<string, any>) {
  return Object.values(secret || {}).some((value) => String(value).includes('provider-managed-'));
}

export function compileProjectProvisioning(projectSpec: Record<string, any>) {
  const organization = projectSpec.organization || { slug: projectSpec.organizationSlug || 'org' };
  const project = projectSpec.project || { slug: projectSpec.slug || projectSpec.name || 'project' };
  const namespace = slugify(`${organization.slug || organization.name || 'org'}-${project.slug || project.name || 'project'}`);
  const projectSlug = slugify(project.slug || project.name || 'project');
  const organizationSlug = slugify(organization.slug || organization.name || 'org');
  const plans = (projectSpec.resources || []).map((resource: Record<string, any>) => compileResourceProvisioningPlan(resource, { namespace, projectSlug, organizationSlug }));
  return {
    namespace,
    projectSlug,
    organizationSlug,
    plans,
    manifests: plans.flatMap((plan) => plan.manifests),
  };
}

export async function provisionProjectResources(projectSpec: Record<string, any>, options: Record<string, any> = {}) {
  const provisioning = compileProjectProvisioning(projectSpec);
  const apply = await applyManifests(provisioning.manifests, options);
  const providerResults = [];
  if (options.providerMode === 'direct' || options.directProviders === true) {
    for (const resource of projectSpec.resources || []) {
      providerResults.push(await provisionResourceProvider({ ...resource, projectSlug: provisioning.projectSlug }, options[normalizeResourceEngine(resource.engine || resource.type)] || options));
    }
  }
  return { provisioning: maskSecrets(provisioning), apply, providerResults: maskSecrets(providerResults) };
}

function managedKindFor(type: string, key: string) {
  if (type === 'database') return 'ManagedDatabase';
  if (type === 'cache') return 'ManagedCache';
  if (type === 'storage' || key === 'object-storage') return 'ManagedObjectStorage';
  if (type === 'vector') return 'ManagedVectorDatabase';
  if (type === 'queue') return 'ManagedMessageQueue';
  return 'ManagedResource';
}

function databaseLike(type: string) {
  return type === 'database';
}

function supportsUsername(type: string) {
  return ['database', 'queue'].includes(type);
}

function defaultBackup(type: string) {
  if (['database', 'storage', 'vector'].includes(type)) return { schedule: 'daily', retentionDays: 7 };
  return null;
}

function defaultStorageGb(engine: string) {
  if (['postgresql', 'mysql', 'mariadb', 'mongodb'].includes(engine)) return 10;
  if (engine === 'redis' || engine === 'valkey') return 1;
  return 5;
}

function providerLifecycle(engine: string, provider: any) {
  if (engine === 'postgresql' && String(provider || '').includes('direct')) return ['desired-state-write', 'create-user', 'create-database', 'grant-privileges', 'provider-secret', 'connection-test', 'backup-plan', 'metrics'];
  return ['desired-state-write', 'shared-provider-reconcile', 'credentials-secret', 'backup-policy', 'metrics'];
}

function providerPlanForResource(engine: string, resource: Record<string, any>) {
  if (engine === 'postgresql') return publicProviderPlan(buildPostgresProviderPlan(resource));
  return publicResourceProviderPlan(buildResourceProviderPlan(resource));
}
