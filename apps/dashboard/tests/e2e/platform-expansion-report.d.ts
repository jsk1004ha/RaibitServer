import type { PlatformExpansionRow } from './feature-expansion-matrix';

export type PlatformExpansionReport = Readonly<{
  expectedScenarioCount: number;
  contractPendingScenarioCount: number;
  delegatedScenarioCount: number;
  browserExecution: 'NOT_RUN';
}>;

export function validatePlatformExpansionMatrix(rows: readonly PlatformExpansionRow[]): PlatformExpansionReport;
