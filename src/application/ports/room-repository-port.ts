/**
 * ルーム・メンバー・投影リンクの永続化ポート（Firestore 版）。
 *
 * 原則:
 * - 進行状態は必ず Firestore にある。Cloud Run インスタンスのメモリへ保持しない。
 * - `rooms/{roomId}` は quizSnapshot（正解を含む）を持つため参加者へ読ませない。
 *   参加者が購読するのは `rooms/{roomId}/public/state` だけ。
 *   よって joinOpen などの公開項目は **本体と公開状態を必ず同時に**更新する。
 * - 状態遷移・参加登録・回答登録のような「壊れてはいけない書き込み」はここではなく
 *   `src/infrastructure/firebase/transactions.ts`（runTransaction）が担当する。
 *   このポートは参照と単純な更新だけを表す。
 *
 * 実装: `src/infrastructure/firebase/repositories/room-repository.ts`
 * （同モジュールは個別の関数として export する。サービス層は必要な関数だけを名前付きで import する）
 */

import type { Timestamp } from 'firebase-admin/firestore';
import type { QuizSnapshot } from '@/domain/quiz/quiz-snapshot';
import type { RoomListItem } from '@/types/api';
import type {
  PresentationLinkDoc,
  RoomDoc,
  RoomMemberDoc,
  RoomMemberRole,
} from '@/types/firestore';

export type CreateRoomDbInput = {
  ownerId: string;
  quizId: string;
  /** 参加トークンは平文を保存しない（SHA-256 ハッシュのみ）。 */
  joinTokenHash: string;
  /** 開催時点で固定するクイズのコピー。正解を含むため参加者へ渡さない。 */
  quizSnapshot: QuizSnapshot;
  maxParticipants: number;
};

export type CreatePresentationLinkInput = {
  roomId: string;
  /** 投影トークンも平文を保存しない。 */
  tokenHash: string;
  /** ISO8601。期限判定はサーバー時刻で行う。 */
  expiresAt: string;
  createdBy: string;
};

export type RoomRepository = {
  createRoom(input: CreateRoomDbInput): Promise<RoomDoc>;
  getRoom(roomId: string): Promise<RoomDoc | null>;
  requireRoom(roomId: string): Promise<RoomDoc>;
  findRoomByJoinTokenHash(tokenHash: string): Promise<RoomDoc | null>;
  rotateJoinToken(roomId: string, tokenHash: string): Promise<{ rotatedAt: string }>;
  /** 参加受付の開閉。公開状態 (`public/state`) も同時に更新する。 */
  setJoinOpen(roomId: string, open: boolean): Promise<void>;
  listRooms(ownerId: string): Promise<RoomListItem[]>;
  getRoomMembers(roomId: string, role?: RoomMemberRole): Promise<RoomMemberDoc[]>;
  getMember(roomId: string, authUserId: string): Promise<RoomMemberDoc | null>;
  upsertStaffMember(
    roomId: string,
    authUserId: string,
    role: Extract<RoomMemberRole, 'host' | 'presenter'>,
  ): Promise<RoomMemberDoc>;
  /**
   * メンバーはルーム配下にあるため roomId が要る。失敗しても進行を妨げない。
   * `lastSeenAt` を渡すと、新しいうちは書き直さない（人数が多い場面では必ず渡す）。
   */
  touchMemberPresence(
    roomId: string,
    memberId: string,
    lastSeenAt?: Timestamp | null,
  ): Promise<void>;
  countParticipants(roomId: string): Promise<number>;
  countActiveParticipants(roomId: string): Promise<number>;
  countAnswers(roomId: string, questionId: string): Promise<number>;
  createPresentationLink(input: CreatePresentationLinkInput): Promise<PresentationLinkDoc>;
  consumePresentationLink(tokenHash: string): Promise<PresentationLinkDoc>;
};
