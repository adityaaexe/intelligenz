import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertAdapterScratchBudget,
  findWorkspaceRoot,
  loadWorkerConfig,
  resolveScratchRoot,
  resolveSourceRepo,
  resolveWorkspaceRoot,
} from '../src/config';
import {
  createAgentRuntime,
  getAgentRuntime,
  resetAgentRuntime,
  runtimeRequiresWorkspace,
} from '../src/runtime';

/**
 * Runtime selection is a safety property, not a preference.
 *
 * The failure this file exists to prevent: a deployment that never set `AGENT_RUNTIME`
 * silently running a real, credentialed adapter — spending provider credit and touching
 * a filesystem — because the default was "whatever is installed".
 */

const BASE = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/intelligenz' } as const;

afterEach(() => {
  resetAgentRuntime();
});

describe('AGENT_RUNTIME selection', () => {
  it('defaults to local-simulated when the variable is absent or blank', () => {
    expect(loadWorkerConfig({ ...BASE }).execution.runtimeId).toBe('local-simulated');
    expect(loadWorkerConfig({ ...BASE, AGENT_RUNTIME: '   ' }).execution.runtimeId).toBe(
      'local-simulated',
    );
  });

  it('accepts opencode-cli as an explicit opt-in', () => {
    const config = loadWorkerConfig({ ...BASE, AGENT_RUNTIME: 'opencode-cli' });

    expect(config.execution.runtimeId).toBe('opencode-cli');
  });

  it('refuses an unknown adapter instead of guessing', () => {
    expect(() => loadWorkerConfig({ ...BASE, AGENT_RUNTIME: 'codex' })).toThrow(
      /AGENT_RUNTIME must be one of/,
    );
  });

  it('builds the adapter the id names', () => {
    const simulated = createAgentRuntime(loadWorkerConfig({ ...BASE }));
    const real = createAgentRuntime(
      loadWorkerConfig({
        ...BASE,
        AGENT_RUNTIME: 'opencode-cli',
        WORKSPACE_ROOT: '/tmp/intelligenz-workspaces',
        AGENT_MODEL: 'commandcode/deepseek/deepseek-v4-flash',
        AGENT_MAX_USD: '0.25',
      }),
    );

    expect(simulated.id).toBe('local-simulated');
    expect(real.id).toBe('opencode-cli');
    expect(runtimeRequiresWorkspace(simulated.id)).toBe(false);
    expect(runtimeRequiresWorkspace(real.id)).toBe(true);
  });

  it('memoises one instance per process', () => {
    const config = loadWorkerConfig({ ...BASE });

    expect(getAgentRuntime(config)).toBe(getAgentRuntime(config));
  });
});

describe('workspace configuration', () => {
  it('resolves a relative root against the repository, not the process cwd', () => {
    expect(resolveWorkspaceRoot('.workspaces', '/home/dev/intelligenz')).toBe(
      '/home/dev/intelligenz/.workspaces',
    );
    expect(resolveWorkspaceRoot(undefined, '/repo')).toBe('/repo/.workspaces');
    expect(resolveWorkspaceRoot('/var/lib/intelligenz/ws', '/repo')).toBe(
      '/var/lib/intelligenz/ws',
    );
  });

  it('treats an unset source repository as an empty workspace, never a fallback', () => {
    expect(resolveSourceRepo(undefined, '/repo')).toBeUndefined();
    expect(resolveSourceRepo('  ', '/repo')).toBeUndefined();
    expect(resolveSourceRepo('infra/fixtures/sample-repo', '/repo')).toBe(
      '/repo/infra/fixtures/sample-repo',
    );
  });

  it('parses the real-run levers', () => {
    const config = loadWorkerConfig({
      ...BASE,
      WORKSPACE_ROOT: 'var/ws',
      WORKSPACE_SOURCE_REPO: 'infra/fixtures/sample-repo',
      AGENT_MODEL: 'commandcode/deepseek/deepseek-v4-flash',
      AGENT_MAX_USD: '0.5',
    });

    expect(config.workspace.root).toBe(resolveWorkspaceRoot('var/ws', findWorkspaceRoot()));
    expect(config.workspace.sourceRepo).toBe(
      resolveSourceRepo('infra/fixtures/sample-repo', findWorkspaceRoot()),
    );
    expect(config.execution.model).toBe('commandcode/deepseek/deepseek-v4-flash');
    expect(config.execution.maxUsd).toBe(0.5);
  });

  it('rejects a negative spend cap rather than silently ignoring it', () => {
    expect(() => loadWorkerConfig({ ...BASE, AGENT_MAX_USD: '-1' })).toThrow(/AGENT_MAX_USD/);
  });
});

describe('adapter scratch root', () => {
  it('defaults to a short path outside the repository', () => {
    expect(resolveScratchRoot(undefined, '/repo')).toBe(join(tmpdir(), 'intelligenz-runtime'));
  });

  it('accepts a root whose worst-case egress socket fits the unix-socket limit', () => {
    expect(() => assertAdapterScratchBudget('/tmp/intelligenz-runtime')).not.toThrow();
  });

  it('refuses a root that would truncate the egress socket path', () => {
    // 113-byte path: exactly the defect observed on the first real run.
    const longRoot = `/home/ubuntu/intelligenz/${'a'.repeat(40)}/artifacts`;

    expect(() => assertAdapterScratchBudget(longRoot)).toThrow(/AGENT_RUNTIME_SCRATCH_ROOT/);
  });

  it('fails at boot when a real adapter is selected with a bad scratch root', () => {
    expect(() =>
      loadWorkerConfig({
        ...BASE,
        AGENT_RUNTIME: 'opencode-cli',
        AGENT_RUNTIME_SCRATCH_ROOT: `/home/ubuntu/intelligenz/${'a'.repeat(40)}/artifacts`,
      }),
    ).toThrow(/fails silently at model-call time with ECONNRESET/);
  });

  it('does not apply the budget to the simulated adapter', () => {
    expect(() =>
      loadWorkerConfig({
        ...BASE,
        AGENT_RUNTIME_SCRATCH_ROOT: `/home/ubuntu/intelligenz/${'a'.repeat(40)}/artifacts`,
      }),
    ).not.toThrow();
  });
});
