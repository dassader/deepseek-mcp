import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  Cpu,
  Download,
  FileText,
  GitCompare,
  Hash,
  Inbox,
  RefreshCcw,
  Wallet,
} from "lucide-preact";
import "./styles.css";

type Scope = "active" | "archived";
type Page = "active" | "archived" | "stats";
type RequestStatus = "draft" | "pending" | "filling" | "filled" | "error";
type CreatedRange = "1h" | "6h" | "12h" | "1d" | "1w" | "all";
type ContentTab = "request" | "response" | "reasoning" | "error";
const VIRTUAL_LINE_HEIGHT = 22;
const VIRTUAL_WINDOW_LINES = 500;
const VIRTUAL_OVERSCAN_LINES = 60;

interface RequestSummary {
  id: string;
  title: string;
  created: string;
  updated: string;
  version: number;
  displayVersion: number;
  status: RequestStatus;
  size: number;
  tokens: number;
  lines: number;
  archived: boolean;
  hasResponse: boolean;
  hasReasoning: boolean;
  requestBytes: number;
  responseBytes?: number;
  reasoningBytes?: number;
  modifiedAt: string;
}

interface VersionSummary {
  version: number;
  displayVersion: number;
  isCurrent: boolean;
  requestStatus: RequestStatus;
  requestSize: number;
  requestTokens: number;
  requestLines: number;
  responseStatus?: string;
  responseSize?: number;
  responseTokens?: number;
  responseLines?: number;
  reasoningStatus?: string;
  reasoningSize?: number;
  reasoningTokens?: number;
  reasoningLines?: number;
}

interface RequestResource {
  request: RequestSummary & { error?: string; deepseekStatusCode?: number };
  content: string;
}

interface ResponseResource {
  response: {
    status: string;
    size: number;
    tokens: number;
    lines: number;
    error?: string;
  };
  content: string;
}

interface ReasoningResource {
  reasoning: {
    status: string;
    size: number;
    tokens: number;
    lines: number;
    error?: string;
  };
  content: string;
}

interface VersionDetail {
  request: RequestResource;
  response: string;
  reasoning: string;
  responseResource?: ResponseResource;
  reasoningResource?: ReasoningResource;
}

interface DiffLine {
  kind: "context" | "add" | "remove";
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface VirtualLine {
  kind?: "context" | "add" | "remove";
  text: string;
}

interface StatsTotals {
  requestCount: number;
  activeRequestCount: number;
  archivedRequestCount: number;
  versionCount: number;
  submittedVersionCount: number;
  filledVersionCount: number;
  errorVersionCount: number;
  sentBytes: number;
  receivedBytes: number;
  requestBytes: number;
  responseBytes: number;
  reasoningBytes: number;
  requestTokens: number;
  sentTokens: number;
  responseTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  estimatedCostCacheHitUsd: number;
  estimatedCostCacheMissUsd: number;
}

interface StatsRequestRow extends StatsTotals {
  id: string;
  title: string;
  archived: boolean;
  updated: string;
}

interface StatsPeriodRow extends StatsTotals {
  period: string;
}

interface StatsVersionRow {
  id: string;
  title: string;
  archived: boolean;
  version: number;
  displayVersion: number;
  status: RequestStatus;
  updated: string;
  model?: string;
  requestBytes: number;
  sentBytes: number;
  responseBytes: number;
  reasoningBytes: number;
  receivedBytes: number;
  requestTokens: number;
  sentTokens: number;
  responseTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  estimatedCostCacheHitUsd: number;
  estimatedCostCacheMissUsd: number;
}

interface StatsData {
  generatedAt: string;
  scope: "active" | "archived" | "all";
  createdRange: CreatedRange;
  assumptions: string[];
  totals: StatsTotals;
  byDay: StatsPeriodRow[];
  byMonth: StatsPeriodRow[];
  byModel: Array<StatsTotals & { model: string }>;
  byStatus: Array<StatsTotals & { status: string }>;
  requests: StatsRequestRow[];
  versions: StatsVersionRow[];
  topCostVersions: StatsVersionRow[];
  topTokenVersions: StatsVersionRow[];
}

interface AccountBalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

interface AccountBalance {
  isAvailable: boolean;
  balanceInfos: AccountBalanceInfo[];
}

const CREATED_RANGE_OPTIONS: Array<{ value: CreatedRange; label: string }> = [
  { value: "1h", label: "Последний час" },
  { value: "6h", label: "6 часов" },
  { value: "12h", label: "12 часов" },
  { value: "1d", label: "День" },
  { value: "1w", label: "Неделя" },
  { value: "all", label: "Все время" },
];
const CREATED_RANGE_VALUES = new Set<CreatedRange>(CREATED_RANGE_OPTIONS.map((item) => item.value));
const CREATED_RANGE_STORAGE_KEY = "deepseek-mcp-created-range";

function initialCreatedRange(): CreatedRange {
  try {
    const stored = window.localStorage.getItem(CREATED_RANGE_STORAGE_KEY);
    return CREATED_RANGE_VALUES.has(stored as CreatedRange) ? (stored as CreatedRange) : "1h";
  } catch {
    return "1h";
  }
}

function routePage(): Page {
  if (window.location.pathname.startsWith("/archive")) return "archived";
  if (window.location.pathname.startsWith("/stats")) return "stats";
  return "active";
}

function visibleVersion(value: { version: number; displayVersion?: number }): number {
  return value.displayVersion ?? value.version + 1;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/ui${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as { ok: boolean; data?: T; error?: { message?: string } };
  if (!response.ok || !body.ok) {
    throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  }
  return body.data as T;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("ru");
}

function compactDecimalText(value: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat("ru", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  }).format(number);
}

function formatBalanceInfo(info: AccountBalanceInfo): string {
  return `${compactDecimalText(info.totalBalance)} ${info.currency}`;
}

function formatAccountBalance(balance: AccountBalance | undefined): string {
  if (balance === undefined) return "";
  if (!balance.isAvailable) return "Недоступен";
  if (balance.balanceInfos.length === 0) return "0";
  return balance.balanceInfos.map(formatBalanceInfo).join(" · ");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusLabel(status: string): string {
  if (status === "draft") return "В работе";
  if (status === "pending" || status === "filling") return "Выполняется";
  if (status === "filled" || status === "empty") return "Готово";
  if (status === "error") return "Ошибка";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function lines(value: string): string[] {
  return value.length === 0 ? [] : value.split(/\r?\n/);
}

function diffLines(beforeText: string, afterText: string): DiffLine[] {
  const before = lines(beforeText);
  const after = lines(afterText);
  const table = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      result.push({ kind: "context", oldLine: i + 1, newLine: j + 1, text: before[i]! });
      i += 1;
      j += 1;
    } else if (j < after.length && (i === before.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      result.push({ kind: "add", newLine: j + 1, text: after[j]! });
      j += 1;
    } else if (i < before.length) {
      result.push({ kind: "remove", oldLine: i + 1, text: before[i]! });
      i += 1;
    }
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function textVirtualLines(value: string): VirtualLine[] {
  return lines(value).map((text) => ({ text }));
}

function VirtualContent({
  ariaLabel,
  emptyText,
  lines: virtualLines,
  resetKey,
}: {
  ariaLabel?: string;
  emptyText: string;
  lines: VirtualLine[];
  resetKey: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = 0;
    setScrollTop(0);
    setViewportHeight(element.clientHeight);
  }, [resetKey]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;

    function syncViewport() {
      setViewportHeight(element.clientHeight);
      setScrollTop(element.scrollTop);
    }

    syncViewport();
    const observer = new ResizeObserver(syncViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (virtualLines.length === 0) {
    return (
      <div class="virtual-scroll" aria-label={ariaLabel}>
        <div class="empty">{emptyText}</div>
      </div>
    );
  }

  const totalHeight = virtualLines.length * VIRTUAL_LINE_HEIGHT;
  const firstVisibleLine = Math.floor(scrollTop / VIRTUAL_LINE_HEIGHT);
  const visibleLineCount = Math.max(VIRTUAL_WINDOW_LINES, Math.ceil(viewportHeight / VIRTUAL_LINE_HEIGHT) + VIRTUAL_OVERSCAN_LINES * 2);
  const start = clamp(firstVisibleLine - VIRTUAL_OVERSCAN_LINES, 0, Math.max(virtualLines.length - visibleLineCount, 0));
  const end = Math.min(start + visibleLineCount, virtualLines.length);
  const visibleLines = virtualLines.slice(start, end);

  return (
    <div
      class="virtual-scroll"
      aria-label={ariaLabel}
      ref={scrollRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div class="virtual-scroll-spacer" style={{ height: `${totalHeight}px` }}>
        <div class="virtual-scroll-window" style={{ transform: `translateY(${start * VIRTUAL_LINE_HEIGHT}px)` }}>
          {visibleLines.map((line, index) => (
            <div class={line.kind === undefined ? "virtual-line" : `virtual-line diff-line ${line.kind}`} key={start + index}>
              <code>{line.text || " "}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function VirtualTextContent({ ariaLabel, content, emptyText, resetKey }: { ariaLabel?: string; content: string; emptyText: string; resetKey: string }) {
  const virtualLines = useMemo(() => textVirtualLines(content), [content]);
  return <VirtualContent ariaLabel={ariaLabel} emptyText={emptyText} lines={virtualLines} resetKey={resetKey} />;
}

function VirtualDiffContent({ ariaLabel, lines: diffVirtualLines, resetKey }: { ariaLabel: string; lines: DiffLine[]; resetKey: string }) {
  const virtualLines = useMemo(() => diffVirtualLines.map(({ kind, text }) => ({ kind, text })), [diffVirtualLines]);
  return <VirtualContent ariaLabel={ariaLabel} emptyText="Нет изменений" lines={virtualLines} resetKey={resetKey} />;
}

function SkeletonLine({ className = "" }: { className?: string }) {
  return <span class={`skeleton-line ${className}`} aria-hidden="true" />;
}

function RequestListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div class="request-row request-row-skeleton" aria-hidden="true" key={index}>
          <SkeletonLine className="skeleton-request-title" />
          <SkeletonLine className="skeleton-request-id" />
          <div class="row-time-grid">
            <SkeletonLine className="skeleton-request-time" />
            <SkeletonLine className="skeleton-request-time" />
          </div>
        </div>
      ))}
    </>
  );
}

function RequestRow({ request, selected, onSelect }: { request: RequestSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button class={selected ? "request-row selected" : "request-row"} onClick={onSelect}>
      <div class="row-head">
        <div class="row-title">
          <span>{request.title}</span>
        </div>
        <span class={`row-status row-status-${request.status}`}>{statusLabel(request.status)}</span>
      </div>
      <div class="row-id">{request.id}</div>
      <div class="row-time-grid">
        <span>
          Создан <time dateTime={request.created}>{formatDateTime(request.created)}</time>
        </span>
        <span>
          Обновлен <time dateTime={request.updated}>{formatDateTime(request.updated)}</time>
        </span>
      </div>
    </button>
  );
}

function AccountBalancePill({
  balance,
  loading,
  error,
}: {
  balance?: AccountBalance;
  loading: boolean;
  error: string;
}) {
  const value = error.length > 0 ? "Недоступен" : formatAccountBalance(balance);
  return (
    <div
      class={error.length > 0 ? "account-balance account-balance-error" : "account-balance"}
      title={error || "Текущий баланс DeepSeek"}
      aria-label={`Бюджет ${loading ? "загружается" : value || "-"}`}
    >
      <Wallet size={17} />
      <span>Бюджет</span>
      {loading ? <SkeletonLine className="skeleton-balance-value" /> : <strong>{value || "-"}</strong>}
    </div>
  );
}

function App() {
  const [page, setPage] = useState<Page>(routePage());
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [createdRange, setCreatedRange] = useState<CreatedRange>(initialCreatedRange);
  const [accountBalance, setAccountBalance] = useState<AccountBalance | undefined>();
  const [accountBalanceLoading, setAccountBalanceLoading] = useState(false);
  const [accountBalanceError, setAccountBalanceError] = useState("");
  const [loading, setLoading] = useState(false);
  const [statsRefreshKey, setStatsRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const scope: Scope = page === "archived" ? "archived" : "active";

  useEffect(() => {
    const onPopState = () => setPage(routePage());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CREATED_RANGE_STORAGE_KEY, createdRange);
    } catch {
      // The selected range still works for the current session when storage is unavailable.
    }
  }, [createdRange]);

  async function loadAccountBalance() {
    setAccountBalanceLoading(true);
    setAccountBalanceError("");
    try {
      setAccountBalance(await api<AccountBalance>("/account-balance"));
    } catch (err) {
      setAccountBalance(undefined);
      setAccountBalanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccountBalanceLoading(false);
    }
  }

  useEffect(() => {
    void loadAccountBalance();
  }, []);

  async function loadRequests(nextSelectedId = selectedId) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ scope });
      params.set("createdRange", createdRange);
      const data = await api<{ requests: RequestSummary[] }>(`/requests?${params.toString()}`);
      setRequests(data.requests);
      const stillVisible = data.requests.some((request) => request.id === nextSelectedId);
      setSelectedId(stillVisible ? nextSelectedId : data.requests[0]?.id ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (page !== "stats") {
      void loadRequests("");
    }
  }, [page, createdRange]);

  function navigate(nextPage: Page) {
    setPage(nextPage);
    window.history.pushState({}, "", nextPage === "archived" ? "/archive" : nextPage === "stats" ? "/stats" : "/");
  }

  function refreshCurrentPage() {
    void loadAccountBalance();
    if (page === "stats") {
      setStatsRefreshKey((value) => value + 1);
      return;
    }
    void loadRequests();
  }

  const selected = requests.find((request) => request.id === selectedId);

  return (
    <main>
      <header class="topbar">
        <div>
          <h1>DeepSeek MCP</h1>
        </div>
        <nav class="scope-tabs" aria-label="Разделы">
          <button class={page === "active" ? "active" : ""} onClick={() => navigate("active")}>
            <Inbox size={17} /> Активные
          </button>
          <button class={page === "archived" ? "active" : ""} onClick={() => navigate("archived")}>
            <Archive size={17} /> Архив
          </button>
          <button class={page === "stats" ? "active" : ""} onClick={() => navigate("stats")}>
            <BarChart3 size={17} /> Статистика
          </button>
        </nav>
        <div class="topbar-actions">
          <AccountBalancePill balance={accountBalance} loading={accountBalanceLoading} error={accountBalanceError} />
          <select value={createdRange} onChange={(event) => setCreatedRange(event.currentTarget.value as CreatedRange)}>
            {CREATED_RANGE_OPTIONS.map((item) => (
              <option value={item.value}>{item.label}</option>
            ))}
          </select>
          <button class="icon-button" title="Обновить" onClick={refreshCurrentPage}>
            <RefreshCcw size={17} />
          </button>
        </div>
      </header>

      {page === "stats" ? (
        <StatsPage createdRange={createdRange} refreshKey={statsRefreshKey} />
      ) : (
        <section class="workspace">
          <aside class="sidebar">
            {error && <div class="error">{error}</div>}
            <div class="request-list" aria-busy={loading ? "true" : "false"}>
              {loading ? (
                <RequestListSkeleton />
              ) : (
                requests.map((request) => <RequestRow key={request.id} request={request} selected={request.id === selectedId} onSelect={() => setSelectedId(request.id)} />)
              )}
              {!loading && requests.length === 0 && <div class="empty">Нет запросов</div>}
            </div>
          </aside>

          <RequestDetail selected={selected} scope={scope} loadingRequests={loading} onChanged={(id) => void loadRequests(id)} />
        </section>
      )}
    </main>
  );
}

type StatCardAccent = "default" | "send" | "receive" | "status" | "model";
type StatMetricTone = "neutral" | "success" | "warning" | "danger";

function StatsGroupCard({ title, icon, accent = "default", children }: { title: string; icon: ComponentChildren; accent?: StatCardAccent; children: ComponentChildren }) {
  return (
    <section class={`stat-group-card stat-card-${accent}`}>
      <div class="stat-card-head">
        <div class="stat-icon">{icon}</div>
        <h2>{title}</h2>
      </div>
      <div class="stat-metrics">{children}</div>
    </section>
  );
}

function StatMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail?: ComponentChildren; tone?: StatMetricTone }) {
  return (
    <div class={`stat-metric stat-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function StatMetricSkeleton({ label, wide = false, tone = "neutral" }: { label: string; wide?: boolean; tone?: StatMetricTone }) {
  return (
    <div class={`stat-metric stat-metric-${tone}`}>
      <span>{label}</span>
      <strong class={wide ? "stat-skeleton-value stat-skeleton-wide" : "stat-skeleton-value"} aria-hidden="true" />
    </div>
  );
}

function statusVersionCount(stats: StatsData, status: RequestStatus): number {
  return stats.byStatus.find((row) => row.status === status)?.versionCount ?? 0;
}

function modelTotals(stats: StatsData, model: string): StatsTotals & { model: string } {
  return (
    stats.byModel.find((row) => row.model === model) ?? {
      model,
      requestCount: 0,
      activeRequestCount: 0,
      archivedRequestCount: 0,
      versionCount: 0,
      submittedVersionCount: 0,
      filledVersionCount: 0,
      errorVersionCount: 0,
      sentBytes: 0,
      receivedBytes: 0,
      requestBytes: 0,
      responseBytes: 0,
      reasoningBytes: 0,
      requestTokens: 0,
      sentTokens: 0,
      responseTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
      estimatedCostCacheHitUsd: 0,
      estimatedCostCacheMissUsd: 0,
    }
  );
}

function ModelStatRow({ model, totals }: { model: string; totals: StatsTotals }) {
  return (
    <div class="stat-model-row">
      <div class="stat-model-head">
        <strong>{model}</strong>
        <span class="stat-model-count">{formatNumber(totals.submittedVersionCount)} запросов</span>
      </div>
      <div class="stat-model-token-grid">
        <div class="stat-model-token">
          <span>Отправлено</span>
          <strong>{formatNumber(totals.sentTokens)}</strong>
        </div>
        <div class="stat-model-token">
          <span>Получено</span>
          <strong>{formatNumber(totals.outputTokens)}</strong>
        </div>
      </div>
    </div>
  );
}

function ModelStatRowSkeleton({ model }: { model: string }) {
  return (
    <div class="stat-model-row">
      <div class="stat-model-head">
        <strong>{model}</strong>
        <span class="stat-skeleton-line stat-skeleton-short stat-model-count" aria-hidden="true" />
      </div>
      <div class="stat-model-token-grid">
        <div class="stat-model-token">
          <span>Отправлено</span>
          <strong class="stat-skeleton-value" aria-hidden="true" />
        </div>
        <div class="stat-model-token">
          <span>Получено</span>
          <strong class="stat-skeleton-value stat-skeleton-wide" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div class="stats-grid" aria-hidden="true">
      <StatsGroupCard title="Запросы" icon={<Inbox size={20} />}>
        <StatMetricSkeleton label="Всего запросов" />
        <StatMetricSkeleton label="Всего версий" />
        <StatMetricSkeleton label="В работе" />
        <StatMetricSkeleton label="Выполняется" tone="warning" />
        <StatMetricSkeleton label="Готово" tone="success" />
        <StatMetricSkeleton label="Ошибка" tone="danger" />
      </StatsGroupCard>
      <StatsGroupCard title="Трафик" icon={<BarChart3 size={20} />} accent="receive">
        <StatMetricSkeleton label="Отправлено" wide />
        <StatMetricSkeleton label="Получено" wide />
      </StatsGroupCard>
      <StatsGroupCard title="Токены" icon={<Hash size={20} />} accent="send">
        <StatMetricSkeleton label="Отправлено" />
        <StatMetricSkeleton label="Получено" />
        <StatMetricSkeleton label="Всего" wide />
      </StatsGroupCard>
      <StatsGroupCard title="Модели" icon={<Cpu size={20} />} accent="model">
        <ModelStatRowSkeleton model="deepseek-v4-pro" />
        <ModelStatRowSkeleton model="deepseek-v4-flash" />
      </StatsGroupCard>
    </div>
  );
}

function StatsPage({ createdRange, refreshKey }: { createdRange: CreatedRange; refreshKey: number }) {
  const [stats, setStats] = useState<StatsData | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadStats() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ scope: "all", createdRange });
      setStats(await api<StatsData>(`/stats?${params.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStats();
  }, [createdRange, refreshKey]);

  const totals = stats?.totals;
  const pro = stats ? modelTotals(stats, "deepseek-v4-pro") : undefined;
  const flash = stats ? modelTotals(stats, "deepseek-v4-flash") : undefined;
  const totalTokens = totals ? totals.sentTokens + totals.outputTokens : 0;
  const runningVersionCount = stats ? statusVersionCount(stats, "pending") + statusVersionCount(stats, "filling") : 0;

  return (
    <section class="stats-page" aria-busy={loading ? "true" : "false"}>
      {error && <div class="error">{error}</div>}

      {loading ? (
        <StatsSkeleton />
      ) : totals ? (
        <div class="stats-grid">
          <StatsGroupCard title="Запросы" icon={<Inbox size={20} />}>
            <StatMetric label="Всего запросов" value={formatNumber(totals.requestCount)} />
            <StatMetric label="Всего версий" value={formatNumber(totals.versionCount)} />
            <StatMetric label="В работе" value={formatNumber(statusVersionCount(stats, "draft"))} />
            <StatMetric label="Выполняется" value={formatNumber(runningVersionCount)} tone="warning" />
            <StatMetric label="Готово" value={formatNumber(statusVersionCount(stats, "filled"))} tone="success" />
            <StatMetric label="Ошибка" value={formatNumber(statusVersionCount(stats, "error"))} tone="danger" />
          </StatsGroupCard>
          <StatsGroupCard title="Трафик" icon={<BarChart3 size={20} />} accent="receive">
            <StatMetric label="Отправлено" value={formatBytes(totals.sentBytes)} />
            <StatMetric label="Получено" value={formatBytes(totals.receivedBytes)} />
          </StatsGroupCard>
          <StatsGroupCard title="Токены" icon={<Hash size={20} />} accent="send">
            <StatMetric label="Отправлено" value={formatNumber(totals.sentTokens)} />
            <StatMetric label="Получено" value={formatNumber(totals.outputTokens)} />
            <StatMetric label="Всего" value={formatNumber(totalTokens)} />
          </StatsGroupCard>
          {pro && (
            <StatsGroupCard title="Модели" icon={<Cpu size={20} />} accent="model">
              <ModelStatRow model="deepseek-v4-pro" totals={pro} />
              {flash && <ModelStatRow model="deepseek-v4-flash" totals={flash} />}
            </StatsGroupCard>
          )}
        </div>
      ) : null}
    </section>
  );
}

function versionToneClass(status: string | undefined): string {
  return status === undefined ? "" : `version-select-${status}`;
}

function versionErrorText(detail: VersionDetail | undefined): string {
  return [
    detail?.request.request.error,
    detail?.responseResource?.response.error,
    detail?.reasoningResource?.reasoning.error,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
}

function downloadTextFile(fileName: string, content: string): void {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function ContentInfoLine({ size, tokens, lines, children }: { size?: number; tokens?: number; lines?: number; children?: ComponentChildren }) {
  return (
    <div class="content-info-line">
      <span>Размер: {formatBytes(size)}</span>
      <span>Токены: {formatNumber(tokens ?? 0)}</span>
      <span>Строки: {formatNumber(lines ?? 0)}</span>
      {children && <div class="content-actions">{children}</div>}
    </div>
  );
}

function ContentInfoLineSkeleton({ withAction = false }: { withAction?: boolean }) {
  return (
    <div class="content-info-line" aria-hidden="true">
      <SkeletonLine className="skeleton-info-size" />
      <SkeletonLine className="skeleton-info-tokens" />
      <SkeletonLine className="skeleton-info-lines" />
      {withAction && (
        <div class="content-actions">
          <SkeletonLine className="skeleton-action-button" />
        </div>
      )}
    </div>
  );
}

function TextPanelSkeleton({ lines = 9 }: { lines?: number }) {
  return (
    <div class="content-skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <SkeletonLine className={index % 4 === 3 ? "skeleton-content-line skeleton-content-line-short" : "skeleton-content-line"} key={index} />
      ))}
    </div>
  );
}

function RequestDetailSkeleton({ selected, scope }: { selected?: RequestSummary; scope: Scope }) {
  return (
    <section class="detail" aria-busy="true">
      <div class="detail-head">
        <div class="detail-title-block">
          {selected ? <div class="eyebrow">{selected.id}</div> : <SkeletonLine className="skeleton-eyebrow" />}
          <div class="detail-title-row">
            <SkeletonLine className="skeleton-version-select" />
            {selected ? <h2>{selected.title}</h2> : <SkeletonLine className="skeleton-detail-title" />}
          </div>
        </div>
        <button class="primary-action" disabled>
          {scope === "archived" ? <ArchiveRestore size={17} /> : <Archive size={17} />}
          {scope === "archived" ? "Восстановить" : "В архив"}
        </button>
      </div>
      <section class="content-panel">
        <div class="content-tabs content-tabs-skeleton" aria-hidden="true">
          <SkeletonLine className="skeleton-tab" />
          <SkeletonLine className="skeleton-tab" />
          <SkeletonLine className="skeleton-tab" />
        </div>
        <ContentInfoLineSkeleton withAction />
        <TextPanelSkeleton />
      </section>
    </section>
  );
}

function RequestDetail({ selected, scope, loadingRequests, onChanged }: { selected?: RequestSummary; scope: Scope; loadingRequests: boolean; onChanged: (id: string) => void }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>();
  const [detail, setDetail] = useState<VersionDetail | undefined>();
  const [baseDetail, setBaseDetail] = useState<VersionDetail | undefined>();
  const [contentTab, setContentTab] = useState<ContentTab>("request");
  const [showDiff, setShowDiff] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [movingRequest, setMovingRequest] = useState(false);
  const [error, setError] = useState("");
  const busy = loadingVersions || loadingDetail || loadingDiff || movingRequest;

  useEffect(() => {
    if (!selected) {
      setVersions([]);
      setSelectedVersion(undefined);
      setDetail(undefined);
      setBaseDetail(undefined);
      setContentTab("request");
      setShowDiff(false);
      return;
    }
    setVersions([]);
    setSelectedVersion(undefined);
    setDetail(undefined);
    setBaseDetail(undefined);
    setContentTab("request");
    setShowDiff(false);
    setLoadingVersions(true);
    setError("");
    api<{ versions: VersionSummary[] }>(`/requests/${encodeURIComponent(selected.id)}`)
      .then((data) => {
        setVersions(data.versions);
        setSelectedVersion(data.versions.at(-1)?.version);
        setDetail(undefined);
        setBaseDetail(undefined);
        setContentTab("request");
        setShowDiff(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingVersions(false));
  }, [selected?.id]);

  useEffect(() => {
    setDetail(undefined);
    setBaseDetail(undefined);
    setContentTab("request");
    setShowDiff(false);
    if (!selected || selectedVersion === undefined) return;
    setLoadingDetail(true);
    setError("");
    api<VersionDetail>(`/requests/${encodeURIComponent(selected.id)}/versions/${selectedVersion}`)
      .then((current) => setDetail(current))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingDetail(false));
  }, [selected?.id, selectedVersion]);

  const selectedVersionSummary = versions.find((version) => version.version === selectedVersion);
  const hasResponse = selectedVersionSummary?.responseStatus !== undefined || detail?.responseResource !== undefined || (detail?.response.length ?? 0) > 0;
  const hasReasoning =
    selectedVersionSummary?.reasoningStatus !== undefined || detail?.reasoningResource !== undefined || (detail?.reasoning.length ?? 0) > 0;
  const errorText = versionErrorText(detail);
  const hasErrorTab = errorText.length > 0;

  useEffect(() => {
    const currentTabAvailable =
      contentTab === "request" || (contentTab === "response" && hasResponse) || (contentTab === "reasoning" && hasReasoning) || (contentTab === "error" && hasErrorTab);
    if (!currentTabAvailable) {
      setContentTab("request");
    }
  }, [contentTab, hasResponse, hasReasoning, hasErrorTab]);

  async function moveRequest() {
    if (!selected) return;
    setMovingRequest(true);
    setError("");
    try {
      const action = scope === "archived" ? "restore" : "archive";
      await api(`/requests/${encodeURIComponent(selected.id)}/${action}`, { method: "POST" });
      onChanged(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMovingRequest(false);
    }
  }

  async function toggleDiff() {
    if (!selected || selectedVersion === undefined) return;
    if (showDiff) {
      setShowDiff(false);
      return;
    }
    setShowDiff(true);
    if (selectedVersion > 0 && baseDetail === undefined) {
      setLoadingDiff(true);
      setError("");
      try {
        const baseVersion = selectedVersion - 1;
        setBaseDetail(await api<VersionDetail>(`/requests/${encodeURIComponent(selected.id)}/versions/${baseVersion}`));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setShowDiff(false);
        return;
      } finally {
        setLoadingDiff(false);
      }
    }
  }

  function downloadResponse() {
    if (!selected || selectedVersion === undefined || detail === undefined) return;
    const displayVersion = selectedVersionSummary === undefined ? visibleVersion({ version: selectedVersion }) : visibleVersion(selectedVersionSummary);
    downloadTextFile(`${selected.id}-v${displayVersion}-response.md`, detail.responseResource?.content ?? detail.response);
  }

  const diffBaseContent = selectedVersion === 0 ? "" : (baseDetail?.request.content ?? "");
  const diff = useMemo(() => (showDiff ? diffLines(diffBaseContent, detail?.request.content ?? "") : []), [diffBaseContent, detail, showDiff]);
  const selectedDisplayVersion =
    selectedVersion === undefined ? undefined : selectedVersionSummary === undefined ? visibleVersion({ version: selectedVersion }) : visibleVersion(selectedVersionSummary);
  const selectedVersionLabel =
    selectedVersionSummary === undefined ? (selectedDisplayVersion === undefined ? "" : `v${selectedDisplayVersion}`) : `v${visibleVersion(selectedVersionSummary)} · ${statusLabel(selectedVersionSummary.requestStatus)}`;
  const baseDisplayVersion = baseDetail === undefined ? undefined : visibleVersion(baseDetail.request.request);
  const diffTitle =
    selectedVersion === undefined
      ? "REQUEST.md diff"
      : selectedVersion === 0
        ? `REQUEST.md diff initial..v${selectedDisplayVersion}`
        : baseDetail?.request.request.version === 0 && baseDetail.request.content.length === 0
          ? `REQUEST.md diff initial..v${selectedDisplayVersion}`
          : `REQUEST.md diff v${baseDisplayVersion ?? selectedVersion}..v${selectedDisplayVersion}`;
  const requestContent = detail?.request.content ?? "";
  const responseContent = detail?.responseResource?.content ?? detail?.response ?? "";
  const reasoningContent = detail?.reasoningResource?.content ?? detail?.reasoning ?? "";
  const requestSize = selectedVersionSummary?.requestSize ?? detail?.request.request.size;
  const requestTokens = selectedVersionSummary?.requestTokens ?? detail?.request.request.tokens;
  const requestLines = selectedVersionSummary?.requestLines ?? detail?.request.request.lines;
  const responseSize = selectedVersionSummary?.responseSize ?? detail?.responseResource?.response.size;
  const responseTokens = selectedVersionSummary?.responseTokens ?? detail?.responseResource?.response.tokens;
  const responseLines = selectedVersionSummary?.responseLines ?? detail?.responseResource?.response.lines;
  const reasoningSize = selectedVersionSummary?.reasoningSize ?? detail?.reasoningResource?.reasoning.size;
  const reasoningTokens = selectedVersionSummary?.reasoningTokens ?? detail?.reasoningResource?.reasoning.tokens;
  const reasoningLines = selectedVersionSummary?.reasoningLines ?? detail?.reasoningResource?.reasoning.lines;

  if (loadingRequests || (selected && (loadingVersions || loadingDetail))) {
    return <RequestDetailSkeleton selected={selected} scope={scope} />;
  }

  if (!selected) {
    return (
      <section class="detail empty-detail">
        <FileText size={34} />
        <span>Выберите запрос</span>
      </section>
    );
  }

  return (
    <section class="detail">
      <div class="detail-head">
        <div class="detail-title-block">
          <div class="eyebrow">{selected.id}</div>
          <div class="detail-title-row">
            {versions.length > 0 && (
              <span class="version-select-wrap" data-value={selectedVersionLabel}>
                <select
                  class={`version-select ${versionToneClass(selectedVersionSummary?.requestStatus)}`}
                  value={selectedVersion ?? ""}
                  onChange={(event) => setSelectedVersion(Number(event.currentTarget.value))}
                >
                  {versions.map((version) => (
                    <option class={`version-option ${versionToneClass(version.requestStatus)}`} value={version.version}>
                      v{visibleVersion(version)} · {statusLabel(version.requestStatus)}
                    </option>
                  ))}
                </select>
              </span>
            )}
            <h2>{selected.title}</h2>
          </div>
        </div>
        <button class="primary-action" disabled={busy} onClick={() => void moveRequest()}>
          {scope === "archived" ? <ArchiveRestore size={17} /> : <Archive size={17} />}
          {scope === "archived" ? "Восстановить" : "В архив"}
        </button>
      </div>

      {error && <div class="error">{error}</div>}

      {selectedVersion === undefined ? (
        <section class="content-panel">
          <div class="empty">Запрос пока пуст</div>
        </section>
      ) : (
        <section class="content-panel">
          <div class="content-tabs">
            <button class={contentTab === "request" ? "active" : ""} onClick={() => setContentTab("request")}>
              Request
            </button>
            <button class={contentTab === "response" ? "active" : ""} onClick={() => setContentTab("response")} disabled={!hasResponse}>
              Response
            </button>
            <button class={contentTab === "reasoning" ? "active" : ""} onClick={() => setContentTab("reasoning")} disabled={!hasReasoning}>
              Reasoning
            </button>
            {hasErrorTab && (
              <button class={contentTab === "error" ? "active" : ""} onClick={() => setContentTab("error")}>
                Ошибка
              </button>
            )}
          </div>

          {contentTab === "request" && (
            <ContentInfoLine size={requestSize} tokens={requestTokens} lines={requestLines}>
              <button class="secondary-action" disabled={busy || detail === undefined} onClick={() => void toggleDiff()}>
                <GitCompare size={16} />
                {showDiff ? "Обычный вид" : "Показать Diff"}
              </button>
            </ContentInfoLine>
          )}
          {contentTab === "response" && (
            <ContentInfoLine size={responseSize} tokens={responseTokens} lines={responseLines}>
              <button class="secondary-action" disabled={responseContent.length === 0} onClick={downloadResponse}>
                <Download size={16} />
                Скачать
              </button>
            </ContentInfoLine>
          )}
          {contentTab === "reasoning" && <ContentInfoLine size={reasoningSize} tokens={reasoningTokens} lines={reasoningLines} />}

          {contentTab === "request" ? (
            showDiff ? (
              loadingDiff ? (
                <TextPanelSkeleton lines={6} />
              ) : (
                <VirtualDiffContent ariaLabel={diffTitle} lines={diff} resetKey={`${selected.id}:${selectedVersion}:diff`} />
              )
            ) : (
              <VirtualTextContent ariaLabel="Request" content={requestContent} emptyText="Request is empty" resetKey={`${selected.id}:${selectedVersion}:request`} />
            )
          ) : (
            <VirtualTextContent
              ariaLabel={contentTab}
              content={contentTab === "response" ? responseContent : contentTab === "reasoning" ? reasoningContent : errorText}
              emptyText={contentTab === "response" ? "Response is empty" : contentTab === "reasoning" ? "Reasoning is empty" : "Ошибка пуста"}
              resetKey={`${selected.id}:${selectedVersion}:${contentTab}`}
            />
          )}
        </section>
      )}
    </section>
  );
}

render(<App />, document.getElementById("app")!);
