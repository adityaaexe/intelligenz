import { describe, expect, it } from 'vitest';

import {
  PLAN_TASK_KEY,
  PLAN_VERSION,
  PlannerProvenance,
  ProposedPlanV1,
  canonicalPlanContent,
  validateProposedPlan,
  type ProposedPlanV1 as ProposedPlan,
} from './plan';
import { planContentHash } from './plan-hash';

/**
 * The proposal contract: what a model may say, what it may not, and what a plan hash covers.
 *
 * Every rejection here is a case the API must refuse *before* a human is asked to decide,
 * or the decision would be about content that cannot be executed. The tests are pure: no
 * database, no HTTP, no model.
 */

function task(key: string, dependsOn: readonly string[] = []) {
  return {
    key,
    title: `Task ${key}`,
    goal: `Do the thing the key ${key} names.`,
    acceptanceCriteria: [`${key} is done.`],
    dependsOn: [...dependsOn],
    riskClass: 'LOW' as const,
  };
}

function plan(): ProposedPlan {
  return {
    version: PLAN_VERSION,
    objective: 'Ship a small, checkable change.',
    tasks: [task('spec'), task('build', ['spec']), task('verify', ['build'])],
    assumptions: [],
    unresolved: [],
  };
}

/** Parses, or throws with the schema's own message — a silent default would hide the cause. */
function parse(value: unknown): ProposedPlan {
  const result = ProposedPlanV1.safeParse(value);

  if (!result.success) throw new Error(result.error.issues.map((issue) => issue.message).join('; '));

  return result.data;
}

function codes(value: unknown): readonly string[] {
  return validateProposedPlan(value as ProposedPlan).issues.map((issue) => issue.code);
}

describe('ProposedPlanV1', () => {
  it('accepts a three-task linear plan', () => {
    const parsed = parse(plan());

    expect(parsed.tasks.map((entry) => entry.key)).toEqual(['spec', 'build', 'verify']);
    expect(validateProposedPlan(parsed)).toEqual({ ok: true, issues: [] });
  });

  it('defaults dependsOn, assumptions and unresolved rather than requiring them', () => {
    const parsed = parse({
      version: 1,
      objective: 'One task.',
      tasks: [
        {
          key: 'only',
          title: 'Only task',
          goal: 'The only thing to do.',
          acceptanceCriteria: ['It is done.'],
          riskClass: 'MEDIUM',
        },
      ],
    });

    expect(parsed.tasks[0]?.dependsOn).toEqual([]);
    expect(parsed.assumptions).toEqual([]);
    expect(parsed.unresolved).toEqual([]);
  });

  it('rejects a version it does not know', () => {
    expect(ProposedPlanV1.safeParse({ ...plan(), version: 2 }).success).toBe(false);
  });

  it('rejects a plan that claims its own provider, status or programme', () => {
    // The whole point of `.strict()`: these keys are not dropped, they fail the parse. A
    // model cannot attest to its own provenance or skip the human decision by asserting a
    // status the server owns.
    for (const extra of [
      { provider: 'http-llm' },
      { simulated: false },
      { status: 'approved' },
      { approvedContentHash: 'abc' },
      { programmeId: '00000000-0000-4000-8000-000000000000' },
    ]) {
      expect(ProposedPlanV1.safeParse({ ...plan(), ...extra }).success).toBe(false);
    }
  });

  it('rejects an unknown risk class', () => {
    const invalid = { ...plan(), tasks: [{ ...task('task-a'), riskClass: 'SEVERE' }] };

    expect(ProposedPlanV1.safeParse(invalid).success).toBe(false);
  });

  it('rejects a task key that is a uuid or otherwise not a slug', () => {
    expect(PLAN_TASK_KEY.test('build')).toBe(true);
    expect(PLAN_TASK_KEY.test('a1')).toBe(true);
    expect(PLAN_TASK_KEY.test('Build')).toBe(false);
    expect(PLAN_TASK_KEY.test('-build')).toBe(false);
    expect(PLAN_TASK_KEY.test('a')).toBe(false);
    expect(PLAN_TASK_KEY.test('4b2a1f2e-0000-4000-8000-000000000000')).toBe(false);

    const invalid = { ...plan(), tasks: [{ ...task('Build') }] };

    expect(ProposedPlanV1.safeParse(invalid).success).toBe(false);
  });

  it('rejects a title over 120 characters and a goal over 4000', () => {
    expect(
      ProposedPlanV1.safeParse({
        ...plan(),
        tasks: [{ ...task('task-a'), title: 'x'.repeat(121) }],
      }).success,
    ).toBe(false);

    expect(
      ProposedPlanV1.safeParse({
        ...plan(),
        tasks: [{ ...task('task-a'), goal: 'x'.repeat(4001) }],
      }).success,
    ).toBe(false);
  });

  it('rejects more than 50 tasks', () => {
    const tasks = Array.from({ length: 51 }, (_unused, index) => task(`task-${String(index)}`));

    expect(ProposedPlanV1.safeParse({ ...plan(), tasks }).success).toBe(false);
  });

  it('rejects a task with no acceptance criteria at the schema boundary', () => {
    expect(
      ProposedPlanV1.safeParse({
        ...plan(),
        tasks: [{ ...task('task-a'), acceptanceCriteria: [] }],
      }).success,
    ).toBe(false);
  });

  it('rejects a title that is only whitespace', () => {
    expect(
      ProposedPlanV1.safeParse({ ...plan(), tasks: [{ ...task('task-a'), title: '   ' }] }).success,
    ).toBe(false);
  });
});

describe('validateProposedPlan', () => {
  it('rejects a dependency cycle through the shared validator', () => {
    const cyclic = {
      ...plan(),
      tasks: [task('alpha', ['gamma']), task('beta', ['alpha']), task('gamma', ['beta'])],
    };

    const validation = validateProposedPlan(parse(cyclic));

    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toContain('cycle');
    // The message is translated back to plan keys: no synthetic `plan:` id leaks out.
    expect(validation.issues.every((issue) => !issue.message.includes('plan:'))).toBe(true);
  });

  it('rejects a dependency on a key that is not in the plan', () => {
    const invalid = { ...plan(), tasks: [task('spec'), task('build', ['missing'])] };

    const validation = validateProposedPlan(parse(invalid));

    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual([
      expect.objectContaining({ code: 'unknown_dependency', taskKey: 'build' }),
    ]);
    expect(validation.issues[0]?.message).toContain('missing');
    expect(validation.issues[0]?.message).not.toContain('plan:');
  });

  it('rejects a duplicate task key', () => {
    const validation = validateProposedPlan(parse({ ...plan(), tasks: [task('task-a'), task('task-a')] }));

    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(['duplicate_task']);
  });

  it('rejects a self-dependency as its own code, not as a cycle', () => {
    const validation = validateProposedPlan(parse({ ...plan(), tasks: [task('task-a', ['task-a'])] }));

    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(['self_dependency']);
  });

  it('reports missing acceptance criteria that only a stored row can carry', () => {
    // The schema refuses `[]`, and that is the right boundary for model output. The shared
    // validator still owns the rule because a `Task` row can hold an empty `text[]` — this
    // asserts the delegation, not a second check.
    const stored = {
      ...plan(),
      tasks: [{ ...task('task-a'), acceptanceCriteria: [] }],
    } as unknown as ProposedPlan;

    expect(codes(stored)).toEqual(['missing_acceptance_criteria']);
  });

  it('reports every defect rather than only the first', () => {
    const validation = validateProposedPlan(
      parse({ ...plan(), tasks: [task('task-a', ['missing']), task('task-b', ['task-b'])] }),
    );

    expect(validation.issues.map((issue) => issue.code).sort()).toEqual([
      'self_dependency',
      'unknown_dependency',
    ]);
  });
});

describe('canonicalPlanContent', () => {
  it('is byte-identical when the same tasks are emitted in a different order', () => {
    const first = parse(plan());
    const reordered = parse({ ...plan(), tasks: [...plan().tasks].reverse() });

    expect(canonicalPlanContent(reordered)).toBe(canonicalPlanContent(first));
    expect(planContentHash(reordered)).toBe(planContentHash(first));
  });

  it('is byte-identical when a dependsOn list is emitted in a different order', () => {
    const base = parse(plan());
    const shuffled = parse({
      ...plan(),
      tasks: [task('spec'), task('verify', ['build']), task('build', ['spec'])],
    });

    expect(planContentHash(shuffled)).toBe(planContentHash(base));

    const twoEdges = parse({
      ...plan(),
      tasks: [task('spec'), task('build'), task('verify', ['build', 'spec'])],
    });
    const reversedEdges = parse({
      ...plan(),
      tasks: [task('spec'), task('build'), task('verify', ['spec', 'build'])],
    });

    expect(canonicalPlanContent(reversedEdges)).toBe(canonicalPlanContent(twoEdges));
  });

  it('differs when one acceptance criterion changes', () => {
    const base = parse(plan());
    const changed = parse({
      ...plan(),
      tasks: plan().tasks.map((entry) =>
        entry.key === 'build'
          ? { ...entry, acceptanceCriteria: ['The build passes every check.'] }
          : entry,
      ),
    });

    expect(canonicalPlanContent(changed)).not.toBe(canonicalPlanContent(base));
    expect(planContentHash(changed)).not.toBe(planContentHash(base));
  });

  it('differs when the objective changes', () => {
    const base = parse(plan());
    const changed = parse({ ...plan(), objective: 'Ship a different objective.' });

    expect(planContentHash(changed)).not.toBe(planContentHash(base));
  });

  it('is a 64-character lower-case hex digest', () => {
    expect(planContentHash(parse(plan()))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PlannerProvenance', () => {
  it('defaults to simulated and a null model', () => {
    const provenance = PlannerProvenance.parse({ provider: 'http-llm' });

    expect(provenance).toEqual({ provider: 'http-llm', model: null, simulated: true });
  });

  it('accepts a real call, marked not simulated', () => {
    expect(
      PlannerProvenance.parse({ provider: 'http-llm', model: 'model-id', simulated: false }),
    ).toEqual({ provider: 'http-llm', model: 'model-id', simulated: false });
  });

  it('rejects an unknown field, so provenance cannot smuggle in plan authority', () => {
    expect(
      PlannerProvenance.safeParse({ provider: 'http-llm', approvedById: 'somebody' }).success,
    ).toBe(false);
  });
});
