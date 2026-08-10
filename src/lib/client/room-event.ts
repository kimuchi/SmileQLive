/**
 * Firestore のスナップショットを RoomEventEnvelope へ変換する。
 *
 * 原則:
 * - 購読で受け取るのは「状態が変わった」という**合図だけ**。
 *   ここで画面状態を組み立てない。実データは必ず Snapshot API から取り直す。
 * - そのため、変換で拾うのは **whitelist した公開フィールドのみ**。
 *   正解・問題文・選択肢は `rooms/{roomId}/public/state` に存在しないが、
 *   万一混入しても envelope へ載せないよう、明示したフィールドしか読まない。
 * - `rooms/{roomId}/staff/progress` の `breakdown`（回答内訳）は
 *   **有無だけ**を載せ、中身は絶対に載せない。
 * - 形が合わなければ null。呼び出し側は黙って捨てる。
 */

import {
  publicEventTypeForPhase,
  type PublicEventPayload,
  type PublicEventType,
  type RoomEventEnvelope,
  type StaffEventType,
} from '@/domain/room/events';
import { isRoomPhase } from '@/domain/room/state-machine';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `toMillis()` を持つ値（Firestore の Timestamp）か。 */
function hasToMillis(value: unknown): value is { toMillis: () => number } {
  return isRecord(value) && typeof value.toMillis === 'function';
}

/** `{ seconds, nanoseconds }` 形式（JSON 化された Timestamp）か。 */
function hasSecondsPair(value: unknown): value is { seconds: number; nanoseconds: number } {
  return (
    isRecord(value) && typeof value.seconds === 'number' && typeof value.nanoseconds === 'number'
  );
}

/**
 * Firestore の Timestamp / Date / ISO 文字列を ISO8601 文字列へ揃える。
 * 解釈できなければ null。
 */
export function toIsoStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  let millis: number | null = null;

  if (hasToMillis(value)) {
    millis = value.toMillis();
  } else if (value instanceof Date) {
    millis = value.getTime();
  } else if (hasSecondsPair(value)) {
    millis = value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000);
  } else if (typeof value === 'string') {
    const parsed = Date.parse(value);
    millis = Number.isNaN(parsed) ? null : parsed;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    millis = value;
  }

  if (millis === null || !Number.isFinite(millis)) {
    return null;
  }
  return new Date(millis).toISOString();
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 購読しているルームのドキュメントかを確認する。
 * `roomId` フィールドを持たない古いドキュメントは、購読先のパスを信じて通す。
 */
function belongsToRoom(data: Record<string, unknown>, roomId: string): boolean {
  const field = data.roomId;
  return field === undefined || field === roomId;
}

/**
 * `rooms/{roomId}/public/state` → 公開イベント。
 *
 * 参加者へ渡ってよいのは「フェーズ・問題ID・締切時刻」まで。
 * 問題文・選択肢・正解はこのドキュメントに存在しない（docs/FIRESTORE_MODEL.md §2）。
 */
export function publicStateToEnvelope(
  roomId: string,
  data: unknown,
): RoomEventEnvelope<PublicEventType, PublicEventPayload> | null {
  if (!isRecord(data) || !belongsToRoom(data, roomId)) {
    return null;
  }

  const phase = data.phase;
  if (typeof phase !== 'string' || !isRoomPhase(phase)) {
    return null;
  }

  const stateVersion = readFiniteNumber(data.stateVersion);
  if (stateVersion === null) {
    return null;
  }

  // updatedAt は Firestore が書き込み時に付けたサーバー時刻。
  // 読めなかったときだけ端末時刻で埋める（この値は識別用で、締切判定には一切使わない。
  // 締切はサーバーが決めた answerDeadlineAt と Snapshot API の serverTime だけで判断する）。
  const serverTime = toIsoStringOrNull(data.updatedAt) ?? new Date().toISOString();

  return {
    eventId: `${roomId}:public:${stateVersion}:${serverTime}`,
    type: publicEventTypeForPhase(phase),
    roomId,
    stateVersion,
    serverTime,
    payload: {
      phase,
      questionId: readNullableString(data.currentQuestionId),
      questionPosition: readFiniteNumber(data.currentQuestionPosition),
      answerDeadlineAt: toIsoStringOrNull(data.answerDeadlineAt),
    },
  };
}

/**
 * `rooms/{roomId}/staff/progress` の payload。
 *
 * **回答内訳そのものは載せない。** 「集計が出せる状態になったか」だけを伝え、
 * 実データは司会・投影の Snapshot API から取り直す。
 */
export type StaffProgressEventPayload = {
  participantCount: number | null;
  onlineCount: number | null;
  answeredCount: number | null;
  /** 締切後に内訳が用意されたか。中身は含めない。 */
  hasBreakdown: boolean;
};

/**
 * `rooms/{roomId}/staff/progress` → 司会・投影向けイベント。
 * **参加者はこのドキュメントを購読しない**（Rules でも拒否される）。
 */
export function staffProgressToEnvelope(
  roomId: string,
  data: unknown,
): RoomEventEnvelope<StaffEventType, StaffProgressEventPayload> | null {
  if (!isRecord(data) || !belongsToRoom(data, roomId)) {
    return null;
  }

  const stateVersion = readFiniteNumber(data.stateVersion);
  if (stateVersion === null) {
    return null;
  }

  const answeredCount = readFiniteNumber(data.answeredCount);
  const participantCount = readFiniteNumber(data.participantCount);
  const onlineCount = readFiniteNumber(data.onlineCount);
  const hasBreakdown = data.breakdown !== null && data.breakdown !== undefined;

  const serverTime = toIsoStringOrNull(data.updatedAt) ?? new Date().toISOString();

  return {
    eventId: `${roomId}:staff:${stateVersion}:${serverTime}`,
    type: hasBreakdown ? 'answers.breakdown' : 'answers.progress',
    roomId,
    stateVersion,
    serverTime,
    payload: { participantCount, onlineCount, answeredCount, hasBreakdown },
  };
}

/**
 * 進捗系イベントか。
 *
 * これらは**フェーズが変わらないまま何度も届く**（回答が増えるたび）。
 * stateVersion では新旧を判別できないため、受信側で別枠（間引き）で扱う。
 */
export function isProgressEventType(type: string): boolean {
  return (
    type === 'answers.progress' || type === 'answers.breakdown' || type === 'participants.progress'
  );
}
