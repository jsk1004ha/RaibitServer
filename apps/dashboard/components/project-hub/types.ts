import type { DashboardLoadIssue } from '@/lib/api';
import type { ResourceAvailability } from '@raibitserver/schemas';

export const projectViews = ['overview', 'services', 'new-service', 'edit-service', 'deployments', 'agent', 'resources', 'new-resource', 'environment', 'logs', 'settings'] as const;
export type ProjectView = (typeof projectViews)[number];

export type ProjectRecord = Readonly<{
  id?: string;
  name?: string;
  slug?: string;
  status?: string;
  organizationSlug?: string;
  organization?: Readonly<{ name?: string; slug?: string }>;
}>;

export type ServiceRecord = Readonly<{
  id: string;
  name?: string;
  slug?: string;
  status?: string;
  type?: string;
  sourceType?: string;
  buildMode?: string;
  repoUrl?: string;
  branch?: string;
  rootDirectory?: string;
  buildContext?: string;
  dockerfilePath?: string;
  imageUrl?: string;
  image?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  port?: string | number;
  desiredState?: Partial<ServiceRecord>;
  desiredSpec?: Partial<ServiceRecord>;
}>;

export type DeploymentRecord = Readonly<{
  id: string;
  serviceName?: string;
  deploymentType?: string;
  status?: string;
  imageDigest?: string;
  imageUrl?: string;
}>;

export type ResourceRecord = Readonly<{
  id: string;
  name?: string;
  engine?: string;
  status?: string;
}>;

export type EnvironmentEntry = Readonly<{
  key: string;
  source?: string;
  isSecret?: boolean;
  value?: string;
  valueMasked?: string;
}>;

export type AgentFinding = Readonly<{
  code: string;
  field?: string;
  severity?: string;
  message?: string;
}>;

export type AgentService = Readonly<{
  serviceId: string;
  name?: string;
  type?: string;
  eligible?: boolean;
  findings?: readonly AgentFinding[];
}>;

export type AgentPlan = Readonly<{
  generatedBy?: string;
  summary?: string;
  blocked?: boolean;
  canApply?: boolean;
  deploymentOrder?: readonly string[];
  services?: readonly AgentService[];
  security?: Readonly<{ critical?: number; high?: number }>;
}>;

export type RuntimeLog = Readonly<{
  id?: string;
  createdAt?: string;
  timestamp?: string;
  level?: string;
  type?: string;
  line?: string;
  message?: string;
}>;

export type ProjectHubData = Readonly<{
  agentPlan: AgentPlan | null;
  base: string;
  deletionPending: boolean;
  deployments: readonly DeploymentRecord[];
  editedEnvironment: EnvironmentEntry | null;
  environmentEntries: readonly EnvironmentEntry[];
  environmentService: ServiceRecord | null;
  loadErrors: readonly DashboardLoadIssue[];
  logService: ServiceRecord | null;
  mainLink: Readonly<{ href: string; label: string }> | null;
  project: ProjectRecord;
  projectId: string;
  projectName: string;
  previewDeployments: readonly DeploymentRecord[];
  resources: readonly ResourceRecord[];
  resourceOptions?: readonly (ResourceAvailability & { engine: string })[];
  runtimeLogs: readonly RuntimeLog[];
  selectedService: ServiceRecord | null;
  serviceSettings: ServiceRecord | null;
  services: readonly ServiceRecord[];
  view: ProjectView;
}>;
