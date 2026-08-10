/** アプリケーション層が依存するポート型の再エクスポート。 */

export type { QuizReadOptions, QuizRepository } from '@/application/ports/quiz-repository-port';
export type {
  CreatePresentationLinkInput,
  CreateRoomDbInput,
  RoomRepository,
  TransitionRoomDbInput,
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
export type { EventPublisher } from '@/application/ports/event-publisher-port';
