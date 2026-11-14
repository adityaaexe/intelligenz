/**
 * The real executor.
 *
 * It drives the platform's actual runtime — the same `OpencodeCliRuntime` the worker
 * uses — through a *narrow structural interface* declared here rather than imported.
 *
 * Why not import the package: this package must typecheck on its own. `agent-runtime`
 * is edited by another unit in the same phase, and an evaluation harness that fails to
 * compile because a runtime option was renamed is a harness that will be deleted from
 * CI the first time it is inconvenient. The module is loaded dynamically, by URL, and
 * adapted at the boundary; if the shape is wrong, the run fails loudly with
 * `RUNTIME_UNAVAILABLE` instead of silently measuring a stub.
 *
 * The seam is small on purpose: `health()`, `execute()`, and `id`.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Executor, ExecutorContext, ExecutorOutcome, ExecuteInput } from '../runner';

const RUNTIME_MODULE_URL = new URL('../../../agent-runtime/src/index.ts', import.meta.url).href;

export class RuntimeUnavailableError extends Error {
  readonly code = 'RUNTIME_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeUnavailableError';
  }
}

interface PlatformUsage {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly usd?: number;
}

interface PlatformResult {
  readonly status: 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  readonly summary: string;
  readonly usage: PlatformUsage;
  readonly error?: { readonly code: string; readonly message: string };
  readonly runtimeVersion?: string;
  readonly toolInvocations?: readonly unknown[];
  readonly providerMeta?: Readonly<Record<string, unknown>>;
}

interface PlatformRuntime {
  readonly id: string;
  health(): Promise<{ readonly status: 'ok' | 'degraded' | 'down'; readonly detail?: string }>;
  execute(request: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<PlatformResult>;
}

type RuntimeConstructor = new (options: Readonly<Record<string, unknown>>) => PlatformRuntime;

export interface RealExecutorOptions {
  readonly model: string;
  readonly upstreamBaseUrl: string;
  readonly integrationId: string;
  readonly credentialDatabasePath: string;
  readonly brokerMaxRequests?: number;
}

/** Reads the same variables the Phase 4 proofs read, with the same defaults. */
export function realExecutorOptionsFromEnv(environment: NodeJS.ProcessEnv): RealExecutorOptions {
  const model = environment['AGENT_MODEL']?.trim();

  if (model === undefined || model.length === 0) {
    throw new RuntimeUnavailableError(
      'AGENT_MODEL is not set. Real mode refuses to start without a model id.',
    );
  }

  const home = environment['HOME'] ?? '';

  return {
    model,
    upstreamBaseUrl:
      environment['AGENT_BROKER_UPSTREAM_URL'] ??
      'https://generativelanguage.googleapis.com/v1beta/openai',
    integrationId: environment['AGENT_BROKER_CREDENTIAL'] ?? 'google',
    credentialDatabasePath:
      environment['AGENT_BROKER_CREDENTIAL_DB'] ??
      join(home, '.local', 'share', 'opencode', 'opencode.db'),
  };
}

async function loadRuntimeConstructor(): Promise<RuntimeConstructor> {
  let module: Record<string, unknown>;

  try {
    module = (await import(RUNTIME_MODULE_URL)) as Record<string, unknown>;
  } catch (error) {
    throw new RuntimeUnavailableError(
      `could not load ${RUNTIME_MODULE_URL}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const candidate = module['OpencodeCliRuntime'];
  if (typeof candidate !== 'function') {
    throw new RuntimeUnavailableError(
      'agent-runtime does not export OpencodeCliRuntime; real mode needs a real adapter',
    );
  }

  return candidate as unknown as RuntimeConstructor;
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class RealExecutor implements Executor {
  readonly kind = 'real' as const;
  readonly runtimeId = 'opencode-cli';
  readonly runtimeVersion: string | null = null;
  readonly model: string;

  private readonly options: RealExecutorOptions;
  private readonly constructorPromise: Promise<RuntimeConstructor>;
  private artifactsRoot = '';
  private runtimeCtor: RuntimeConstructor | null = null;

  constructor(options: RealExecutorOptions) {
    this.options = options;
    this.model = options.model;
    this.constructorPromise = loadRuntimeConstructor();
  }

  private runtimeOptions(workspaceRoot: string, artifactsRoot: string, maxUsd: number): Record<string, unknown> {
    return {
      workspaceRoot,
      artifactsRoot,
      model: this.options.model,
      maxUsd,
      broker: {
        upstreamBaseUrl: this.options.upstreamBaseUrl,
        credential: {
          kind: 'opencode-db',
          databasePath: this.options.credentialDatabasePath,
          integrationId: this.options.integrationId,
        },
        maxRequests: this.options.brokerMaxRequests ?? 200,
      },
    };
  }

  async prepare(context: ExecutorContext): Promise<void> {
    this.artifactsRoot = context.artifactsRoot;
    this.runtimeCtor = await this.constructorPromise;

    if (context.capUsd === null) {
      throw new RuntimeUnavailableError('real mode requires an explicit --cap-usd');
    }

    const probe = new this.runtimeCtor(
      this.runtimeOptions(context.workspaceRoot, context.artifactsRoot, 1),
    );
    const health = await probe.health();

    if (health.status !== 'ok') {
      throw new RuntimeUnavailableError(
        `runtime health is "${health.status}": ${health.detail ?? 'no detail reported'}`,
      );
    }
  }

  async execute(input: ExecuteInput): Promise<ExecutorOutcome> {
    const ctor = this.runtimeCtor;
    if (ctor === null) {
      throw new RuntimeUnavailableError('prepare() was not called');
    }

    // A runtime per run so the benchmark's own spend ceiling applies to this run and
    // not to the suite: a benchmark capped at $0.02 must not inherit a $0.25 allowance.
    const runtime = new ctor(
      this.runtimeOptions(input.workspaceRoot, this.artifactsRoot, input.maxUsd),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const result = await runtime.execute(
        {
          taskId: input.taskId,
          goal: input.benchmark.goal,
          allowedPaths: [input.repoPath],
          allowedActions: [],
          riskClass: 'LOW',
          timeoutMs: input.timeoutMs,
          budgetUsd: input.maxUsd,
          correlationId: input.taskId,
          workspaceRoot: input.workspaceRoot,
        },
        controller.signal,
      );

      const attempts = await this.findRunDirectories(input.taskId);

      return {
        status: result.status,
        summary: result.summary,
        tokensIn: numberOrNull(result.usage.tokensIn),
        tokensOut: numberOrNull(result.usage.tokensOut),
        costUsd: numberOrNull(result.usage.usd),
        costSource: numberOrNull(result.usage.usd) === null ? 'unreported' : 'provider',
        retries: numberOrNull(
          typeof result.providerMeta?.['retries'] === 'number'
            ? (result.providerMeta['retries'] as number)
            : undefined,
        ),
        toolInvocations: result.toolInvocations?.length ?? 0,
        // Informational only. The judges decide whether the run actually refused
        // something; a summary sentence is not evidence.
        refused: /\brefused\b/i.test(result.summary),
        termination: null,
        artifactDirs: attempts,
        error: result.error === undefined ? null : { code: result.error.code, message: result.error.message },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The runtime names its run directory `<taskId>-<base36>`. */
  private async findRunDirectories(runId: string): Promise<string[]> {
    if (this.artifactsRoot.length === 0) return [];

    const root = join(this.artifactsRoot, 'opencode-cli');
    const entries = await readdir(root).catch(() => [] as string[]);

    return entries.filter((entry) => entry.startsWith(`${runId}-`)).map((entry) => join(root, entry));
  }
}
