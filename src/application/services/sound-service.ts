import 'server-only';

/**
 * 効果音の差し替え。
 *
 * 狙い: **デプロイし直さずに会場の音を変えられること。**
 * 同梱しているのは仮の音で、本番では効果音ラボなどの素材へ差し替えて使う。
 * 以前はリポジトリへ置いてビルドし直すしかなく、当日の調整ができなかった。
 *
 * **設定はシステム全体で 1 つ。ログインも要らない。**
 * 会場では投影担当・司会・音響が別の人で、別の端末で開く。
 * そこで「音を差し替えたいだけ」なのにログインを求めると、
 * 当日その場で直せなくなる（実際にいちばん詰まるのがここ）。
 *
 * その代わり、**URL を知っている人は誰でも差し替えられる**。
 * 社内の催しで使う前提の割り切りで、外へ公開する場合は
 * Cloud Run 側（IAM・IAP・社内ネットワーク限定）で入口を絞ること。
 * docs/SOUNDS.md に書いてある。
 *
 * 守っている約束:
 * - 音源をリポジトリへ持ち込まない。効果音ラボの規約が**再配布と直リンクを禁じている**ため、
 *   置き場所は Cloud Storage、配りは自分のドメイン経由にする。
 * - 中身は変換しない。受け取ったバイト列をそのまま保存する（再エンコードは音質を落とす）。
 * - 形式の判定は拡張子でも Content-Type ヘッダーでもなく**実データ**で行う。
 * - 差し替えていない音は同梱の既定音が鳴る。設定が空でも会は成立する。
 */

import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import {
  buildSoundObjectPath,
  isAcceptedSoundMime,
  MAX_SOUND_UPLOAD_BYTES,
  soundExtensionFor,
} from '@/domain/media/sound-policy';
import { DEFAULT_SOUND_URLS, SOUND_NAMES, type SoundName } from '@/domain/sound/sound-catalog';
import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/infrastructure/logging/logger';
import {
  adoptSoundSettings,
  findLegacySoundSettings,
  getSoundSettings,
  getSoundSettingsByPublicId,
  putSoundOverride,
  removeSoundOverride,
  type SoundSettings,
} from '@/infrastructure/firebase/repositories/sound-repository';
import {
  deleteObject,
  buildStorageRef,
  readSoundObject,
  uploadSoundObject,
} from '@/infrastructure/firebase/storage/media-storage';
import { mediaBucketName } from '@/infrastructure/firebase/storage/media-storage';
import type { SoundSettingsResponse, SoundSlot } from '@/types/api';

/**
 * 設定を置くドキュメント ID。
 *
 * 以前は司会者の uid だった。**システム全体で 1 つ**にまとめたので固定値にする。
 * 「所有者」の形は残してあるが、指すのは常にこの 1 件。
 */
const SYSTEM_SOUND_OWNER_ID = 'system';

/**
 * システム全体の設定を読む。
 *
 * まとめ先がまだ空で、司会者ごとの古い設定が残っていれば**引き継ぐ**。
 * まとめた日に既に入れてあった音が既定へ戻ると、会場でいきなり音が変わる。
 * 引き継ぎは 1 度だけ起きて、以後はまとめ先を読むだけになる。
 */
async function getSystemSoundSettings(): Promise<SoundSettings | null> {
  const settings = await getSoundSettings(SYSTEM_SOUND_OWNER_ID);
  if (settings) {
    return settings;
  }

  const legacy = await findLegacySoundSettings(SYSTEM_SOUND_OWNER_ID);
  if (!legacy) {
    return null;
  }

  const adopted = await adoptSoundSettings(SYSTEM_SOUND_OWNER_ID, legacy);
  logger.info('sound.settings_adopted', {
    from: legacy.ownerId,
    soundCount: Object.keys(legacy.sounds).length,
  });
  return adopted;
}

/** 差し替えた音を配る URL。同一オリジンなので、バケットへ CORS を設定しなくてよい。 */
function soundFileUrl(publicId: string, name: SoundName, version: number): string {
  // 会の最中に差し替えても古い音がキャッシュから鳴らないよう、差し替え時刻を付ける。
  return `/api/sounds/${publicId}/${name}?v=${version}`;
}

/** 管理画面へ返す 9 音ぶんの状態。差し替えていない音も「既定」として必ず並べる。 */
function toSlots(settings: SoundSettings | null): SoundSlot[] {
  return SOUND_NAMES.map((name) => {
    const override = settings?.sounds[name];
    if (!override || !settings) {
      return { name, source: 'default', url: DEFAULT_SOUND_URLS[name] };
    }
    return {
      name,
      source: 'custom',
      url: soundFileUrl(settings.publicId, name, override.updatedAtMs),
      originalName: override.originalName,
      byteSize: override.byteSize,
      mimeType: override.mimeType,
      updatedAt: new Date(override.updatedAtMs).toISOString(),
    };
  });
}

/** 効果音の設定画面に出す一覧。 */
export async function listSoundSettings(): Promise<SoundSettingsResponse> {
  return { sounds: toSlots(await getSystemSoundSettings()) };
}

export type UploadSoundInput = {
  name: SoundName;
  file: File;
};

/**
 * 1 音を差し替える。
 *
 * 前に入っていた音の実体は、設定を書き換えたあとで消す。
 * 先に消すと、書き換えに失敗したとき「設定はあるのに実体が無い」状態になる。
 */
export async function uploadSound(input: UploadSoundInput): Promise<SoundSettingsResponse> {
  if (input.file.size > MAX_SOUND_UPLOAD_BYTES) {
    throw new AppError('SOUND_TOO_LARGE');
  }

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new AppError('SOUND_UNSUPPORTED_TYPE');
  }
  if (bytes.byteLength > MAX_SOUND_UPLOAD_BYTES) {
    throw new AppError('SOUND_TOO_LARGE');
  }

  // ファイル名や Content-Type ではなく実データで判定する（画像と同じ考え方）。
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !isAcceptedSoundMime(detected.mime)) {
    throw new AppError('SOUND_UNSUPPORTED_TYPE', {
      details: { reason: detected?.mime ?? 'unknown' },
    });
  }

  const assetId = randomUUID();
  const objectPath = buildSoundObjectPath(
    SYSTEM_SOUND_OWNER_ID,
    assetId,
    soundExtensionFor(detected.mime),
  );
  const bucket = mediaBucketName();

  await uploadSoundObject({ objectPath, buffer: bytes, contentType: detected.mime });

  // 差し替え先が空なら、先に古い設定を引き継いでおく（引き継ぐ前に書くと元が消えない）。
  await getSystemSoundSettings();

  const { settings, replaced } = await putSoundOverride(SYSTEM_SOUND_OWNER_ID, input.name, {
    assetId,
    bucket,
    objectPath,
    mimeType: detected.mime,
    byteSize: bytes.byteLength,
    originalName: input.file.name.slice(0, 120),
    updatedAtMs: Date.now(),
  });

  if (replaced) {
    await deleteObject(buildStorageRef(replaced.bucket, replaced.objectPath));
  }

  logger.info('sound.replaced', {
    name: input.name,
    mimeType: detected.mime,
    byteSize: bytes.byteLength,
  });
  return { sounds: toSlots(settings) };
}

/** 1 音を同梱の既定へ戻す。 */
export async function resetSound(name: SoundName): Promise<SoundSettingsResponse> {
  await getSystemSoundSettings();
  const { settings, removed } = await removeSoundOverride(SYSTEM_SOUND_OWNER_ID, name);

  if (removed) {
    await deleteObject(buildStorageRef(removed.bucket, removed.objectPath));
    logger.info('sound.reset', { name });
  }

  return { sounds: toSlots(settings) };
}

/**
 * 差し替えた音の中身。
 *
 * 投影画面と管理画面の試聴が呼ぶ。**セッションを要求しない。**
 * 投影担当は司会と違う端末で画面を開くため、ここで認証を求めると会場で詰まる。
 * 出すのは効果音そのもので、正解も名簿も含まない。
 * 配信 ID は推測できないので、URL を知らない人には届かない。
 */
export async function readSoundFile(
  publicId: string,
  name: SoundName,
): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> {
  const settings = await getSoundSettingsByPublicId(publicId);
  const override = settings?.sounds[name];
  if (!override) {
    return null;
  }
  const bytes = await readSoundObject(override.bucket, override.objectPath);
  return bytes ? { bytes, mimeType: override.mimeType } : null;
}

/**
 * 投影画面が鳴らす音の一覧。
 *
 * 投影画面はこれを読んでから音源を取りに行く。
 * **差し替えていない音も必ず入れる**（既定音の URL を入れる）。
 * 抜けを許すと、投影準備の画面に「用意できなかった音」として並んでしまう。
 *
 * 設定はシステム全体で 1 つなので、ルームによって中身は変わらない。
 * それでもルームごとの取得先 (`/api/rooms/{roomId}/sounds`) を残してあるのは、
 * 既に開いている投影画面がその URL を読み続けているため。
 */
export async function buildSoundManifest(): Promise<Record<SoundName, string>> {
  /*
    設定を読めなくても**同梱の音の一覧を返す**。

    差し替えた音が鳴らないのと、音が一切鳴らないのとでは会場での痛さが違う。
    保存先が一時的に落ちているときに投影を黙らせないよう、
    読めなければ既定へ倒す（差し替えた音は次に読めたときへ戻る）。
  */
  let settings: SoundSettings | null = null;
  try {
    settings = await getSystemSoundSettings();
  } catch (error) {
    logger.error('sound.manifest_fallback', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  const manifest = {} as Record<SoundName, string>;
  for (const name of SOUND_NAMES) {
    const override = settings?.sounds[name];
    manifest[name] =
      override && settings
        ? soundFileUrl(settings.publicId, name, override.updatedAtMs)
        : DEFAULT_SOUND_URLS[name];
  }
  return manifest;
}
