"use client";

import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import type { SystemStatusSnapshot, SystemStatusTone } from "../lib/system-status";

// prettier-ignore
const overallCopy = {
  operational: { title: "모든 시스템 정상", detail: "RAIBIT SERVER가 정상 작동 중입니다." },
  degraded: { title: "일부 확인 필요", detail: "일부 기능이 지연되고 있습니다." },
  outage: { title: "시스템 장애", detail: "핵심 기능을 확인하고 있습니다." },
} as const satisfies Record<SystemStatusTone, Readonly<{ title: string; detail: string }>>;

// prettier-ignore
const statusPresentation = {
  operational: { label: "정상", variant: "default" },
  degraded: { label: "지연", variant: "secondary" },
  outage: { label: "장애", variant: "destructive" },
} as const satisfies Record<SystemStatusTone, Readonly<{ label: string; variant: "default" | "secondary" | "destructive" }>>;

export function SystemStatusPanel({
  initialStatus,
}: Readonly<{ initialStatus: SystemStatusSnapshot }>) {
  const [snapshot, setSnapshot] = useState(initialStatus);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const copy = overallCopy[snapshot.status];

  const refresh = useCallback(async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch("/api/status", {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isSystemStatusSnapshot(payload))
        throw new StatusResponseError();
      setSnapshot(payload);
      setStale(false);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        setStale(true);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(
      () => void refresh(),
      snapshot.refreshIntervalSeconds * 1000,
    );
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      requestRef.current?.abort();
    };
  }, [refresh, snapshot.refreshIntervalSeconds]);

  return (
    <section
      className="mx-auto w-full max-w-7xl px-raibit-lg pb-raibit-huge sm:px-raibit-xl"
      aria-labelledby="system-status-title"
      aria-busy={refreshing}
    >
      <header className="grid gap-raibit-xl border-b border-border py-raibit-xxl sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="flex min-w-0 items-start gap-raibit-lg">
          <span
            className="mt-raibit-xs size-4 shrink-0 rounded-full bg-primary shadow-[0_0_0_8px_rgb(9_25_54/0.08)]"
            aria-hidden="true"
          />
          <div>
            <h2
              className="text-display-md font-medium text-foreground"
              id="system-status-title"
            >
              {copy.title}
            </h2>
            <p className="mt-raibit-sm text-body-md text-muted-foreground">
              {copy.detail}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="icon-lg"
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label={refreshing ? "상태 확인 중" : "상태 새로고침"}
        >
          {refreshing ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
        </Button>
      </header>
      <div className="border-b border-border" role="list" aria-live="polite">
        {snapshot.components.map((component, index) => {
          const presentation = statusPresentation[component.status];
          return (
            <div
              className="grid min-h-24 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-raibit-md border-b border-border py-raibit-lg last:border-b-0 sm:grid-cols-[4rem_minmax(0,1fr)_auto]"
              role="listitem"
              key={component.id}
            >
              <span className="font-mono text-caption text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <strong className="block text-heading-md font-medium text-foreground">
                  {component.name}
                </strong>
                <small className="mt-raibit-xs block text-caption text-pretty text-muted-foreground">
                  {component.detail}
                  {component.latencyMs === null
                    ? ""
                    : ` · ${component.latencyMs}ms`}
                </small>
              </div>
              <Badge variant={presentation.variant}>{presentation.label}</Badge>
            </div>
          );
        })}
      </div>
      <footer
        className="flex flex-col gap-raibit-sm py-raibit-lg text-caption text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
        aria-live="polite"
      >
        <span className={stale ? "font-medium text-destructive" : undefined}>
          {stale
            ? "자동 갱신 지연"
            : `${snapshot.refreshIntervalSeconds}초 자동 갱신`}
        </span>
        <span className="flex flex-wrap items-center gap-raibit-sm">
          <span>배포 버전</span>
          {snapshot.deployment.commitUrl &&
          snapshot.deployment.shortCommitSha ? (
            <a
              className="font-mono text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
              href={snapshot.deployment.commitUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`GitHub 커밋 ${snapshot.deployment.commitSha}`}
            >
              {snapshot.deployment.shortCommitSha}
            </a>
          ) : (
            <strong className="text-foreground">확인 불가</strong>
          )}
        </span>
        <time dateTime={snapshot.checkedAt}>
          최근 확인 {formatCheckedAt(snapshot.checkedAt)}
        </time>
      </footer>
    </section>
  );
}

class StatusResponseError extends Error {
  constructor() {
    super("invalid_status_response");
    this.name = "StatusResponseError";
  }
}

function isSystemStatusSnapshot(value: unknown): value is SystemStatusSnapshot {
  if (
    !isRecord(value) ||
    !isTone(value.status) ||
    typeof value.checkedAt !== "string" ||
    typeof value.refreshIntervalSeconds !== "number" ||
    !Number.isFinite(value.refreshIntervalSeconds) ||
    !Array.isArray(value.components) ||
    !isDeploymentVersion(value.deployment)
  )
    return false;
  return value.components.every(
    (component) =>
      isRecord(component) &&
      typeof component.id === "string" &&
      typeof component.name === "string" &&
      typeof component.detail === "string" &&
      isTone(component.status) &&
      (component.latencyMs === null || typeof component.latencyMs === "number"),
  );
}

function isDeploymentVersion(
  value: unknown,
): value is SystemStatusSnapshot["deployment"] {
  if (!isRecord(value)) return false;
  const fields = [
    value.repository,
    value.commitSha,
    value.shortCommitSha,
    value.commitUrl,
  ];
  if (!fields.every((field) => field === null || typeof field === "string"))
    return false;
  if (
    value.repository !== null &&
    (typeof value.repository !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(
        value.repository,
      ))
  )
    return false;
  if (
    value.commitSha !== null &&
    (typeof value.commitSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(value.commitSha))
  )
    return false;
  const shortCommit =
    typeof value.commitSha === "string" ? value.commitSha.slice(0, 12) : null;
  if (value.shortCommitSha !== shortCommit) return false;
  const expectedUrl =
    typeof value.repository === "string" && typeof value.commitSha === "string"
      ? `https://github.com/${value.repository}/commit/${value.commitSha}`
      : null;
  return value.commitUrl === expectedUrl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isTone(value: unknown): value is SystemStatusTone {
  return value === "operational" || value === "degraded" || value === "outage";
}
function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 중";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
