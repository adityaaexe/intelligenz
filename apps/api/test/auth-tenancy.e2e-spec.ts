import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiErrorBody } from './helpers/api-types';
import type { Suite } from './helpers/app';
import { authHeaders, login, startSuite } from './helpers/app';

/**
 * Authentication, tenancy and RBAC — the required cases 1, 2, 3, 8, 9 plus the
 * expired-token case from contract §12.
 *
 * The point of the tenant-isolation test is that it does not test the guard: the
 * caller is a legitimate member of org A sending a well-formed request for an org A
 * path. The row belongs to org B. A 404 has to come from the query layer.
 */

let suite: Suite;
let ownerAToken: string;
let viewerAToken: string;
let ownerBToken: string;
let expiredToken: string;

beforeAll(async () => {
  suite = await startSuite();

  ownerAToken = await login(suite.app, suite.fixtures.users.ownerA.email);
  viewerAToken = await login(suite.app, suite.fixtures.users.viewerA.email);
  ownerBToken = await login(suite.app, suite.fixtures.users.ownerB.email);

  const jwt = suite.app.get(JwtService, { strict: false });
  expiredToken = jwt.sign(
    { sub: suite.fixtures.users.ownerA.id, email: suite.fixtures.users.ownerA.email },
    { expiresIn: '-10s' },
  );
});

afterAll(async () => {
  await suite.close();
});

describe('authentication', () => {
  it('rejects a protected route with no token (401)', async () => {
    const response = await request(suite.app.getHttpServer()).get('/v1/orgs').expect(401);
    const body = response.body as ApiErrorBody;

    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a malformed token (401)', async () => {
    await request(suite.app.getHttpServer())
      .get('/v1/orgs')
      .set('authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('rejects an expired token (401)', async () => {
    const response = await request(suite.app.getHttpServer())
      .get('/v1/orgs')
      .set(authHeaders(expiredToken))
      .expect(401);

    expect((response.body as ApiErrorBody).error.code).toBe('UNAUTHORIZED');
  });

  it('accepts a valid token and lists only the caller organisations', async () => {
    const response = await request(suite.app.getHttpServer())
      .get('/v1/orgs')
      .set(authHeaders(ownerAToken))
      .expect(200);

    const body = response.body as { data: { id: string; role: string }[] };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.id).toBe(suite.fixtures.orgA.id);
    expect(body.data[0]?.role).toBe('OWNER');
  });
});

describe('organisation scoping', () => {
  it('rejects a request without X-Org-Id (403)', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/workspaces/${suite.fixtures.workspaceA}/projects`)
      .set(authHeaders(ownerAToken))
      .expect(403);

    expect((response.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
  });

  it("rejects an X-Org-Id the caller is not a member of (403)", async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgB.id}/workspaces/${suite.fixtures.workspaceB}/projects`)
      .set(authHeaders(ownerAToken, suite.fixtures.orgB.id))
      .expect(403);

    expect((response.body as ApiErrorBody).error.message).toContain('not a member');
  });

  it('rejects a header that disagrees with the path (403), before any query', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgB.id}/workspaces/${suite.fixtures.workspaceB}/projects`)
      // Header says org A (a real membership), path says org B.
      .set(authHeaders(ownerAToken, suite.fixtures.orgA.id))
      .expect(403);

    expect((response.body as ApiErrorBody).error.message).toContain('does not match');
  });

  it('serves a member of the organisation (200)', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/workspaces/${suite.fixtures.workspaceA}/projects`)
      .set(authHeaders(ownerAToken, suite.fixtures.orgA.id))
      .expect(200);

    const body = response.body as { data: { id: string }[] };

    expect(body.data.map((project) => project.id)).toContain(suite.fixtures.projectA);
  });
});

describe('tenant isolation', () => {
  it("returns 404, not 403, for another organisation's task", async () => {
    const response = await request(suite.app.getHttpServer())
      // A perfectly valid org A path and header. The task id belongs to org B.
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/tasks/${suite.fixtures.tasks.draftB}`)
      .set(authHeaders(ownerAToken, suite.fixtures.orgA.id))
      .expect(404);

    const body = response.body as ApiErrorBody;

    expect(body.error.code).toBe('NOT_FOUND');
    // The row must not be echoed under any key.
    expect(JSON.stringify(body)).not.toContain(suite.fixtures.tasks.draftB);
    expect(JSON.stringify(body)).not.toContain('Beta draft task');
  });

  it("does not include another organisation's task in a list", async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/projects/${suite.fixtures.projectA}/tasks?limit=100`)
      .set(authHeaders(ownerAToken, suite.fixtures.orgA.id))
      .expect(200);

    const body = response.body as { data: { id: string }[] };
    const ids = body.data.map((task) => task.id);

    expect(ids).toContain(suite.fixtures.tasks.draftA);
    expect(ids).not.toContain(suite.fixtures.tasks.draftB);
  });

  it("does not allow org B's owner to reach org A's project through a header swap", async () => {
    await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/projects/${suite.fixtures.projectA}/tasks`)
      .set(authHeaders(ownerBToken, suite.fixtures.orgA.id))
      .expect(403);
  });
});

describe('role-based access', () => {
  it('refuses task creation for a VIEWER (403)', async () => {
    const response = await request(suite.app.getHttpServer())
      .post(`/v1/orgs/${suite.fixtures.orgA.id}/projects/${suite.fixtures.projectA}/tasks`)
      .set(authHeaders(viewerAToken, suite.fixtures.orgA.id))
      .send({
        title: 'Viewer attempt',
        goal: 'A viewer must not be able to create work.',
        riskClass: 'LOW',
        acceptanceCriteria: [],
      })
      .expect(403);

    expect((response.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
  });

  it('allows a VIEWER to read the task list (hierarchy, not a whitelist)', async () => {
    await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/projects/${suite.fixtures.projectA}/tasks`)
      .set(authHeaders(viewerAToken, suite.fixtures.orgA.id))
      .expect(200);
  });

  it('refuses an approval decision below ADMIN (403)', async () => {
    const memberToken = await login(suite.app, suite.fixtures.users.memberA.email);

    await request(suite.app.getHttpServer())
      .post(
        `/v1/orgs/${suite.fixtures.orgA.id}/approvals/${suite.fixtures.pendingApprovalId}/decision`,
      )
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .send({ decision: 'approve' })
      .expect(403);
  });
});

describe('login', () => {
  it('rejects a wrong password with 401 and a generic body', async () => {
    const response = await request(suite.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: suite.fixtures.users.ownerA.email, password: 'definitely-not-it' })
      .expect(401);

    const body = response.body as ApiErrorBody;

    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toBe('Invalid email or password.');
    // The submitted credential must never be echoed, and no hash material either.
    expect(JSON.stringify(body)).not.toContain('definitely-not-it');
    expect(JSON.stringify(body)).not.toContain('argon2');
    expect(JSON.stringify(body)).not.toContain(suite.fixtures.users.ownerA.email);
  });

  it('answers identically for an unknown email', async () => {
    const known = await request(suite.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: suite.fixtures.users.ownerA.email, password: 'definitely-not-it' });
    const unknown = await request(suite.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'definitely-not-it' });

    const knownBody = known.body as ApiErrorBody;
    const unknownBody = unknown.body as ApiErrorBody;

    expect(unknown.status).toBe(known.status);
    // Same code and message; only the per-request correlation id differs.
    expect(unknownBody.error).toEqual(knownBody.error);
    expect(JSON.stringify(unknownBody)).not.toContain('nobody@example.test');
  });

  it('records a failed login for a known user as an audit event', async () => {
    // Performed here rather than relying on a previous test having done it: the
    // assertion must not depend on execution order.
    await request(suite.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: suite.fixtures.users.memberA.email, password: 'wrong-password' })
      .expect(401);

    const failed = await suite.prisma.auditEvent.findMany({
      where: {
        orgId: suite.fixtures.orgA.id,
        eventType: 'session.failed.v1',
        actorId: suite.fixtures.users.memberA.id,
      },
    });

    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.action).toBe('session.failed');
    expect(failed[0]?.projectId).toBeNull();
  });

  it('records a successful login as an audit event', async () => {
    await login(suite.app, suite.fixtures.users.ownerA.email);

    const succeeded = await suite.prisma.auditEvent.findMany({
      where: {
        orgId: suite.fixtures.orgA.id,
        eventType: 'session.started.v1',
        actorId: suite.fixtures.users.ownerA.id,
      },
    });

    expect(succeeded.length).toBeGreaterThan(0);
    // Identity events have no project to attach to (the schema allows null).
    expect(succeeded[0]?.projectId).toBeNull();
  });
});
