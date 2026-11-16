import { Controller, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { SubmitProgrammeInput } from '@intelligenz/contracts';

import { Roles } from '../auth/auth.decorators';
import { CorrelationId, CurrentUser } from '../common/decorators/request.decorators';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import type { ApiResponse, AuthenticatedUser } from '../common/request-context';
import { ProgrammesService } from './programmes.service';
import type { CancelProgrammeResponse, ProgrammeResponse } from './programmes.response';

/**
 * Programme submission — one call, then the scheduler owns the objective.
 *
 * `202 Accepted` on a new programme: the parent workflow exists, the tasks have not run.
 * `200 OK` on a replay of the same `Idempotency-Key`: the body is the programme the first
 * request created, and no second workflow was started. The two statuses are how a client
 * tells "I created a schedule" from "my retry found it".
 *
 * MEMBER is enough, matching `POST /run`: submitting a programme is the same act as
 * starting one task, repeated. It does not approve anything — an approval-gated task inside
 * the graph is recorded as `waiting_for_approval` and only its dependents block.
 */
@Controller('v1/orgs/:orgId/programmes')
export class ProgrammesController {
  constructor(@Inject(ProgrammesService) private readonly programmes: ProgrammesService) {}

  @Roles('MEMBER')
  @Post()
  async submit(
    @Param('orgId') orgId: string,
    @ZodBody(SubmitProgrammeInput) input: SubmitProgrammeInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: ApiResponse,
  ): Promise<{ data: ProgrammeResponse; meta: { created: boolean } }> {
    const result = await this.programmes.submit({
      orgId,
      input,
      idempotencyKey,
      correlationId,
      actorId: user.userId,
    });

    response.status(result.created ? 202 : 200);

    return { data: result.programme, meta: { created: result.created } };
  }

  /**
   * Stops a programme.
   *
   * `202` on a request that reached the orchestrator — the caller is told "the stop was
   * accepted", not "the programme is over". A started programme is closed by its workflow,
   * and that takes an activity; a programme that never started is closed here, in the same
   * call, and the body says so (`cancellation: 'cancelled_before_start'`).
   * `200` on a replay: the row was already cancelled and nothing was written.
   *
   * MEMBER, the same role that may submit a programme and cancel a task. Escalating this to
   * ADMIN — on the argument that stopping a multi-task objective is broader than stopping
   * one run — is a policy decision nobody has made; the role ladder here matches the write
   * it undoes, and does not invent a stricter one.
   */
  @Roles('MEMBER')
  @Post(':programmeId/cancel')
  async cancel(
    @Param('orgId') orgId: string,
    @Param('programmeId') programmeId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: ApiResponse,
  ): Promise<{ data: CancelProgrammeResponse }> {
    const result = await this.programmes.cancel({
      orgId,
      programmeId,
      correlationId,
      actorId: user.userId,
    });

    response.status(result.cancellation === 'already_cancelled' ? 200 : 202);

    return { data: result };
  }
}
