import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service';

/**
 * Global because audit writes happen from four feature modules. Importing the
 * module in each of them would work but give four paths to the same table; a global
 * module with one exported service keeps "one writer" true structurally.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
