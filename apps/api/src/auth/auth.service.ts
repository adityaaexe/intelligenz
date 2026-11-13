import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { LoginInput, Role } from '@intelligenz/contracts';
import type { PrismaClient } from '@intelligenz/database';
import argon2 from 'argon2';
import type { Logger } from 'pino';

import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { LOGGER } from '../common/logger';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PRISMA_CLIENT } from '../database/database.module';

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface MembershipSummary {
  readonly orgId: string;
  readonly orgName: string;
  readonly orgSlug: string;
  readonly role: Role;
  /** Workspaces in this org. Included so a client can build `/orgs/:orgId/workspaces/:id/...` paths. */
  readonly workspaces: readonly WorkspaceSummary[];
}

export interface LoginResponse {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly memberships: readonly MembershipSummary[];
}

/**
 * argon2id, OWASP baseline (19 MiB, time cost 2, parallelism 1) — the same
 * parameters the seed uses, so a seeded hash and a hash created here are
 * interchangeable. Imported from the seed's comment rather than duplicated as a
 * magic number in two places that must agree.
 */
const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class AuthService {
  private dummyHashPromise?: Promise<string>;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Email + password → access token.
   *
   * ## Uniform failure
   *
   * An unknown email and a wrong password must be indistinguishable: same status,
   * same body, and a comparable amount of work. The password hash is therefore
   * verified even when no user exists, against a hash of a random string, so the
   * request does not return in 2ms precisely when the email is unknown. That is a
   * mitigation, not a proof — a determined attacker can still measure the extra
   * audit write below — which is why login stays behind the rate limit a later unit
   * adds.
   *
   * ## Why membership lives here and not in the token
   *
   * The token carries only `{ sub, email }`. Roles are read from the database on
   * every request, so a role change takes effect immediately instead of when a
   * 15-minute token expires.
   */
  async login(input: LoginInput, correlationId: string): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, name: true, email: true, passwordHash: true },
    });

    const passwordHash = user?.passwordHash ?? (await this.dummyHash());
    const passwordMatches = await verifyPassword(passwordHash, input.password);

    if (user === null || !passwordMatches) {
      await this.recordFailedLogin(user?.id ?? null, correlationId);

      // One message for both branches. The body must not reveal which half failed.
      throw AppError.unauthorized('Invalid email or password.');
    }

    const memberships = await this.loadMemberships(user.id);

    const accessToken = await this.jwt.signAsync({ sub: user.id, email: user.email });

    // A user with no membership has no tenant to attach a session event to
    // (`AuditEvent.orgId` is a required FK). The login still succeeds — an
    // unaffiliated account is a valid account — it simply produces no org-scoped
    // history until a membership exists.
    const primaryOrgId = memberships[0]?.orgId;

    if (primaryOrgId !== undefined) {
      await this.audit.record({
        orgId: primaryOrgId,
        actor: { type: 'user', id: user.id },
        action: 'session.started',
        eventType: 'session.started.v1',
        aggregateType: 'User',
        aggregateId: user.id,
        correlationId,
        payload: { membershipCount: memberships.length },
      });
    }

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.config.jwtTtlSeconds,
      user: { id: user.id, name: user.name, email: user.email },
      memberships,
    };
  }

  private async loadMemberships(userId: string): Promise<MembershipSummary[]> {
    // Scoped by `userId`, which is the authenticated caller — not a tenant filter in
    // the org sense, but the same principle: the predicate that limits the rows is
    // the authenticated identity, never a value from the request.
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: {
        role: true,
        orgId: true,
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (memberships.length === 0) return [];

    const workspaces = await this.prisma.workspace.findMany({
      where: { orgId: { in: memberships.map((membership) => membership.orgId) } },
      select: { id: true, orgId: true, name: true, slug: true },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => ({
      orgId: membership.orgId,
      orgName: membership.organization.name,
      orgSlug: membership.organization.slug,
      role: membership.role as Role,
      workspaces: workspaces
        .filter((workspace) => workspace.orgId === membership.orgId)
        .map((workspace) => ({ id: workspace.id, name: workspace.name, slug: workspace.slug })),
    }));
  }

  /**
   * A login attempt for a known email is recorded against that user's first org,
   * because `AuditEvent.orgId` is a required foreign key. An attempt for an unknown
   * email has no tenant to attach to, so it is logged (with the address redacted
   * from nothing — it is not a credential) and not persisted. Refusing to attach it
   * to a random tenant is the honest choice: the audit trail must not claim an event
   * happened inside an organisation it did not happen in.
   */
  private async recordFailedLogin(userId: string | null, correlationId: string): Promise<void> {
    if (userId === null) {
      this.logger.warn({ correlationId }, 'login failed for an unknown email');
      return;
    }

    try {
      const membership = await this.prisma.membership.findFirst({
        where: { userId },
        select: { orgId: true },
        orderBy: { createdAt: 'asc' },
      });

      if (membership === null) return;

      await this.audit.record({
        orgId: membership.orgId,
        actor: { type: 'user', id: userId },
        action: 'session.failed',
        eventType: 'session.failed.v1',
        aggregateType: 'User',
        aggregateId: userId,
        correlationId,
        payload: { reason: 'invalid_credentials' },
      });
    } catch (error) {
      // A failed audit write must never turn a 401 into a 500 — the caller is already
      // being rejected, and the log line preserves the attempt.
      this.logger.error({ err: error, correlationId }, 'failed to record a failed login');
    }
  }

  /**
   * A valid hash of a value nobody knows, used only to spend the same CPU on an
   * unknown email as on a known one. Computed once per process, on first use.
   */
  private dummyHash(): Promise<string> {
    this.dummyHashPromise ??= argon2.hash(randomUUID(), PASSWORD_HASH_OPTIONS);

    return this.dummyHashPromise;
  }
}

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed hash is a data-integrity problem, not a valid credential.
    return false;
  }
}
