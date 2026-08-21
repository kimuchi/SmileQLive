import 'server-only';

/**
 * 抽選リストの永続化。
 *
 * 方針:
 * - 数字モードのリストは **entries を作らない**。範囲だけを保存し、読むときに展開する。
 *   1〜75 をドキュメント 75 件にするのは無駄で、書き換えのたびに壊れやすくなる。
 * - 名簿の一括入れ替え（貼り付け・CSV）は「全部消して全部書く」。
 *   1 行ずつ差分を取る作りにすると、順番の入れ替えで壊れやすい。
 * - 書き込みはすべてバッチにして、途中で切れた状態を残さない。
 */

import { getDb } from '@/infrastructure/firebase/admin';
import {
  drawEntriesCollection,
  drawEntryRef,
  drawListRef,
  drawListsCollection,
} from '@/infrastructure/firebase/paths';
import { nowTimestamp, toIsoOr } from '@/infrastructure/firebase/converters';
import {
  DEFAULT_DRAW_SETTINGS,
  DRAW_ENTRY_MAX_COUNT,
  buildNumberEntries,
  type DrawEntry,
  type DrawListKind,
  type DrawSettings,
} from '@/domain/draw/draw-list';
import { buildMediaLookup } from '@/infrastructure/firebase/repositories/media-repository';
import { AppError } from '@/lib/errors/app-error';
import type { MediaRef } from '@/domain/quiz/question';
import type { DrawListDoc, DrawListEntryDoc } from '@/types/firestore';

/** 一覧の上限（管理画面の表示用）。 */
const DRAW_LIST_LIMIT = 100;

/** Firestore のバッチ上限は 500。余裕を見て 400 ずつ書く。 */
const BATCH_CHUNK = 400;

export type CreateDrawListDbInput = {
  ownerId: string;
  title: string;
  kind: DrawListKind;
  numberMin: number | null;
  numberMax: number | null;
  settings?: Partial<DrawSettings>;
};

/** 管理画面へ返す 1 件。 */
export type AdminDrawEntry = {
  id: string;
  position: number;
  label: string;
  image: MediaRef | null;
};

export type AdminDrawList = {
  id: string;
  title: string;
  kind: DrawListKind;
  numberMin: number | null;
  numberMax: number | null;
  settings: DrawSettings;
  /**
   * 背景画像。`settings.backgroundAssetId` を配信 URL まで解決したもの。
   * 参照だけを返すと、画面を開き直したときに今の絵を出せない。
   */
  background: MediaRef | null;
  entryCount: number;
  entries: AdminDrawEntry[];
  createdAt: string;
  updatedAt: string;
};

export type DrawListSummary = {
  id: string;
  title: string;
  kind: DrawListKind;
  entryCount: number;
  numberMin: number | null;
  numberMax: number | null;
  createdAt: string;
  updatedAt: string;
};

function toSummary(doc: DrawListDoc): DrawListSummary {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    entryCount: doc.entryCount,
    numberMin: doc.numberMin,
    numberMax: doc.numberMax,
    createdAt: toIsoOr(doc.createdAt),
    updatedAt: toIsoOr(doc.updatedAt),
  };
}

export async function createDrawList(input: CreateDrawListDbInput): Promise<DrawListDoc> {
  const now = nowTimestamp();
  const listId = crypto.randomUUID();

  const entryCount =
    input.kind === 'number' && input.numberMin !== null && input.numberMax !== null
      ? input.numberMax - input.numberMin + 1
      : 0;

  const doc: DrawListDoc = {
    id: listId,
    ownerId: input.ownerId,
    title: input.title,
    kind: input.kind,
    numberMin: input.numberMin,
    numberMax: input.numberMax,
    settings: { ...DEFAULT_DRAW_SETTINGS, ...input.settings },
    entryCount,
    createdAt: now,
    updatedAt: now,
  };

  await drawListRef(listId).create(doc);
  return doc;
}

export async function getDrawList(listId: string): Promise<DrawListDoc | null> {
  return (await drawListRef(listId).get()).data() ?? null;
}

export async function requireDrawList(listId: string): Promise<DrawListDoc> {
  const list = await getDrawList(listId);
  if (!list) {
    throw new AppError('DRAW_LIST_NOT_FOUND');
  }
  return list;
}

export async function listDrawLists(ownerId: string): Promise<DrawListSummary[]> {
  const snapshot = await drawListsCollection()
    .where('ownerId', '==', ownerId)
    .orderBy('updatedAt', 'desc')
    .limit(DRAW_LIST_LIMIT)
    .get();

  return snapshot.docs.map((doc) => toSummary(doc.data()));
}

export async function updateDrawList(
  listId: string,
  patch: {
    title?: string;
    numberMin?: number | null;
    numberMax?: number | null;
    settings?: Partial<DrawSettings>;
  },
): Promise<DrawListDoc> {
  const current = await requireDrawList(listId);
  const now = nowTimestamp();

  const numberMin = patch.numberMin === undefined ? current.numberMin : patch.numberMin;
  const numberMax = patch.numberMax === undefined ? current.numberMax : patch.numberMax;
  const entryCount =
    current.kind === 'number' && numberMin !== null && numberMax !== null
      ? numberMax - numberMin + 1
      : current.entryCount;

  const next: DrawListDoc = {
    ...current,
    title: patch.title ?? current.title,
    numberMin,
    numberMax,
    settings: { ...current.settings, ...patch.settings },
    entryCount,
    updatedAt: now,
  };

  await drawListRef(listId).set(next);
  return next;
}

export async function deleteDrawList(listId: string): Promise<void> {
  await replaceEntries(listId, []);
  await drawListRef(listId).delete();
}

// ---------------------------------------------------------------------------
// エントリ
// ---------------------------------------------------------------------------

export async function getEntries(listId: string): Promise<DrawListEntryDoc[]> {
  const snapshot = await drawEntriesCollection(listId).orderBy('position', 'asc').get();
  return snapshot.docs.map((doc) => doc.data());
}

/**
 * エントリを丸ごと入れ替える。
 *
 * 貼り付け・CSV 取り込み・並べ替えのすべてがこれ 1 つで済む。
 * 差分を取る作りにすると、同姓同名や並べ替えで壊れやすくなる。
 */
export async function replaceEntries(
  listId: string,
  entries: ReadonlyArray<{ label: string; imageAssetId: string | null; imageAlt: string | null }>,
): Promise<DrawListEntryDoc[]> {
  if (entries.length > DRAW_ENTRY_MAX_COUNT) {
    throw new AppError('DRAW_LIST_TOO_LARGE', {
      details: { max: DRAW_ENTRY_MAX_COUNT, given: entries.length },
    });
  }

  const db = getDb();
  const existing = await drawEntriesCollection(listId).get();

  // 消してから書く。同じバッチにまとめると 500 件の上限を超えやすいので分ける。
  for (let index = 0; index < existing.docs.length; index += BATCH_CHUNK) {
    const batch = db.batch();
    for (const doc of existing.docs.slice(index, index + BATCH_CHUNK)) {
      batch.delete(doc.ref);
    }
    await batch.commit();
  }

  const now = nowTimestamp();
  const created: DrawListEntryDoc[] = entries.map((entry, index) => ({
    id: crypto.randomUUID(),
    listId,
    position: index + 1,
    label: entry.label,
    imageAssetId: entry.imageAssetId,
    imageAlt: entry.imageAlt,
    createdAt: now,
    updatedAt: now,
  }));

  for (let index = 0; index < created.length; index += BATCH_CHUNK) {
    const batch = db.batch();
    for (const entry of created.slice(index, index + BATCH_CHUNK)) {
      batch.create(drawEntryRef(listId, entry.id), entry);
    }
    await batch.commit();
  }

  await drawListRef(listId).update({ entryCount: created.length, updatedAt: now });

  return created;
}

/**
 * 抽選に使う形へ読み出す。
 *
 * 数字モードは範囲から展開する（保存されているエントリは無い）。
 * 画像はクイズのスナップショットと同じく **保存参照のまま**入れる。
 * 期限付きの署名 URL をルームへ固めてしまうと、当日には切れている。
 */
export async function loadDrawEntries(
  list: DrawListDoc,
  options: { resolveUrls?: boolean } = {},
): Promise<DrawEntry[]> {
  if (list.kind === 'number') {
    if (list.numberMin === null || list.numberMax === null) {
      throw new AppError('DRAW_LIST_EMPTY');
    }
    try {
      return buildNumberEntries(list.numberMin, list.numberMax);
    } catch (error) {
      throw new AppError('DRAW_LIST_RANGE_INVALID', { cause: error });
    }
  }

  const docs = await getEntries(list.id);
  const lookup = await buildMediaLookup(
    docs.map((doc) => doc.imageAssetId),
    { resolveUrls: options.resolveUrls ?? false },
  );

  return docs.map((doc) => {
    const asset = doc.imageAssetId ? lookup.get(doc.imageAssetId) : undefined;
    return {
      id: doc.id,
      position: doc.position,
      label: doc.label,
      image:
        doc.imageAssetId && asset
          ? {
              assetId: doc.imageAssetId,
              url: asset.url,
              alt: doc.imageAlt ?? doc.label,
              width: asset.width,
              height: asset.height,
            }
          : null,
    };
  });
}

/**
 * 背景画像を表示できる形に直す。
 *
 * 画像が消されていた場合は null を返す（画面には「画像なし」と出る）。
 * 背景は飾りなので代替テキストは持たせない。
 */
async function resolveBackground(list: DrawListDoc): Promise<MediaRef | null> {
  const assetId = list.settings.backgroundAssetId;
  if (assetId === null) {
    return null;
  }
  const lookup = await buildMediaLookup([assetId], { resolveUrls: true });
  const asset = lookup.get(assetId);
  if (!asset) {
    return null;
  }
  return { assetId, url: asset.url, alt: '', width: asset.width, height: asset.height };
}

/**
 * 管理画面向けに 1 件を読み出す。
 *
 * 画面で画像を見せるため、ここでは署名 URL まで解決する
 * （ルームへ固めるときは resolveUrls: false で保存参照のまま入れる）。
 */
export async function getDrawListDetail(list: DrawListDoc): Promise<AdminDrawList> {
  const entries = list.kind === 'number' ? [] : await loadDrawEntries(list, { resolveUrls: true });
  const background = await resolveBackground(list);

  return {
    id: list.id,
    title: list.title,
    kind: list.kind,
    numberMin: list.numberMin,
    numberMax: list.numberMax,
    settings: list.settings,
    background,
    entryCount: list.kind === 'number' ? list.entryCount : entries.length,
    entries: entries.map((entry) => ({
      id: entry.id,
      position: entry.position,
      label: entry.label,
      image: entry.image,
    })),
    createdAt: toIsoOr(list.createdAt),
    updatedAt: toIsoOr(list.updatedAt),
  };
}
