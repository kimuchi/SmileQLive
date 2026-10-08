/**
 * GET    /api/admin/poll-ballots/[ballotId]  投票用紙の中身
 * PATCH  /api/admin/poll-ballots/[ballotId]  名前・選び方・選択肢・点数の設定を更新
 * DELETE /api/admin/poll-ballots/[ballotId]  削除
 *
 * 選択肢は**丸ごと入れ替える**（1 件ずつの差分にしない）。
 * 並べ替えと階層の付け替えが同時に起きるので、差分にすると壊れやすい。
 */

import {
  deletePollBallot,
  getPollBallot,
  updatePollBallot,
} from '@/application/services/poll-service';
import { jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody } from '@/lib/http/route-helpers';
import { updatePollBallotSchema } from '@/lib/validation/schemas';
import type { PollBallotDetailResponse } from '@/types/api';
import {
  requireUuidParam,
  withParams,
  type DeletedResponse,
} from '@/app/api/admin/_lib/admin-route';

export const dynamic = 'force-dynamic';

type Params = { ballotId: string };

export const GET = withParams<Params>('admin.poll_ballots.get', async (_request, ctx) => {
  const ballotId = requireUuidParam(ctx.params.ballotId, 'ballotId');
  const ballot = await getPollBallot(ballotId);
  return jsonOk<PollBallotDetailResponse>({ ballot });
});

export const PATCH = withParams<Params>('admin.poll_ballots.update', async (request, ctx) => {
  assertSameOrigin(request);

  const ballotId = requireUuidParam(ctx.params.ballotId, 'ballotId');
  const input = await parseJsonBody(request, updatePollBallotSchema);

  // 所有権はサービス層で確認する。
  const ballot = await updatePollBallot(ballotId, input);
  return jsonOk<PollBallotDetailResponse>({ ballot });
});

export const DELETE = withParams<Params>('admin.poll_ballots.delete', async (request, ctx) => {
  assertSameOrigin(request);

  const ballotId = requireUuidParam(ctx.params.ballotId, 'ballotId');
  await deletePollBallot(ballotId);

  return jsonOk<DeletedResponse>({ deleted: true });
});
