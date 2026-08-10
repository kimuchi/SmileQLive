/**
 * ブラウザ側 Firestore の参照ヘルパー。
 *
 * 方針:
 * - コレクション名の文字列を散らさない（`src/types/firestore.ts` の定数だけを使う）。
 *   サーバー側の `src/infrastructure/firebase/paths.ts` と同じ定数を共有するため、
 *   参照先がずれることがない。
 * - **参加者が到達してよいのは `rooms/{roomId}/public/state` だけ。**
 *   `rooms/{roomId}` 本体と `quizzes/**` は正解を含むため、ここに参照を作らない
 *   （Security Rules でも拒否されるが、そもそも組み立てさせない）。
 * - ここでは参照を組み立てるだけ。**クライアントからの書き込みは一切行わない。**
 */

import { doc, type DocumentReference, type Firestore } from 'firebase/firestore';
import { COLLECTIONS, PUBLIC_STATE_DOC, STAFF_PROGRESS_DOC } from '@/types/firestore';

/** `public/state` のような 2 セグメントのサブドキュメントパスを分解する。 */
function splitSubDocPath(path: string): { collectionId: string; documentId: string } {
  const segments = path.split('/');
  const collectionId = segments[0];
  const documentId = segments[1];
  if (!collectionId || !documentId || segments.length !== 2) {
    throw new Error(`INVALID_SUBDOC_PATH: ${path}`);
  }
  return { collectionId, documentId };
}

/**
 * `rooms/{roomId}/public/state`
 *
 * 参加者・投影担当・司会が購読する唯一の公開ドキュメント。
 * 正解・問題文・選択肢を含まない（docs/FIRESTORE_MODEL.md §2）。
 */
export function publicStateDocRef(db: Firestore, roomId: string): DocumentReference {
  const { collectionId, documentId } = splitSubDocPath(PUBLIC_STATE_DOC);
  return doc(db, COLLECTIONS.rooms, roomId, collectionId, documentId);
}

/**
 * `rooms/{roomId}/staff/progress`
 *
 * **司会・投影担当のみ。参加者はこの関数を呼ばない。**
 * 呼び出し側（use-room-channel）で audience を確認すること。
 */
export function staffProgressDocRef(db: Firestore, roomId: string): DocumentReference {
  const { collectionId, documentId } = splitSubDocPath(STAFF_PROGRESS_DOC);
  return doc(db, COLLECTIONS.rooms, roomId, collectionId, documentId);
}
