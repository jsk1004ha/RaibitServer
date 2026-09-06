import type { PlatformExpansionRow } from './feature-expansion-matrix';

export type PlatformExpansionReport = Readonly<{
  expectedScenarioCount: number;
  negativeScenarioCount: number;
  delegatedTask41ScenarioCount: number;
  delegatedScenarioCount: number;
}>;

export function validatePlatformExpansionMatrix(rows: readonly PlatformExpansionRow[]): PlatformExpansionReport;

export type PlatformExpansionResultingState = Readonly<{ source: 'ui' | 'fixture' | 'combined'; value: unknown }>;
export type PlatformExpansionSideEffects = Readonly<{ unchanged: true; before: unknown; after: unknown }>;
export type PlatformExpansionObservation =
  | Readonly<{ kind: 'http'; request: Readonly<{ method: string; url: string }>; response: Readonly<{ status: number; url: string; body: unknown }>; resultingState: PlatformExpansionResultingState; sideEffects?: PlatformExpansionSideEffects }>
  | Readonly<{ kind: 'client'; action: string; networkRequests: 0; resultingState: PlatformExpansionResultingState; sideEffects?: PlatformExpansionSideEffects }>
  | Readonly<{ kind: 'network-error'; request: Readonly<{ method: string; url: string }>; error: string; resultingState: PlatformExpansionResultingState; sideEffects?: PlatformExpansionSideEffects }>;

export type PlatformExpansionOutcome = Readonly<{
  status: 'passed';
  observation: PlatformExpansionObservation;
  a11y: Readonly<{ violations: 0 }>;
  representativeVisual: boolean;
  screenshot?: string;
}>;

export type PlatformExpansionRecorder = Readonly<{
  record(id: string, outcome: PlatformExpansionOutcome): void;
  finish(): Readonly<{ schema: 'raibit.task49.v1'; kind: 'positive' | 'negative'; expectedScenarioIds: readonly string[]; outcomes: readonly (PlatformExpansionOutcome & Readonly<{ id: string }>)[]; summary: Readonly<{ expected: number; passed: number; failed: 0; skipped: 0; unexpected: 0; flaky: 0 }> }>;
}>;

export function createOutcomeRecorder(rows: readonly PlatformExpansionRow[], kind: 'positive' | 'negative'): PlatformExpansionRecorder;
export function writePlatformExpansionReport(report: ReturnType<PlatformExpansionRecorder['finish']>, outputPath: string): Promise<string>;
