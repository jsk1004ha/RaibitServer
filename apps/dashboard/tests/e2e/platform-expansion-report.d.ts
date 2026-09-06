import type { PlatformExpansionRow } from './feature-expansion-matrix';

export type PlatformExpansionReport = Readonly<{
  expectedScenarioCount: number;
  negativeScenarioCount: number;
  delegatedTask41ScenarioCount: number;
  delegatedScenarioCount: number;
}>;

export function validatePlatformExpansionMatrix(rows: readonly PlatformExpansionRow[]): PlatformExpansionReport;

export type PlatformExpansionRecorder = Readonly<{
  record(id: string, outcome: Readonly<{ status: 'passed'; api: Readonly<{ status: number; method: string; path: string }>; a11y: string; representativeVisual: boolean; screenshot?: string }>): void;
  finish(): Readonly<{ schema: 'raibit.task49.v1'; kind: string; expectedScenarioIds: readonly string[]; outcomes: readonly unknown[]; summary: Readonly<{ expected: number; passed: number; failed: 0; skipped: 0; unexpected: 0; flaky: 0 }> }>;
}>;

export function createOutcomeRecorder(rows: readonly PlatformExpansionRow[], kind: string, requiredCoverageIds?: readonly string[]): PlatformExpansionRecorder;
export function writePlatformExpansionReport(report: ReturnType<PlatformExpansionRecorder['finish']>, outputPath: string): Promise<string>;
