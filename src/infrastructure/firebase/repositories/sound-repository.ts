import 'server-only';

/**
 * `soundSettings/{ownerId}` — 差し替えた効果音。
 *
 * - 呼び出す前に所有者の確認を済ませること（Admin SDK は Security Rules を迂回する）。
 * - 1 人 1 ドキュメント。9 音ぶんをまとめて持つので、読むのも書くのも 1 件で済む。
 * - **配信 ID (publicId) から引く経路**もここが持つ。投影画面は uid を知らないため。
 */

import { randomUUID } from 'node:crypto';
import { soundSettingsCollection, soundSettingsRef } from '@/infrastructure/firebase/paths';
import { nowTimestamp } from '@/infrastructure/firebase/converters';
import { isSoundName, type SoundName } from '@/domain/sound/sound-catalog';
import type { SoundOverrideDoc, SoundSettingsDoc } from '@/types/firestore';

/** 差し替えた音の一覧。差し替えていない音は入っていない。 */
export type SoundOverrides = Partial<Record<SoundName, SoundOverrideDoc>>;

export type SoundSettings = {
  ownerId: string;
  publicId: string;
  sounds: SoundOverrides;
};

/**
 * 保存済みの中身を読む。
 *
 * 知らない名前の音が入っていても捨てる（音の種類を減らしたあとの古いデータ）。
 * 会場で「鳴らない音の設定」を見せても混乱するだけなので、読む側で落とす。
 */
function toSettings(doc: SoundSettingsDoc): SoundSettings {
  const sounds: SoundOverrides = {};
  for (const [name, value] of Object.entries(doc.sounds ?? {})) {
    if (isSoundName(name) && value) {
      sounds[name] = value;
    }
  }
  return { ownerId: doc.ownerId, publicId: doc.publicId, sounds };
}

/**
 * 司会者の設定を読む。まだ 1 度も差し替えていなければ null。
 *
 * **読むだけでドキュメントを作らない。** 作ってしまうと、
 * 一度も設定を開いていない司会者ぶんの空ドキュメントが溜まる。
 */
export async function getSoundSettings(ownerId: string): Promise<SoundSettings | null> {
  const snapshot = await soundSettingsRef(ownerId).get();
  const data = snapshot.data();
  return data ? toSettings(data) : null;
}

/**
 * 配信 ID から設定を引く。
 *
 * 投影画面・管理画面の試聴はこの経路で音を取りに来る。
 * 見つからなければ null（既定音へ倒れるだけで、投影は止まらない）。
 */
export async function getSoundSettingsByPublicId(publicId: string): Promise<SoundSettings | null> {
  const snapshot = await soundSettingsCollection().where('publicId', '==', publicId).limit(1).get();
  const doc = snapshot.docs[0]?.data();
  return doc ? toSettings(doc) : null;
}

/**
 * 1 音を差し替える。
 *
 * ドキュメントが無ければ作る。そのとき配信 ID も振る。
 * 差し替え前に入っていた音は呼び出し側が消す（実体の削除は Storage の責務）。
 */
export async function putSoundOverride(
  ownerId: string,
  name: SoundName,
  override: SoundOverrideDoc,
): Promise<{ settings: SoundSettings; replaced: SoundOverrideDoc | null }> {
  const ref = soundSettingsRef(ownerId);
  const snapshot = await ref.get();
  const current = snapshot.data();

  const publicId = current?.publicId ?? randomUUID();
  const sounds: SoundOverrides = { ...(current?.sounds ?? {}), [name]: override };

  const next: SoundSettingsDoc = { ownerId, publicId, sounds, updatedAt: nowTimestamp() };
  await ref.set(next);

  return { settings: toSettings(next), replaced: current?.sounds?.[name] ?? null };
}

/**
 * 1 音を既定へ戻す。
 *
 * 設定そのものは消さない（配信 ID を保ち、他の音の差し替えを生かすため）。
 */
export async function removeSoundOverride(
  ownerId: string,
  name: SoundName,
): Promise<{ settings: SoundSettings | null; removed: SoundOverrideDoc | null }> {
  const ref = soundSettingsRef(ownerId);
  const snapshot = await ref.get();
  const current = snapshot.data();
  if (!current) {
    return { settings: null, removed: null };
  }

  const removed = current.sounds?.[name] ?? null;
  const sounds: SoundOverrides = { ...(current.sounds ?? {}) };
  delete sounds[name];

  const next: SoundSettingsDoc = {
    ownerId,
    publicId: current.publicId,
    sounds,
    updatedAt: nowTimestamp(),
  };
  await ref.set(next);

  return { settings: toSettings(next), removed };
}
