import { Global, Module } from '@nestjs/common';

import { OrchestratorService } from './orchestrator.service';

/**
 * Exported globally for the same reason as `AuditModule`: `/health/ready` and the
 * task service both need the one client. Two `Client` instances would mean two
 * gRPC channels and two shutdown paths.
 */
@Global()
@Module({
  providers: [OrchestratorService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
