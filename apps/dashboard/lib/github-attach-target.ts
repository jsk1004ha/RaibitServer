import { z } from 'zod';

const targetQuery = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  serviceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
});
const serviceSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1),
  name: z.string().optional(), projectName: z.string().optional(),
});
type AttachService = Readonly<z.infer<typeof serviceSchema>>;
type AttachTarget = Readonly<{
  error: string | null;
  projectId: string | undefined;
  selectedService: AttachService | null;
  services: readonly AttachService[];
}>;

export function resolveGitHubAttachTarget(input: Readonly<{
  query: Readonly<Record<string, unknown>>;
  services: readonly unknown[];
  authorizedProjectIds: readonly string[];
}>): AttachTarget {
  const invalid: AttachTarget = { error: '연결 대상을 확인할 수 없습니다. 프로젝트에서 저장소 연결을 다시 열어 주세요.', projectId: undefined, selectedService: null, services: [] };
  const parsed = targetQuery.safeParse(input.query);
  if (!parsed.success) return invalid;
  const { projectId, serviceId } = parsed.data;
  if (projectId && !input.authorizedProjectIds.includes(projectId)) return invalid;
  const services = input.services.flatMap((value) => {
    const service = serviceSchema.safeParse(value);
    return service.success && input.authorizedProjectIds.includes(service.data.projectId)
      && (!projectId || service.data.projectId === projectId) ? [service.data] : [];
  });
  const selectedService = serviceId ? services.find((service) => service.id === serviceId) ?? null : null;
  if (serviceId && !selectedService) return invalid;
  return { error: null, projectId, selectedService, services };
}
