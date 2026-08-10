import 'server-only';

/**
 * Firestore のドキュメント参照ヘルパー。
 *
 * 方針:
 * - コレクション名の文字列を散らさない（COLLECTIONS / PUBLIC_STATE_DOC / STAFF_PROGRESS_DOC のみを使う）。
 * - 参照には `FirestoreDataConverter` を付け、読み書きの型を `src/types/firestore.ts` の
 *   ドキュメント型へ固定する。any は使わない。
 * - 参加者が読んでよいのは `rooms/{roomId}/public/state` だけ。
 *   `rooms/{roomId}` 本体と `quizzes/**` は正解を含むため、参照を作る側でも用途を取り違えないよう
 *   関数名で明確に分けている（実際の遮断は Security Rules 側で担保済み）。
 * - ここでは参照を組み立てるだけで、書き込みは行わない。
 */

import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  FirestoreDataConverter,
  PartialWithFieldValue,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { getDb } from '@/infrastructure/firebase/admin';
import {
  answerDocId,
  COLLECTIONS,
  PUBLIC_STATE_DOC,
  STAFF_PROGRESS_DOC,
  type AnswerDoc,
  type MediaAssetDoc,
  type PresentationLinkDoc,
  type ProfileDoc,
  type QuestionDoc,
  type QuizDoc,
  type RoomDoc,
  type RoomEventDoc,
  type RoomMemberDoc,
  type RoomPublicStateDoc,
  type RoomStaffProgressDoc,
} from '@/types/firestore';

// ---------------------------------------------------------------------------
// 型付きコンバータ
// ---------------------------------------------------------------------------

/**
 * ドキュメント型を固定するだけの薄いコンバータ。
 * 書き込みはすべて Admin SDK 経由（＝アプリ内で組み立てた値のみ）なので、
 * 読み取り時の再検証は行わない。ドメイン型へ変換する際に converters.ts 側で防御的に読む。
 */
function docConverter<T extends DocumentData>(): FirestoreDataConverter<T> {
  return {
    toFirestore(model: PartialWithFieldValue<T>): DocumentData {
      return model as DocumentData;
    },
    fromFirestore(snapshot: QueryDocumentSnapshot): T {
      return snapshot.data() as T;
    },
  };
}

const profileConverter = docConverter<ProfileDoc>();
const quizConverter = docConverter<QuizDoc>();
const questionConverter = docConverter<QuestionDoc>();
const mediaAssetConverter = docConverter<MediaAssetDoc>();
const roomConverter = docConverter<RoomDoc>();
const publicStateConverter = docConverter<RoomPublicStateDoc>();
const staffProgressConverter = docConverter<RoomStaffProgressDoc>();
const memberConverter = docConverter<RoomMemberDoc>();
const answerConverter = docConverter<AnswerDoc>();
const eventConverter = docConverter<RoomEventDoc>();
const presentationLinkConverter = docConverter<PresentationLinkDoc>();

/** `public/state` のような 2 セグメントのサブドキュメントパスを分解する。 */
function splitSubDocPath(path: string): { collectionId: string; documentId: string } {
  const [collectionId, documentId, ...rest] = path.split('/');
  if (!collectionId || !documentId || rest.length > 0) {
    throw new Error(`INVALID_SUBDOC_PATH: ${path}`);
  }
  return { collectionId, documentId };
}

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

export function profilesCollection(): CollectionReference<ProfileDoc> {
  return getDb().collection(COLLECTIONS.profiles).withConverter(profileConverter);
}

export function profileRef(uid: string): DocumentReference<ProfileDoc> {
  return profilesCollection().doc(uid);
}

// ---------------------------------------------------------------------------
// quizzes / questions（正解・解説を含む。参加者は到達不能）
// ---------------------------------------------------------------------------

export function quizzesCollection(): CollectionReference<QuizDoc> {
  return getDb().collection(COLLECTIONS.quizzes).withConverter(quizConverter);
}

export function quizRef(quizId: string): DocumentReference<QuizDoc> {
  return quizzesCollection().doc(quizId);
}

export function questionsCollection(quizId: string): CollectionReference<QuestionDoc> {
  return quizzesCollection()
    .doc(quizId)
    .collection(COLLECTIONS.questions)
    .withConverter(questionConverter);
}

export function questionRef(quizId: string, questionId: string): DocumentReference<QuestionDoc> {
  return questionsCollection(quizId).doc(questionId);
}

// ---------------------------------------------------------------------------
// mediaAssets
// ---------------------------------------------------------------------------

export function mediaAssetsCollection(): CollectionReference<MediaAssetDoc> {
  return getDb().collection(COLLECTIONS.mediaAssets).withConverter(mediaAssetConverter);
}

export function mediaAssetRef(assetId: string): DocumentReference<MediaAssetDoc> {
  return mediaAssetsCollection().doc(assetId);
}

// ---------------------------------------------------------------------------
// rooms（quizSnapshot に正解を含む。司会者のみ読める）
// ---------------------------------------------------------------------------

export function roomsCollection(): CollectionReference<RoomDoc> {
  return getDb().collection(COLLECTIONS.rooms).withConverter(roomConverter);
}

export function roomRef(roomId: string): DocumentReference<RoomDoc> {
  return roomsCollection().doc(roomId);
}

/**
 * `rooms/{roomId}/public/state`
 * 参加者・投影担当が購読する唯一のドキュメント。正解・問題文・選択肢を絶対に入れない。
 */
export function publicStateRef(roomId: string): DocumentReference<RoomPublicStateDoc> {
  const { collectionId, documentId } = splitSubDocPath(PUBLIC_STATE_DOC);
  return roomsCollection()
    .doc(roomId)
    .collection(collectionId)
    .withConverter(publicStateConverter)
    .doc(documentId);
}

/** `rooms/{roomId}/staff/progress` — 司会・投影のみ。 */
export function staffProgressRef(roomId: string): DocumentReference<RoomStaffProgressDoc> {
  const { collectionId, documentId } = splitSubDocPath(STAFF_PROGRESS_DOC);
  return roomsCollection()
    .doc(roomId)
    .collection(collectionId)
    .withConverter(staffProgressConverter)
    .doc(documentId);
}

export function membersCollection(roomId: string): CollectionReference<RoomMemberDoc> {
  return roomsCollection()
    .doc(roomId)
    .collection(COLLECTIONS.members)
    .withConverter(memberConverter);
}

/** メンバー ID は Firebase Auth の uid をそのまま使う（1 ユーザー 1 行を ID で担保する）。 */
export function memberRef(roomId: string, memberId: string): DocumentReference<RoomMemberDoc> {
  return membersCollection(roomId).doc(memberId);
}

export function answersCollection(roomId: string): CollectionReference<AnswerDoc> {
  return roomsCollection()
    .doc(roomId)
    .collection(COLLECTIONS.answers)
    .withConverter(answerConverter);
}

/**
 * 回答ドキュメント。ID は `${questionId}__${participantId}` で決定的。
 * `create()` と組み合わせることで「1 参加者 1 問 1 回答」を UNIQUE 制約と同じ強さで担保する。
 */
export function answerRef(
  roomId: string,
  questionId: string,
  participantId: string,
): DocumentReference<AnswerDoc> {
  return answersCollection(roomId).doc(answerDocId(questionId, participantId));
}

export function eventsCollection(roomId: string): CollectionReference<RoomEventDoc> {
  return roomsCollection().doc(roomId).collection(COLLECTIONS.events).withConverter(eventConverter);
}

/** 監査ログ。ドキュメント ID を stateVersion にすることで二重記録を防ぐ。 */
export function eventRef(roomId: string, stateVersion: number): DocumentReference<RoomEventDoc> {
  return eventsCollection(roomId).doc(String(stateVersion));
}

// ---------------------------------------------------------------------------
// presentationLinks（クライアントからは読めない）
// ---------------------------------------------------------------------------

export function presentationLinksCollection(): CollectionReference<PresentationLinkDoc> {
  return getDb().collection(COLLECTIONS.presentationLinks).withConverter(presentationLinkConverter);
}

export function presentationLinkRef(linkId: string): DocumentReference<PresentationLinkDoc> {
  return presentationLinksCollection().doc(linkId);
}
