/**
 * 回答の参照・集計ポート（Firestore 版）。
 *
 * 原則:
 * - 回答の登録・正誤判定・締切判定は
 *   `src/infrastructure/firebase/transactions.ts` の `submitAnswer()` が行う。
 *   このポートは保存済みの `isCorrect` / `pointsAwarded` を読むだけで、再判定しない。
 * - 数値は**文字列のまま**扱う（Firestore の number は倍精度浮動小数点のため）。
 * - 集計を返してよいフェーズかどうかの判断はサービス層の責務。
 *
 * 実装: `src/infrastructure/firebase/repositories/answer-repository.ts`
 */

import type { AnswerBreakdown } from '@/domain/answer/answer-dto';
import type { QuestionType, Question } from '@/domain/quiz/question';
import type { ParticipantScore } from '@/domain/room/scoring';

/** トランザクション層へ渡す回答内容。数値は正規化済み文字列で渡す。 */
export type SubmitAnswerDbInput = {
  questionId: string;
  /** 選択式のときだけ使う。 */
  choiceId?: string | null;
  /** 参加者の生入力（数値式）。本人の結果画面にだけ表示する。 */
  numberRaw?: string | null;
  /** 正規化済みの数値（文字列）。判定・集計はこちらを使う。 */
  numberNormalized?: string | null;
};

/** 保存済みの回答。数値は文字列のまま保持する。 */
export type StoredAnswer = {
  id: string;
  roomId: string;
  questionId: string;
  participantId: string;
  answerType: QuestionType;
  choiceId: string | null;
  numberRaw: string | null;
  /** 正規化済みの数値（文字列）。集計はこちらを使う。 */
  numberValue: string | null;
  /** ISO8601。 */
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
  /** ランキングは members の集計値（回答と同じトランザクションで加算済み）を読む。 */
  getLeaderboard(roomId: string): Promise<ParticipantScore[]>;
  getMyTotals(roomId: string, participantId: string): Promise<MyTotals>;
};
