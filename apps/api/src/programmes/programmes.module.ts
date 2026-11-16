import { Module } from '@nestjs/common';

import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { ProgrammesController } from './programmes.controller';
import { ProgrammesService } from './programmes.service';

/**
 * The programme layer's API surface.
 *
 * `OrchestratorModule` is imported rather than the Temporal client being constructed here:
 * the parent workflow is started by the same `OrchestratorService` that starts a task, so
 * there is one place that knows the address, the queue and the error mapping. `AuditModule`
 * is global.
 */
@Module({
  imports: [OrchestratorModule],
  controllers: [ProgrammesController],
  providers: [ProgrammesService],
  exports: [ProgrammesService],
})
export class ProgrammesModule {}
