import { RuntimeConfigurationError } from './errors';
import type { AgentRuntime } from './types';

/**
 * Runtime registry — id → adapter (ADR-006: "swapping in a real adapter is one file
 * plus a registration").
 *
 * A registry, not a factory map: the *instance* is registered, because an adapter
 * owns connection state and a per-call instance would re-connect (or re-launch a
 * sandbox) on every task.
 *
 * Duplicate ids are rejected. Two adapters responding to `local-simulated` would
 * make the id meaningless, and "which one ran?" would only be answerable from logs.
 */
export class RuntimeRegistry {
  readonly #runtimes = new Map<string, AgentRuntime>();

  register(runtime: AgentRuntime): void {
    if (runtime.id.trim().length === 0) {
      throw new RuntimeConfigurationError('A runtime must have a non-empty id.');
    }

    if (this.#runtimes.has(runtime.id)) {
      throw new RuntimeConfigurationError(
        `A runtime with id "${runtime.id}" is already registered. Registration is once per process.`,
      );
    }

    this.#runtimes.set(runtime.id, runtime);
  }

  /** Registers or replaces. Only for tests and deliberate reconfiguration. */
  override(runtime: AgentRuntime): void {
    this.#runtimes.set(runtime.id, runtime);
  }

  has(id: string): boolean {
    return this.#runtimes.has(id);
  }

  get(id: string): AgentRuntime {
    const runtime = this.#runtimes.get(id);

    if (runtime === undefined) {
      throw new RuntimeConfigurationError(
        `No runtime registered with id "${id}". Registered: ${
          this.list().map((candidate) => candidate.id).join(', ') || '(none)'
        }.`,
      );
    }

    return runtime;
  }

  list(): AgentRuntime[] {
    return [...this.#runtimes.values()];
  }

  listIds(): string[] {
    return [...this.#runtimes.keys()];
  }

  /** Test seam. Not exported from the package root. */
  clear(): void {
    this.#runtimes.clear();
  }
}

/** The process-wide registry. One adapter per id, one registry per process. */
export const runtimes = new RuntimeRegistry();

/**
 * The id Phase 2 ships. Named so that callers can be explicit about the fallback
 * without hard-coding a string in three places.
 */
export const DEFAULT_RUNTIME_ID = 'local-simulated';

export function registerRuntime(runtime: AgentRuntime): void {
  runtimes.register(runtime);
}

export function getRuntime(id: string = DEFAULT_RUNTIME_ID): AgentRuntime {
  return runtimes.get(id);
}
