import type { RoomPhase } from '@/domain/room/state-machine';

/**
 * Realtime イベント定義。
 *
 * 原則:
 * - DB 更新を先に確定させ、その後に Broadcast する。
 * - Broadcast だけから現在状態を組み立てない（必ず Snapshot で補正する）。
 * - イベントへ画像バイナリ・参加トークン・正解情報（発表前）を含めない。
 */

export type RoomEventEnvelope<TType extends string = string, TPayload = unknown> = {
  eventId: string;
  type: TType;
  roomId: string;
  stateVersion: number;
  /** ISO8601。クライアントはこれでサーバー時刻差を推定する。 */
  serverTime: string;
  payload: TPayload;
};

export const PUBLIC_EVENT_TYPES = [
  'room.lobby_updated',
  'question.ready',
  'question.opened',
  'question.locked',
  'answer.revealed',
  'scoreboard.shown',
  // 抽選会・ビンゴ
  'draw.ready',
  'draw.revealed',
  'room.finished',
] as const;
export type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

export const STAFF_EVENT_TYPES = [
  'participants.progress',
  'answers.progress',
  'answers.breakdown',
  'presentation.warning',
] as const;
export type StaffEventType = (typeof STAFF_EVENT_TYPES)[number];

/** Broadcast イベント名（Supabase Realtime の `event` 値）。 */
export const ROOM_STATE_EVENT = 'room_state';

export function publicChannelName(roomId: string): string {
  return `room:${roomId}:public`;
}

export function staffChannelName(roomId: string): string {
  return `room:${roomId}:staff`;
}

/** public チャンネルの payload は「状態が変わった」ことだけを伝え、詳細は Snapshot で取得する。 */
export type PublicEventPayload = {
  phase: RoomPhase;
  questionId: string | null;
  questionPosition: number | null;
  answerDeadlineAt: string | null;
};

export type ParticipantsProgressPayload = {
  participantCount: number;
  onlineCount: number;
};

export type AnswersProgressPayload = {
  questionId: string;
  answeredCount: number;
  participantCount: number;
  answerRate: number;
};

export type PresentationWarningPayload = {
  kind: 'realtime_disconnected' | 'image_load_failed' | 'audio_blocked';
  message: string;
};

export function createEventEnvelope<TType extends string, TPayload>(input: {
  eventId: string;
  type: TType;
  roomId: string;
  stateVersion: number;
  serverTime: string;
  payload: TPayload;
}): RoomEventEnvelope<TType, TPayload> {
  return { ...input };
}

/** フェーズから public イベント種別を導出する。 */
export function publicEventTypeForPhase(phase: RoomPhase): PublicEventType {
  switch (phase) {
    case 'lobby':
      return 'room.lobby_updated';
    case 'question_ready':
      return 'question.ready';
    case 'question_open':
      return 'question.opened';
    case 'question_locked':
      return 'question.locked';
    case 'answer_revealed':
      return 'answer.revealed';
    case 'scoreboard':
      return 'scoreboard.shown';
    case 'draw_ready':
      return 'draw.ready';
    case 'draw_revealed':
      return 'draw.revealed';
    case 'finished':
      return 'room.finished';
  }
}
