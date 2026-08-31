export const projectWizardSteps = [
  { id: 'project', label: '프로젝트', description: '이름과 식별자', heading: '프로젝트 기본 정보' },
  { id: 'source', label: '저장소', description: '코드 위치 연결', heading: '저장소 연결' },
  { id: 'service', label: '서비스', description: '첫 실행 단위', heading: '첫 서비스' },
  { id: 'resources', label: '리소스', description: '데이터 계층 선택', heading: '관리형 리소스' },
] as const;

export type ProjectWizardStepId = typeof projectWizardSteps[number]['id'];

export function projectWizardStepIndex(stepId: ProjectWizardStepId) {
  return projectWizardSteps.findIndex((step) => step.id === stepId);
}

export function nextProjectWizardStep(stepId: ProjectWizardStepId): ProjectWizardStepId {
  const currentIndex = projectWizardStepIndex(stepId);
  return projectWizardSteps[Math.min(currentIndex + 1, projectWizardSteps.length - 1)].id;
}

export function previousProjectWizardStep(stepId: ProjectWizardStepId): ProjectWizardStepId {
  const currentIndex = projectWizardStepIndex(stepId);
  return projectWizardSteps[Math.max(currentIndex - 1, 0)].id;
}

export function isFinalProjectWizardStep(stepId: ProjectWizardStepId) {
  return stepId === 'resources';
}
