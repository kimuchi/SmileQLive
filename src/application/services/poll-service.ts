import 'server-only';

/**
 * 投票のユースケース。
 *
 * 守っている約束:
 * - **1 端末につき 1 票。** 投票のドキュメント ID を参加者 ID にして `create` で書く。
 *   「読んでから書く」判定にすると、同時に 2 回送られたとき両方通りうる。
 * - **締め切った時点で集計を凍らせる。** そのあと司会が票数を直せる。
 *   紙の投票と合わせる会も、異常値を外したい会もある。
 *   直すのは票数だけで、点数は毎回そこから計算し直す
 *   （点数を直接いじれると、票数と食い違ったまま発表されうる）。
 * - **投票の記録は消さない。** 直すのは「発表に使う集計」だけ。
 * - 発表は下の順位から。1 位から出すと、そのあとを誰も見ない。
 */

import { randomUUID } from 'node:crypto';
import {
  BALLOT_GROUP_MAX_COUNT,
  BALLOT_OPTION_MAX_COUNT,
  isBallotStructure,
  pollSettingsOf,
  validateChoices,
  type PollSnapshot,
} from '@/domain/poll/ballot';
import {
  normalizeTally,
  rankOptions,
  tallyVotes,
  type PollTally,
  type RankedOption,
} from '@/domain/poll/tally';
import {
  bumpVoteCount,
  clearVotes,
  createPollBallot as createBallotDoc,
  deletePollBallot as deleteBallotDoc,
  findVote,
  insertVote,
  listPollBallots as listBallotsRepo,
  loadVotes,
  requirePollBallot,
  setPollTally,
  toAdminBallot,
  updatePollBallot as updateBallotDoc,
  type AdminPollBallot,
  type PollBallotPatch,
  type PollBallotSummary,
} from '@/infrastructure/firebase/repositories/poll-repository';
import { publishVoteProgress } from '@/infrastructure/firebase/transactions';
import { requireHostUser, requireParticipant, requireRoomOwner } from '@/lib/auth/session';
import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/infrastructure/logging/logger';
import type { PollBallotDoc } from '@/types/firestore';

export type { AdminPollBallot, PollBallotPatch, PollBallotSummary };

async function requireOwnedBallot(ballotId: string): Promise<PollBallotDoc> {
  const { user } = await requireHostUser();
  const ballot = await requirePollBallot(ballotId);
  if (ballot.ownerId !== user.uid) {
    throw new AppError('FORBIDDEN');
  }
  return ballot;
}

// ---------------------------------------------------------------------------
// 投票用紙
// ---------------------------------------------------------------------------

export async function listPollBallots(): Promise<PollBallotSummary[]> {
  const { user } = await requireHostUser();
  return listBallotsRepo(user.uid);
}

export async function createPollBallot(input: {
  title: string;
  structure: string;
}): Promise<AdminPollBallot> {
  const { user } = await requireHostUser();
  if (!isBallotStructure(input.structure)) {
    throw new AppError('VALIDATION_FAILED', { details: { reason: 'unknown_ballot_structure' } });
  }
  const created = await createBallotDoc({
    ownerId: user.uid,
    title: input.title,
    structure: input.structure,
  });
  logger.info('poll_ballot.created', { ballotId: created.id, structure: created.structure });
  return toAdminBallot(created);
}

export async function getPollBallot(ballotId: string): Promise<AdminPollBallot> {
  return toAdminBallot(await requireOwnedBallot(ballotId));
}

export async function updatePollBallot(
  ballotId: string,
  patch: PollBallotPatch,
): Promise<AdminPollBallot> {
  await requireOwnedBallot(ballotId);

  if ((patch.options?.length ?? 0) > BALLOT_OPTION_MAX_COUNT) {
    throw new AppError('VALIDATION_FAILED', {
      details: { reason: 'too_many_options', max: BALLOT_OPTION_MAX_COUNT },
    });
  }
  if ((patch.groups?.length ?? 0) > BALLOT_GROUP_MAX_COUNT) {
    throw new AppError('VALIDATION_FAILED', {
      details: { reason: 'too_many_groups', max: BALLOT_GROUP_MAX_COUNT },
    });
  }

  const updated = await updateBallotDoc(ballotId, patch);
  return toAdminBallot(updated);
}

export async function deletePollBallot(ballotId: string): Promise<void> {
  const ballot = await requireOwnedBallot(ballotId);
  await deleteBallotDoc(ballot.id);
  logger.info('poll_ballot.deleted', { ballotId: ballot.id });
}

/**
 * ルームへ固める形で読み出す。
 *
 * クイズの buildSnapshotForQuiz と同じ役割。
 * ここで**選択肢が 1 件も無い用紙を弾く**（当日「投票できない」に気づく）。
 */
export async function buildPollSnapshot(ballotId: string): Promise<PollSnapshot> {
  const ballot = await requireOwnedBallot(ballotId);
  const admin = toAdminBallot(ballot);

  if (admin.options.length === 0) {
    throw new AppError('POLL_BALLOT_EMPTY');
  }
  if (admin.structure === 'nested') {
    // 2 段階なのに階層へ属していない選択肢は選べない。用紙のまま出さない。
    const orphan = admin.options.filter((option) => option.groupId === null);
    if (orphan.length > 0) {
      throw new AppError('POLL_BALLOT_EMPTY', {
        details: { reason: 'options_without_group', count: orphan.length },
      });
    }
  }

  return {
    ballotId: admin.id,
    title: admin.title,
    structure: admin.structure,
    groups: admin.groups,
    options: admin.options,
    settings: pollSettingsOf(admin.settings),
  };
}

/** 新しい ID を振る（画面から作った選択肢に使う）。 */
export function newBallotItemId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/** 投票の記録から集計を作る（締め切った瞬間に 1 回だけ呼ぶ）。 */
export function buildTally(snapshot: PollSnapshot, votes: ReadonlyArray<readonly string[]>) {
  return tallyVotes(
    snapshot.options.map((option) => option.id),
    snapshot.settings.rankDepth,
    votes,
  );
}

/** 保存済みの集計を、用紙に合わせて読み直す。 */
export function readTally(snapshot: PollSnapshot, tally: PollTally | null | undefined): PollTally {
  return normalizeTally(
    tally,
    snapshot.options.map((option) => option.id),
    snapshot.settings.rankDepth,
  );
}

/** 順位を付ける。 */
export function rankFor(snapshot: PollSnapshot, tally: PollTally): RankedOption[] {
  return rankOptions(
    tally,
    snapshot.options.map((option) => option.id),
    snapshot.settings,
  );
}

/**
 * 司会が直した票数を受け取る。
 *
 * 受け取るのは票数だけ。点数は毎回ここから計算し直す。
 * 用紙に無い選択肢は捨て、足りない選択肢は 0 票で埋める。
 */
export function applyTallyEdits(
  snapshot: PollSnapshot,
  current: PollTally,
  edits: ReadonlyArray<{ optionId: string; counts: number[] }>,
  voterCount?: number,
): PollTally {
  const byId = new Map(edits.map((edit) => [edit.optionId, edit.counts]));
  const merged: PollTally = {
    voterCount:
      typeof voterCount === 'number' ? Math.max(0, Math.round(voterCount)) : current.voterCount,
    entries: snapshot.options.map((option) => ({
      optionId: option.id,
      counts:
        byId.get(option.id) ??
        current.entries.find((entry) => entry.optionId === option.id)?.counts ??
        [],
    })),
  };
  return readTally(snapshot, merged);
}

/** 投票の検証。受け付けてよい並びかどうか。 */
export function assertChoicesAllowed(snapshot: PollSnapshot, optionIds: readonly string[]): void {
  const result = validateChoices(snapshot, optionIds);
  if (!result.ok) {
    throw new AppError('POLL_CHOICE_INVALID', { details: { reason: result.reason } });
  }
}

// ---------------------------------------------------------------------------
// 投票する
// ---------------------------------------------------------------------------

/**
 * 1 票を受け付ける。
 *
 * - 受付中（`poll_open`）でなければ受け付けない。締め切ったあとの票を数えると、
 *   凍らせた集計と実際の票がずれる。
 * - 二度目は `ALREADY_VOTED`。判定は Firestore の `create` に任せる
 *   （同じ端末から同時に 2 回送られても、通るのは片方だけ）。
 */
export async function submitVote(
  roomId: string,
  optionIds: readonly string[],
): Promise<{ choices: string[]; voteCount: number }> {
  const { member, room } = await requireParticipant(roomId);
  const snapshot = room.pollSnapshot;
  if (!snapshot) {
    throw new AppError('ROOM_MODE_MISMATCH');
  }
  if (room.phase !== 'poll_open') {
    throw new AppError('POLL_NOT_OPEN', { details: { phase: room.phase } });
  }

  assertChoicesAllowed(snapshot, optionIds);
  await insertVote(roomId, member.id, optionIds);

  /*
    ここから先は表示のための更新。**失敗しても投票は成立している。**

    票の書き込みと分けているのは、会場の全員が同時に押したときに
    表示用の数字のせいで投票そのものが弾かれないようにするため。
  */
  await bumpVoteCount(roomId);
  await publishVoteProgress(roomId);

  logger.info('poll.voted', { roomId, choiceCount: optionIds.length });
  return { choices: [...optionIds], voteCount: (room.voteCount ?? 0) + 1 };
}

/** 自分が入れた票（無ければ null）。 */
export async function getMyVote(roomId: string, participantId: string): Promise<string[] | null> {
  const vote = await findVote(roomId, participantId);
  return vote ? vote.choices : null;
}

// ---------------------------------------------------------------------------
// 司会が集計を直す
// ---------------------------------------------------------------------------

export type TallyEdit = { optionId: string; counts: number[] };

/**
 * 締め切ったあとの集計を直す。
 *
 * 受け取るのは票数だけ。点数はここから計算し直す。
 * **投票の記録そのものは消さない**（あとから経緯をたどれるようにする）。
 * 発表を始めたあとは直せない。会場へ出した数字が後から変わると混乱する。
 */
export async function editPollTally(
  roomId: string,
  edits: readonly TallyEdit[],
  voterCount?: number,
): Promise<PollTally> {
  const { room } = await requireRoomOwner(roomId);
  const snapshot = room.pollSnapshot;
  if (!snapshot) {
    throw new AppError('ROOM_MODE_MISMATCH');
  }
  if (room.phase !== 'poll_closed') {
    throw new AppError('POLL_NOT_OPEN', { details: { phase: room.phase, reason: 'not_editable' } });
  }
  if (!room.pollTally) {
    throw new AppError('POLL_TALLY_NOT_READY');
  }

  const next = applyTallyEdits(snapshot, readTally(snapshot, room.pollTally), edits, voterCount);
  // 発表済みの数はここでは動かさない（締切直後なので必ず 0）。
  await setPollTally(roomId, next, room.revealedCount ?? 0);
  logger.info('poll.tally_edited', { roomId, editedCount: edits.length });
  return next;
}

/**
 * 集計を投票の記録から作り直す。
 *
 * 司会が直しすぎたときの戻し口。紙の票を足す前の状態へ戻せる。
 */
export async function recountPollTally(roomId: string): Promise<PollTally> {
  const { room } = await requireRoomOwner(roomId);
  const snapshot = room.pollSnapshot;
  if (!snapshot) {
    throw new AppError('ROOM_MODE_MISMATCH');
  }
  if (room.phase !== 'poll_closed') {
    throw new AppError('POLL_NOT_OPEN', { details: { phase: room.phase, reason: 'not_editable' } });
  }

  const votes = await loadVotes(roomId);
  const next = buildTally(snapshot, votes);
  await setPollTally(roomId, next, 0);
  logger.info('poll.recounted', { roomId, voteCount: votes.length });
  return next;
}

/**
 * 投票をすべて捨てる。
 *
 * 練習で入れた票を消してから本番を始めるための操作。
 * 受付中か締切後にだけ許す（発表を始めたあとに消しても意味が無い）。
 */
export async function clearPollVotes(roomId: string): Promise<number> {
  const { room } = await requireRoomOwner(roomId);
  if (!room.pollSnapshot) {
    throw new AppError('ROOM_MODE_MISMATCH');
  }
  if (room.phase !== 'poll_open' && room.phase !== 'poll_closed') {
    throw new AppError('POLL_NOT_OPEN', {
      details: { phase: room.phase, reason: 'not_clearable' },
    });
  }

  const removed = await clearVotes(roomId);
  await setPollTally(roomId, null, 0);
  await publishVoteProgress(roomId);
  logger.info('poll.votes_cleared', { roomId, removed });
  return removed;
}
