'use client';

import { LoaderCircleIcon } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

type QueryRow = Readonly<Record<string, unknown>>;

type NormalizedQueryResult = Readonly<{
  fields: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
  rowCount: number;
  rows: readonly QueryRow[];
  warning: string | null;
}>;

type ResourceQueryConsoleProps = Readonly<{
  action: string;
  defaultQuery: string;
  returnTo: string;
}>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeRow(value: unknown): QueryRow {
  return recordValue(value) ?? { value };
}

function normalizeQueryResult(payload: unknown): NormalizedQueryResult {
  const envelope = recordValue(payload) ?? {};
  const body = recordValue(envelope.result) ?? envelope;
  const rows = Array.isArray(body.rows) ? body.rows.map(normalizeRow) : [];
  const declaredFields = Array.isArray(body.fields)
    ? body.fields.filter((field): field is string => typeof field === 'string')
    : [];
  const fields = declaredFields.length
    ? declaredFields
    : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const rowCount = Number.isFinite(Number(body.rowCount)) ? Number(body.rowCount) : rows.length;
  const metadata = Object.fromEntries(
    Object.entries(body).filter(([key]) => !['fields', 'rows', 'warning'].includes(key)),
  );
  return {
    fields,
    metadata,
    rowCount,
    rows,
    warning: typeof body.warning === 'string' ? body.warning : null,
  };
}

function cellText(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ResourceQueryConsole({ action, defaultQuery, returnTo }: ResourceQueryConsoleProps) {
  const runningRef = useRef(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [result, setResult] = useState<NormalizedQueryResult | null>(null);
  const metadataText = useMemo(
    () => result ? JSON.stringify(result.metadata, null, 2) : '',
    [result],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setIsRunning(true);
    try {
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ confirmed, query }),
      });
      if (!response.ok) {
        setError('쿼리를 실행하지 못했습니다. 권한과 쿼리 내용을 확인해 주세요.');
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      setResult(normalizeQueryResult(payload));
    } catch {
      setError('쿼리를 실행하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.');
    } finally {
      runningRef.current = false;
      setIsRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-raibit-xl">
      <form action={action} method="post" onSubmit={handleSubmit}>
        <input name="_returnTo" type="hidden" value={returnTo} />
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="resource-query">쿼리</FieldLabel>
            <Textarea
              className="font-mono"
              id="resource-query"
              name="query"
              onChange={(event) => setQuery(event.currentTarget.value)}
              required
              rows={10}
              value={query}
            />
            <FieldDescription>변경 쿼리의 확인 필요 여부는 백엔드가 최종 판단합니다.</FieldDescription>
          </Field>
          <label className="confirmation-control">
            <input
              checked={confirmed}
              name="confirmed"
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
              type="checkbox"
              value="true"
            />
            <span>변경 쿼리 확인</span>
          </label>
          <Button disabled={isRunning} type="submit">
            {isRunning ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" data-icon="inline-start" /> : null}
            {isRunning ? '실행 중' : '쿼리 실행'}
          </Button>
        </FieldGroup>
      </form>

      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}

      {result ? (
        <section aria-label="쿼리 결과" aria-live="polite" className="flex min-w-0 flex-col gap-raibit-md">
          <header className="flex flex-wrap items-end justify-between gap-raibit-sm border-b border-border pb-raibit-sm">
            <div>
              <h3 className="text-sm font-medium">쿼리 결과</h3>
              <p className="text-sm text-muted-foreground">{result.rowCount.toLocaleString('ko-KR')}개 행</p>
            </div>
          </header>
          {result.warning ? <Alert variant="notice"><AlertDescription>{result.warning}</AlertDescription></Alert> : null}
          {result.rows.length > 0 && result.fields.length > 0 ? (
            <div className="overflow-x-auto rounded-sm border border-border">
              <Table>
                <TableHeader>
                  <TableRow>{result.fields.map((field) => <TableHead key={field}>{field}</TableHead>)}</TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row, rowIndex) => (
                    <TableRow key={rowIndex}>
                      {result.fields.map((field) => (
                        <TableCell className="max-w-80 whitespace-normal font-mono text-xs [overflow-wrap:anywhere]" key={field}>
                          {cellText(row[field])}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>반환된 행이 없습니다.</EmptyTitle>
                <EmptyDescription>쿼리는 정상적으로 완료되었습니다.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <details>
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground">실행 정보</summary>
            <pre className="code-panel mt-raibit-sm max-h-64 overflow-auto p-raibit-md text-xs">{metadataText}</pre>
          </details>
        </section>
      ) : null}
    </div>
  );
}
