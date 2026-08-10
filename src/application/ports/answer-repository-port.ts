/**
 * 回答・集計の永続化ポート。
 *
 * - 正誤判定は DB (numeric) が行い、その結果 (answers.is_correct) を読むだけ。
 *   アプリ側で JavaScript の number により再判定しない。
 * - 数値は文字列のまま扱う。
 */

import type { AnswerBreakdown } from '@/domain/answer/answer-dto';
import type { ParticipantScore } from '@/domain/room/scoring';
import type { AnswerRow } from '@/types/database';
import type { Question } from '@/domain/quiz/question';

export type SubmitAnswerDbInput = {
  roomId: string;
  questionId: string;
  /** 読み直し用。認可済みの room_members.id。 */
  participantId: string;
  choiceId?: string | null;
  /** 参加者が入力した生文字列。 */
  numberRaw?: string | null;
  /** 正規化済み文字列。DB の numeric へ渡す。 */
  numberValue?: string | null;
};

export type StoredAnswer = {
  id: string;
  roomId: string;
  questionId: string;
  participantId: string;
  answerType: 'choice' | 'number';
  choiceId: string | null;
  numberRaw: string | null;
  /** numeric を文字列のまま保持する。 */
  numberValue: string | null;
  answeredAt: string;
  elapsedMs: number;
  isCorrect: boolean;
  pointsAwarded: number;
};

export type MyTotals = {
  totalPoints: number;
  correctCount: number;
  correctElapsedMsTotal: number;
};

export type AnswerRepository = {
  /** DB の submit_answer RPC を呼ぶ。締切・重複・正誤はすべて DB 側で確定する。 */
  submitAnswer(input: SubmitAnswerDbInput): Promise<StoredAnswer>;
  getMyAnswer(
    roomId: string,
    questionId: string,
    participantId: string,
  ): Promise<StoredAnswer | null>;
  getBreakdown(
    roomId: string,
    questionId: string,
    question: Question,
    totalParticipants: number,
  ): Promise<AnswerBreakdown>;
  getLeaderboard(roomId: string): Promise<ParticipantScore[]>;
  getMyTotals(roomId: string, participantId: string): Promise<MyTotals>;
};

/** AnswerRow から DTO へ写す（numeric は文字列のまま）。 */
export type AnswerRowLike = Pick<
  AnswerRow,
  'id' | 'room_id' | 'question_id' | 'participant_id' | 'answer_type'
>;
