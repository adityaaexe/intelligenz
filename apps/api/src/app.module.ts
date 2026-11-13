import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { ApprovalsModule } from './approvals/approvals.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { createLogger } from './common/logger';
import { LoggingModule } from './common/logging.module';
import { ConfigModule } from './config/config.module';
import type { AppConfig } from './config/app-config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { OrgsModule } from './orgs/orgs.module';
import { ProjectsModule } from './projects/projects.module';
import { RolesGuard } from './tenancy/roles.guard';
import { OrgScopeGuard } from './tenancy/org-scope.guard';
import { TasksModule } from './tasks/tasks.module';

/**
 * Root module.
 *
 * ## Guard order is a security property, not a preference
 *
 * `APP_GUARD` providers run in the order they are listed here, and the order
 * encodes the checks:
 *
 *   1. `JwtAuthGuard`    — who is calling (skipped for `@Public()`);
 *   2. `OrgScopeGuard`   — which org, and does the caller belong to it;
 *   3. `RolesGuard`      — is the caller's role enough for this action.
 *
 * Swapping 2 and 3 would let a role check run without a resolved membership, and
 * swapping 1 and 2 would let an unauthenticated request reach a membership lookup.
 *
 * ## Why `forRoot(config)`
 *
 * Config is resolved once in `main.ts` (or in a test bootstrap) and passed in. A
 * module that read `process.env` itself would make two different configs possible in
 * one process, and would make the fail-fast `JWT_SECRET` check unreachable from a
 * test.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const logger = createLogger(config);

    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule.forRoot(logger),
        DatabaseModule,
        AuditModule,
        OrchestratorModule,
        AuthModule,
        OrgsModule,
        ProjectsModule,
        TasksModule,
        ApprovalsModule,
        HealthModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: OrgScopeGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
