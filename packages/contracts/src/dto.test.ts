import { describe, expect, it } from 'vitest';

import {
  CreateProjectInput,
  CreateTaskInput,
  LoginInput,
  PaginationQuery,
  UpdateTaskStatusInput,
} from './dto';

describe('LoginInput', () => {
  it('lower-cases and trims the email before it reaches the database', () => {
    const parsed = LoginInput.parse({
      email: '  Owner@Northwind.TEST ',
      password: 'Passw0rd!demo',
    });

    expect(parsed.email).toBe('owner@northwind.test');
  });

  it('rejects a password shorter than 8 characters', () => {
    const result = LoginInput.safeParse({ email: 'a@b.test', password: 'short' });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown field', () => {
    const result = LoginInput.safeParse({
      email: 'a@b.test',
      password: 'Passw0rd!demo',
      orgId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.success).toBe(false);
  });
});

describe('CreateProjectInput', () => {
  it('accepts a 2-8 character upper-case key', () => {
    expect(
      CreateProjectInput.parse({ key: 'CTRL', name: 'Control Plane', environment: 'prod' }),
    ).toEqual({ key: 'CTRL', name: 'Control Plane', environment: 'prod' });
  });

  it.each(['c', 'ctrl', 'TOOLONG99', 'CT-RL'])('rejects the key %s', (key) => {
    expect(CreateProjectInput.safeParse({ key, name: 'Project', environment: 'dev' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown environment', () => {
    expect(
      CreateProjectInput.safeParse({ key: 'CTRL', name: 'Project', environment: 'qa' }).success,
    ).toBe(false);
  });
});

describe('CreateTaskInput', () => {
  const base = {
    title: 'Add tenant-scoped task listing',
    goal: 'List tasks for one project, paginated, scoped by orgId.',
    riskClass: 'MEDIUM',
    acceptanceCriteria: ['Returns 25 rows by default'],
  };

  it('accepts a payload without priority', () => {
    expect(CreateTaskInput.parse(base).priority).toBeUndefined();
  });

  it('accepts a payload with priority and risk class', () => {
    const parsed = CreateTaskInput.parse({ ...base, priority: 'high', riskClass: 'CRITICAL' });

    expect(parsed.priority).toBe('high');
    expect(parsed.riskClass).toBe('CRITICAL');
  });

  it('rejects more than 20 acceptance criteria', () => {
    const result = CreateTaskInput.safeParse({
      ...base,
      acceptanceCriteria: Array.from({ length: 21 }, (_, index) => `criterion ${index}`),
    });

    expect(result.success).toBe(false);
  });

  it('rejects a title longer than 120 characters', () => {
    const result = CreateTaskInput.safeParse({ ...base, title: 'x'.repeat(121) });

    expect(result.success).toBe(false);
  });

  it('rejects a goal longer than 4000 characters', () => {
    const result = CreateTaskInput.safeParse({ ...base, goal: 'x'.repeat(4001) });

    expect(result.success).toBe(false);
  });
});

describe('UpdateTaskStatusInput', () => {
  it('requires a reason when moving a task to ready', () => {
    const result = UpdateTaskStatusInput.safeParse({ status: 'ready' });

    expect(result.success).toBe(false);
  });

  it('accepts ready with a reason', () => {
    expect(
      UpdateTaskStatusInput.parse({ status: 'ready', reason: 'Retry after quota reset' }),
    ).toEqual({ status: 'ready', reason: 'Retry after quota reset' });
  });

  it('accepts a reasonless transition to a non-ready status', () => {
    expect(UpdateTaskStatusInput.parse({ status: 'queued' })).toEqual({ status: 'queued' });
  });

  it('rejects a status outside the enum', () => {
    expect(UpdateTaskStatusInput.safeParse({ status: 'done' }).success).toBe(false);
  });
});

describe('PaginationQuery', () => {
  it('defaults the limit to 25', () => {
    expect(PaginationQuery.parse({}).limit).toBe(25);
  });

  it('coerces the limit from a query string', () => {
    expect(PaginationQuery.parse({ limit: '50' }).limit).toBe(50);
  });

  it.each(['0', '101', '2.5', 'many'])('rejects the limit %s', (limit) => {
    expect(PaginationQuery.safeParse({ limit }).success).toBe(false);
  });

  it('rejects a non-uuid cursor', () => {
    expect(PaginationQuery.safeParse({ cursor: 'next-page' }).success).toBe(false);
  });
});
