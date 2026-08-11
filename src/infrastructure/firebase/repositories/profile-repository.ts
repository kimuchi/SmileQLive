import 'server-only';

/**
 * 司会者プロフィールの読み取り。
 *
 * **書き込みは置かない。** `profiles/{uid}` の作成は管理者の明示操作
 * （npm run host:add / Firebase コンソール）に限る約束のため、
 * アプリ側に作成経路を作らない（docs/HOST_ACCESS.md）。
 */

import { profilesCollection, profileRef } from '@/infrastructure/firebase/paths';
import type { QuizShareTarget } from '@/types/api';

function toTarget(uid: string, data: { email?: string | null; displayName?: string | null }) {
  return {
    uid,
    email: data.email ?? null,
    displayName: data.displayName ?? null,
  } satisfies QuizShareTarget;
}

/** メールアドレスから司会者を探す。登録されていなければ null。 */
export async function findHostProfileByEmail(email: string): Promise<QuizShareTarget | null> {
  const snapshot = await profilesCollection().where('email', '==', email).limit(1).get();
  const doc = snapshot.docs[0];
  if (!doc) {
    return null;
  }
  return toTarget(doc.id, doc.data());
}

/**
 * uid の一覧をプロフィールへ解決する。
 * 見つからない uid（登録を外された司会者など）は uid だけを返し、落とさない。
 */
export async function resolveHostProfiles(
  uids: readonly string[],
): Promise<QuizShareTarget[]> {
  if (uids.length === 0) {
    return [];
  }
  const docs = await Promise.all(uids.map((uid) => profileRef(uid).get()));
  return docs.map((doc, index) => {
    const data = doc.data();
    return data ? toTarget(doc.id, data) : { uid: uids[index] ?? '', email: null, displayName: null };
  });
}

/** 司会者の一覧（共有相手の候補）。 */
export async function listHostProfiles(): Promise<QuizShareTarget[]> {
  const snapshot = await profilesCollection().get();
  return snapshot.docs.map((doc) => toTarget(doc.id, doc.data()));
}
