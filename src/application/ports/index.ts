/**
 * アプリケーション層が依存するポート型の再エクスポート。
 *
 * Firebase 移行にあたり Realtime 送信のポート（EventPublisher）は廃止した。
 * `rooms/{roomId}/public/state` の更新そのものが参加者への通知になるため、
 * サービス層から明示的にイベントを送る必要がなくなった（docs/FIRESTORE_MODEL.md §2）。
 */

export type { QuizReadOptions, QuizRepository } from '@/application/ports/quiz-repository-port';
export type {
  CreatePresentationLinkInput,
  CreateRoomDbInput,
  RoomRepository,
} from '@/application/ports/room-repository-port';
export type {
  AnswerRepository,
  MyTotals,
  StoredAnswer,
  SubmitAnswerDbInput,
} from '@/application/ports/answer-repository-port';
export type {
  MediaAssetRecord,
  MediaRepository,
  MediaStorage,
  UploadProcessedImageInput,
} from '@/application/ports/media-storage-port';
