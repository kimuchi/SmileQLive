/**
 * GET  /api/admin/poll-ballots  投票用紙の一覧（自分が作ったもののみ）
 * POST /api/admin/poll-ballots  投票用紙の新規作成
 */

import { createPollBallot, listPollBallots } from '@/application/services/poll-service';
import { jsonCreated, jsonOk } from '@/lib/errors/api-response';
import { assertSameOrigin, parseJsonBody, withRoute } from '@/lib/http/route-helpers';
import { createPollBallotSchema } from '@/lib/validation/schemas';
import type { PollBallotDetailResponse, PollBallotsResponse } from '@/types/api';

export const dynamic = 'force-dynamic';

export const GET = withRoute<PollBallotsResponse>('admin.poll_ballots.list', async () => {
  // 所有者の絞り込みはサービス層（requireHostUser + ownerId）で行う。
  const ballots = await listPollBallots();
  return jsonOk<PollBallotsResponse>({ ballots });
});

export const POST = withRoute<PollBallotDetailResponse>(
  'admin.poll_ballots.create',
  async ({ request }) => {
    assertSameOrigin(request);

    const input = await parseJsonBody(request, createPollBallotSchema);
    const ballot = await createPollBallot(input);

    return jsonCreated<PollBallotDetailResponse>({ ballot });
  },
);
