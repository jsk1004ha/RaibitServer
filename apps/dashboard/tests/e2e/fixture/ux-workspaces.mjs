const projects = [
  { id: 'prj_ux_alpha', organizationId: 'org_ux_alpha', organizationSlug: 'alpha', name: '알파 홈페이지', slug: 'alpha-web', status: 'active' },
  { id: 'prj_ux_beta', organizationId: 'org_ux_beta', organizationSlug: 'beta', name: '베타 홈페이지', slug: 'beta-web', status: 'active' },
];
const services = [
  { id: 'svc_ux_alpha', projectId: 'prj_ux_alpha', name: '알파 웹', type: 'web', status: 'running', sourceType: 'github' },
  { id: 'svc_ux_beta', projectId: 'prj_ux_beta', name: '베타 웹', type: 'web', status: 'running', sourceType: 'github' },
];

export function uxWorkspaceResponse({ token, method, pathname }) {
  if (token !== 'fixture-ux-workspaces' || method !== 'GET') return null;
  if (pathname === '/auth/me') return { status: 200, body: {
    user: { id: 'usr_ux', name: '라이빗 사용자', email: 'ux@fixture.test', role: 'USER', approvalStatus: 'APPROVED' },
    subject: { userId: 'usr_ux', organizationId: 'org_ux_alpha', userRole: 'USER' },
    memberships: projects.map((project) => ({ organizationId: project.organizationId, organizationSlug: project.organizationSlug, organizationName: project.organizationId === 'org_ux_alpha' ? '알파 팀' : '베타 팀', role: 'OWNER' })),
  } };
  if (pathname === '/projects') return { status: 200, body: { projects } };
  for (const project of projects) {
    const projectServices = services.filter((service) => service.projectId === project.id);
    if (pathname === `/projects/${project.id}/services`) return { status: 200, body: { services: projectServices } };
    if (pathname === `/projects/${project.id}/overview`) return { status: 200, body: { project, services: projectServices, deployments: [], resources: [] } };
  }
  return null;
}
