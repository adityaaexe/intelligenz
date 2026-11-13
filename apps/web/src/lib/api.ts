import type {
  Approval,
  DataEnvelope,
  HealthReady,
  LoginResponse,
  Page,
  Project,
  Task,
  TaskDetail,
} from './types';

/**
 * The one API client.
 *
 * Every request goes through here, which is what makes three guarantees cheap:
 * the bearer token and `X-Org-Id` are attached in exactly one place; a network
 * failure and an HTTP failure are the same kind of value at the call site; and a
 * 401 can be turned into a redirect once instead of in every component.
 *
 * Error mapping follows `api-contract.md` §1 literally: `{ error: { code,
 * message, details }, correlationId }` for every failure, including framework
 * 404s. `GET /health/ready` is the documented exception — it answers with a
 * health document at both 200 and 503 (`api-contract.md` §7), so it is parsed
 * separately rather than forced through the envelope.
 */

export const DEFAULT_API_BASE_URL = 'http://localhost:4100';

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CURSOR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'APPROVAL_REQUIRED'
  | 'ALREADY_DECIDED'
  | 'TASK_NOT_CANCELLABLE'
  | 'WORKFLOW_ALREADY_RUNNING'
  | 'INVALID_TRANSITION'
  | 'ORCHESTRATOR_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  /** Client-side: the request never reached the API. */
  | 'NETWORK_ERROR'
  /** Client-side: the API answered with something that is not the contract. */
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly correlationId: string | null;
  readonly details: Readonly<Record<string, readonly string[]>> | null;

  constructor(
    code: ApiErrorCode,
    status: number,
    message: string,
    options: {
      readonly correlationId?: string | null;
      readonly details?: Readonly<Record<string, readonly string[]>> | null;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.correlationId = options.correlationId ?? null;
    this.details = options.details ?? null;
  }

  /** A redirect to `/login` is the only correct response to this. */
  get isUnauthorized(): boolean {
    return this.code === 'UNAUTHORIZED';
  }

  /** The token is valid; the membership or role is not. */
  get isForbidden(): boolean {
    return this.code === 'FORBIDDEN';
  }

  get isNetwork(): boolean {
    return this.code === 'NETWORK_ERROR';
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'VALIDATION_ERROR',
  'INVALID_CURSOR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'APPROVAL_REQUIRED',
  'ALREADY_DECIDED',
  'TASK_NOT_CANCELLABLE',
  'WORKFLOW_ALREADY_RUNNING',
  'INVALID_TRANSITION',
  'ORCHESTRATOR_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

function asCode(value: unknown): ApiErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value) ? (value as ApiErrorCode) : 'UNKNOWN';
}

function asDetails(value: unknown): Readonly<Record<string, readonly string[]>> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const out: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(entry)) {
      out[key] = entry.filter((item): item is string => typeof item === 'string');
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Pure mapping from an HTTP failure to a typed error. Exported for the unit
 * test: the mapping is the contract, so it is tested without a server.
 */
export function toApiError(status: number, body: unknown, headerCorrelationId?: string | null): ApiError {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const envelope = body as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
      correlationId?: unknown;
    };
    const code = asCode(envelope.error?.code);
    const message =
      typeof envelope.error?.message === 'string' && envelope.error.message.length > 0
        ? envelope.error.message
        : fallbackMessage(status);
    const correlationId =
      typeof envelope.correlationId === 'string'
        ? envelope.correlationId
        : (headerCorrelationId ?? null);
    return new ApiError(code, status, message, {
      correlationId,
      details: asDetails(envelope.error?.details),
    });
  }
  // A 5xx from a proxy, an HTML error page, or a truncated body: never pretend
  // the body matched the contract.
  return new ApiError(status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_RESPONSE', status, fallbackMessage(status), {
    correlationId: headerCorrelationId ?? null,
  });
}

function fallbackMessage(status: number): string {
  if (status === 0) {
    return 'The API could not be reached.';
  }
  if (status === 401) {
    return 'Your session has expired. Sign in again.';
  }
  if (status === 403) {
    return 'Your role in this organisation does not permit this request.';
  }
  if (status === 404) {
    return 'The requested record does not exist in this organisation.';
  }
  if (status >= 500) {
    return 'The API failed while handling the request.';
  }
  return `The API rejected the request with status ${status}.`;
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly getToken?: () => string | null;
  readonly getOrgId?: () => string | null;
  readonly onUnauthorized?: () => void;
  /** Milliseconds before a request is abandoned. */
  readonly timeoutMs?: number;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly getOrgId: () => string | null;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    this.getToken = options.getToken ?? (() => null);
    this.getOrgId = options.getOrgId ?? (() => null);
    this.onUnauthorized = options.onUnauthorized;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private headers(orgId?: string | null): HeadersInit {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = this.getToken();
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    const resolvedOrg = orgId ?? this.getOrgId();
    if (resolvedOrg !== null && resolvedOrg !== undefined) {
      headers['x-org-id'] = resolvedOrg;
    }
    return headers;
  }

  private async send(path: string, init: RequestInit, orgId?: string | null): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(orgId), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: 'no-store',
      });
    } catch (cause) {
      const reason = cause instanceof Error && cause.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      throw new ApiError('NETWORK_ERROR', 0, `The API ${reason} at ${this.baseUrl}.`, {
        correlationId: null,
      });
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private async fail(response: Response): Promise<never> {
    const body = await this.readJson(response);
    const error = toApiError(response.status, body, response.headers.get('x-correlation-id'));
    if (error.isUnauthorized) {
      this.onUnauthorized?.();
    }
    throw error;
  }

  /** `{ data }` success envelope. */
  private async request<T>(path: string, init: RequestInit = {}, orgId?: string | null): Promise<T> {
    const response = await this.send(path, init, orgId);
    if (!response.ok) {
      await this.fail(response);
    }
    const body = await this.readJson(response);
    if (typeof body !== 'object' || body === null || !('data' in body)) {
      throw new ApiError('INVALID_RESPONSE', response.status, 'The API answered without a data envelope.');
    }
    return (body as DataEnvelope<T>).data;
  }

  private async requestPage<T>(path: string, orgId?: string | null): Promise<Page<T>> {
    const response = await this.send(path, {}, orgId);
    if (!response.ok) {
      await this.fail(response);
    }
    const body = await this.readJson(response);
    if (typeof body !== 'object' || body === null || !('data' in body) || !('meta' in body)) {
      throw new ApiError('INVALID_RESPONSE', response.status, 'The API answered without a page envelope.');
    }
    return body as Page<T>;
  }

  /* --- endpoints ------------------------------------------------------ */

  /** No auth. `503` is a valid answer: it carries the per-dependency document. */
  async health(): Promise<HealthReady> {
    const response = await this.send('/health/ready', {});
    const body = await this.readJson(response);
    if (typeof body === 'object' && body !== null && 'checks' in body) {
      return body as HealthReady;
    }
    if (response.status === 503) {
      // A 503 without a document means the process itself is down behind a proxy.
      return {
        status: 'not_ready',
        service: 'unknown',
        checks: {},
      };
    }
    await this.fail(response);
    throw new ApiError('INVALID_RESPONSE', response.status, 'Unexpected health response.');
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  /**
   * `api-contract.md` §4 lists this route as `{ data: [...] }` with no `meta`:
   * it is not paginated, so it is read as a plain envelope. Using the page
   * reader here was a real defect — it rejected a valid 200 response.
   */
  async listProjects(orgId: string, workspaceId: string): Promise<readonly Project[]> {
    return this.request<readonly Project[]>(
      `/v1/orgs/${orgId}/workspaces/${workspaceId}/projects`,
      {},
      orgId,
    );
  }

  async listTasks(orgId: string, projectId: string, limit = 100): Promise<Page<Task>> {
    return this.requestPage<Task>(
      `/v1/orgs/${orgId}/projects/${projectId}/tasks?limit=${limit}`,
      orgId,
    );
  }

  async getTask(orgId: string, taskId: string): Promise<TaskDetail> {
    return this.request<TaskDetail>(`/v1/orgs/${orgId}/tasks/${taskId}`, {}, orgId);
  }

  async listApprovals(orgId: string, limit = 50): Promise<Page<Approval>> {
    return this.requestPage<Approval>(`/v1/orgs/${orgId}/approvals?limit=${limit}`, orgId);
  }
}
