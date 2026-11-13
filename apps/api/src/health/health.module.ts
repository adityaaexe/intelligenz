import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/**
 * No providers: the controller reaches the Prisma client, the config and the
 * orchestrator through the global modules. A health module that owned its own
 * connection would be probing a different pool than the one serving traffic.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
