/**
 * ルーム進行の永続化ポート。
 *
 * 状態は必ず DB にある。Cloud Run インスタンスのメモリへ保持しない。
 */

import type { QuizSnapshot } from '@/domain/quiz/quiz-snapshot';
import type { RoomAction } from '@/domain/room/state-machine';
import type { RoomListItem } from '@/types/api';
import type { PresentationLinkRow, RoomMemberRole, RoomMemberRow, RoomRow } from '@/types/database';

export type CreateRoomDbInput = {
  ownerId: string;
  quizId: string;
  joinTokenHash: string;
  quizSnapshot: QuizSnapshot;
  maxParticipants: number;
};

export type CreatePresentationLinkInput = {
  roomId: string;
  tokenHash: string;
  expiresAt: string;
  createdBy: string;
};

export type TransitionRoomDbInput = {
  roomId: string;
  action: RoomAction;
  expectedVersion: number;
  questionId?: string | null;
};

export type RoomRepository = {
  createRoom(input: CreateRoomDbInput): Promise<RoomRow>;
  getRoom(roomId: string): Promise<RoomRow | null>;
  findRoomByJoinTokenHash(tokenHash: string): Promise<RoomRow | null>;
  rotateJoinToken(roomId: string, tokenHash: string): Promise<{ rotatedAt: string }>;
  setJoinOpen(roomId: string, open: boolean): Promise<void>;
  listRooms(ownerId: string): Promise<RoomListItem[]>;
  getRoomMembers(roomId: string, role?: RoomMemberRole): Promise<RoomMemberRow[]>;
  getMember(roomId: string, authUserId: string): Promise<RoomMemberRow | null>;
  upsertStaffMember(
    roomId: string,
    authUserId: string,
    role: Extract<RoomMemberRole, 'host' | 'presenter'>,
  ): Promise<RoomMemberRow>;
  countParticipants(roomId: string): Promise<number>;
  countAnswers(roomId: string, questionId: string): Promise<number>;
  createPresentationLink(input: CreatePresentationLinkInput): Promise<PresentationLinkRow>;
  consumePresentationLink(tokenHash: string): Promise<PresentationLinkRow>;
  /** DB 側の RPC で状態遷移を行う（state_version の検証も DB が行う）。 */
  transitionRoom(input: TransitionRoomDbInput): Promise<RoomRow>;
  touchMemberPresence(memberId: string): Promise<void>;
};
