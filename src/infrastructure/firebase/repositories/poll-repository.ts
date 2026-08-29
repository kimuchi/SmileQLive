import 'server-only';

/**
 * 投票用紙 (`pollBallots`) と投票 (`rooms/{roomId}/votes`) へのアクセス。
 *
 * - 呼び出す前に所有者・参加者の確認を済ませること（Admin SDK は Rules を迂回する）。
 * - 用紙の更新は**常に全件の入れ替え**にする。1 件ずつの差分にすると、
 *   並べ替えや階層の付け替えで壊れやすくなる。
 * - 投票は `create` で書く。二度目は Firestore が弾く（1 端末 1 票）。
 */

import { randomUUID } from 'node:crypto';
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import {
  BALLOT_GROUP_MAX_COUNT,
  BALLOT_LABEL_MAX_LENGTH,
  BALLOT_OPTION_MAX_COUNT,
  pollSettingsOf,
  type BallotGroup,
  type BallotOption,
  type BallotStructure,
  type PollSettings,
} from '@/domain/poll/ballot';
import type { PollTally } from '@/domain/poll/tally';
import { getDb } from '@/infrastructure/firebase/admin';
import { nowTimestamp, toIsoOr } from '@/infrastructure/firebase/converters';
import {
  pollBallotRef,
  pollBallotsCollection,
  roomRef,
  voteRef,
  votesCollection,
} from '@/infrastructure/firebase/paths';
import { AppError } from '@/lib/errors/app-error';
import type { PollBallotDoc } from '@/types/firestore';

/** 一覧に出す 1 件。 */
export type PollBallotSummary = {
  id: string;
  title: string;
  structure: BallotStructure;
  optionCount: number;
  groupCount: number;
  rankDepth: number;
  updatedAt: string;
};

/** 編集画面へ返す中身。 */
export type AdminPollBallot = {
  id: string;
  title: string;
  structure: BallotStructure;
  groups: BallotGroup[];
  options: BallotOption[];
  settings: PollSettings;
  createdAt: string;
  updatedAt: string;
};

/**
 * 画面から受け取る 1 件。**並び順は受け取らない。**
 * 送られてきた配列の順がそのまま並び順になる（position はここで振り直す）。
 */
export type BallotGroupInput = { id: string; label: string };
export type BallotOptionInput = {
  id: string;
  label: string;
  groupId?: string | null;
  note?: string | null;
};

export type PollBallotPatch = {
  title?: string;
  structure?: BallotStructure;
  groups?: BallotGroupInput[];
  options?: BallotOptionInput[];
  settings?: Partial<PollSettings>;
};

const BALLOT_LIST_LIMIT = 100;

function toSummary(doc: PollBallotDoc): PollBallotSummary {
  return {
    id: doc.id,
    title: doc.title,
    structure: doc.structure,
    optionCount: doc.options?.length ?? 0,
    groupCount: doc.groups?.length ?? 0,
    rankDepth: pollSettingsOf(doc.settings).rankDepth,
    updatedAt: toIsoOr(doc.updatedAt),
  };
}

export function toAdminBallot(doc: PollBallotDoc): AdminPollBallot {
  return {
    id: doc.id,
    title: doc.title,
    structure: doc.structure,
    groups: [...(doc.groups ?? [])].sort((a, b) => a.position - b.position),
    options: [...(doc.options ?? [])].sort((a, b) => a.position - b.position),
    settings: pollSettingsOf(doc.settings),
    createdAt: toIsoOr(doc.createdAt),
    updatedAt: toIsoOr(doc.updatedAt),
  };
}

export async function listPollBallots(ownerId: string): Promise<PollBallotSummary[]> {
  const snapshot = await pollBallotsCollection()
    .where('ownerId', '==', ownerId)
    .orderBy('updatedAt', 'desc')
    .limit(BALLOT_LIST_LIMIT)
    .get();
  return snapshot.docs.map((doc) => toSummary(doc.data()));
}

export async function requirePollBallot(ballotId: string): Promise<PollBallotDoc> {
  const snapshot = await pollBallotRef(ballotId).get();
  const doc = snapshot.data();
  if (!doc) {
    throw new AppError('POLL_BALLOT_NOT_FOUND');
  }
  return doc;
}

export async function createPollBallot(input: {
  ownerId: string;
  title: string;
  structure: BallotStructure;
}): Promise<PollBallotDoc> {
  const id = randomUUID();
  const now = nowTimestamp();
  const doc: PollBallotDoc = {
    id,
    ownerId: input.ownerId,
    title: input.title.trim().slice(0, 120) || '無題の投票',
    structure: input.structure,
    groups: [],
    options: [],
    settings: pollSettingsOf(null),
    optionCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await pollBallotRef(id).create(doc);
  return doc;
}

/** 用紙の中身を丸ごと入れ替える。 */
export async function updatePollBallot(
  ballotId: string,
  patch: PollBallotPatch,
): Promise<PollBallotDoc> {
  const current = await requirePollBallot(ballotId);

  const structure = patch.structure ?? current.structure;
  const groups = (patch.groups ?? current.groups ?? [])
    .slice(0, BALLOT_GROUP_MAX_COUNT)
    .map((group, index) => ({
      id: group.id,
      position: index + 1,
      label: group.label.trim().slice(0, BALLOT_LABEL_MAX_LENGTH),
    }))
    .filter((group) => group.label.length > 0);

  const groupIds = new Set(groups.map((group) => group.id));
  const options = (patch.options ?? current.options ?? [])
    .slice(0, BALLOT_OPTION_MAX_COUNT)
    .map((option, index) => ({
      id: option.id,
      position: index + 1,
      label: option.label.trim().slice(0, BALLOT_LABEL_MAX_LENGTH),
      // 1 階層目を持つのは 2 段階のときだけ。消された階層への参照は切る。
      groupId:
        structure === 'nested' && option.groupId && groupIds.has(option.groupId)
          ? option.groupId
          : null,
      note: option.note?.trim().slice(0, BALLOT_LABEL_MAX_LENGTH) || null,
    }))
    .filter((option) => option.label.length > 0);

  const next: PollBallotDoc = {
    ...current,
    title: (patch.title ?? current.title).trim().slice(0, 120) || current.title,
    structure,
    groups,
    options,
    settings: pollSettingsOf({ ...current.settings, ...patch.settings }),
    optionCount: options.length,
    updatedAt: nowTimestamp(),
  };

  await pollBallotRef(ballotId).set(next);
  return next;
}

export async function deletePollBallot(ballotId: string): Promise<void> {
  await pollBallotRef(ballotId).delete();
}

// ---------------------------------------------------------------------------
// 投票
// ---------------------------------------------------------------------------

/**
 * 1 票を書く。
 *
 * すでに投票済みなら `ALREADY_VOTED`。
 * 判定は「読んでから書く」ではなく **`create` の失敗**で行う。
 * 読んでから書くと、同時に 2 回送られたときに両方が通りうる。
 *
 * **票だけを書く。** 表示用の人数はここに混ぜない（bumpVoteCount を参照）。
 */
export async function insertVote(
  roomId: string,
  participantId: string,
  choices: readonly string[],
): Promise<void> {
  try {
    await voteRef(roomId, participantId).create({
      roomId,
      participantId,
      choices: [...choices],
      createdAt: nowTimestamp(),
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // 6 / ALREADY_EXISTS = すでに同じ ID のドキュメントがある＝投票済み。
    if (code === 6 || code === 'already-exists') {
      throw new AppError('ALREADY_VOTED', { cause: error });
    }
    throw error;
  }
}

/**
 * 投票した人数の表示値を 1 増やす。
 *
 * **票の書き込みとは分ける。** 同じ書き込みにまとめると、
 * 会場の全員が同時に押したときに `rooms/{id}` が混み合い、
 * 表示用の数字のせいで**投票そのものが弾かれる**。
 * 参加人数（bumpParticipantCount）と同じ考え方で、失敗しても投票は成立している。
 *
 * ずれても締め切った時点で実際の票を数え直して上書きするので、残らない。
 */
export async function bumpVoteCount(roomId: string): Promise<void> {
  try {
    await roomRef(roomId).update({
      voteCount: FieldValue.increment(1),
      updatedAt: nowTimestamp(),
    });
  } catch {
    // 表示のための更新。失敗しても投票そのものは成立している。
  }
}

/** その参加者がもう投票したか。 */
export async function findVote(
  roomId: string,
  participantId: string,
): Promise<{ choices: string[] } | null> {
  const snapshot = await voteRef(roomId, participantId).get();
  const doc = snapshot.data();
  return doc ? { choices: [...doc.choices] } : null;
}

/**
 * 投票した人数を数え直す。
 *
 * 普段は `room.voteCount` を読む。こちらは司会が「数が合わない」と
 * 思ったときに突き合わせるためのもの（集計クエリ 1 回）。
 */
export async function countVotes(roomId: string): Promise<number> {
  const snapshot = await votesCollection(roomId).count().get();
  return snapshot.data().count;
}

/** すべての投票の中身。締め切ったあとの集計にだけ使う。 */
export async function loadVotes(roomId: string): Promise<string[][]> {
  const snapshot = await votesCollection(roomId).orderBy(FieldPath.documentId()).get();
  return snapshot.docs.map((doc) => [...doc.data().choices]);
}

/** 凍らせた集計と、発表済みの順位の数を書く。 */
export async function setPollTally(
  roomId: string,
  tally: PollTally | null,
  revealedCount: number,
): Promise<void> {
  await roomRef(roomId).update({
    pollTally: tally,
    revealedCount,
    updatedAt: nowTimestamp(),
  });
}

/**
 * 投票をすべて捨てる（やり直し）。
 *
 * 人数も 0 に戻す。票だけ消えて「20人投票済み」と出続けると、
 * 司会が受付を開き直しても終わったように見える。
 */
export async function clearVotes(roomId: string): Promise<number> {
  const snapshot = await votesCollection(roomId).get();
  const batch = getDb().batch();
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
  }
  batch.update(roomRef(roomId), { voteCount: 0, updatedAt: nowTimestamp() });
  await batch.commit();
  return snapshot.size;
}
