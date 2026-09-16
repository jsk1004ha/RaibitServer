export type ServiceType = 'web' | 'private' | 'worker' | 'cron' | 'job';
export type SourceType = 'github' | 'zip' | 'image' | 'local';
export type BuildMode = 'auto' | 'dockerfile' | 'buildpack' | 'custom' | 'prebuilt-image' | 'framework';
export type ResourceEngine = 'postgresql' | 'mysql' | 'mariadb' | 'mongodb' | 'redis' | 'object-storage' | 'vector-db' | 'message-queue';

export interface OrganizationSpec {
  name?: string;
  slug?: string;
  plan?: string;
}

export interface ProjectIdentity {
  name?: string;
  slug?: string;
  description?: string;
}

export interface ServiceSpec {
  name: string;
  type?: ServiceType;
  sourceType?: SourceType;
  buildMode?: BuildMode;
  repoUrl?: string;
  branch?: string;
  commitSha?: string;
  commitHash?: string;
  rootDirectory?: string;
  buildContext?: string;
  dockerfilePath?: string;
  installCommand?: string;
  buildCommand?: string;
  customBuildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  image?: string;
  imageUrl?: string;
  port?: number;
  domain?: string;
  baseDomain?: string;
  tlsIssuer?: string;
  schedule?: string;
  command?: string[];
  args?: string[];
  environment?: Record<string, string>;
  attachedResources?: string[];
  scaling?: {
    minReplicas?: number;
    maxReplicas?: number;
    metrics?: unknown[];
  };
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  readonly healthCheck?: { readonly path?: string } | null;
  readonly healthCheckPath?: string | null;
  readonly livenessPath?: string | null;
  readonly readinessPath?: string | null;
  readonly publicHealthPath?: string | null;
  [key: string]: unknown;
}

export interface ResourceSpec {
  name: string;
  type?: string;
  engine?: ResourceEngine | string;
  provider?: string;
  plan?: string;
  region?: string;
  version?: string;
  storageGb?: number;
  databaseName?: string;
  username?: string;
  password?: string;
  port?: number;
  [key: string]: unknown;
}

export interface ProjectSpec {
  organization?: OrganizationSpec;
  organizationSlug?: string;
  project?: ProjectIdentity;
  name?: string;
  slug?: string;
  baseDomain?: string;
  registry?: string;
  services?: ServiceSpec[];
  resources?: ResourceSpec[];
  currentUsage?: Record<string, number>;
}

export interface BuildPlan {
  service: string;
  mode: BuildMode;
  sourceType: SourceType | string;
  image: string;
  reason: string;
  buildSteps: Array<Record<string, unknown>>;
  runtime: Record<string, unknown>;
  pipeline: string[];
}

export interface DomainServiceRoute {
  name: string;
  type: string;
  publicHostname: string | null;
  previewPattern: string;
  consoleHostname: string;
  internalHostname: string;
}

export interface DomainPlan {
  baseDomain: string;
  platform: Record<string, string>;
  workspace: string;
  project: string;
  services: DomainServiceRoute[];
  resources: Array<Record<string, string | undefined>>;
  wildcardTls: string[];
}
