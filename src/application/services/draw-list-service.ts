import 'server-only';

/**
 * 抽選リストのユースケース。
 *
 * 原則:
 * - 触れるのは作った本人だけ（クイズの共有のような仕組みは持たない）。
 * - 貼り付け・CSV の解釈は domain/draw/roster-import.ts が行う。
 *   ここでは「解釈した結果を保存する」だけにして、文字列の処理を散らさない。
 * - エントリの更新は**常に全件の入れ替え**にする。1 行ずつの差分にすると、
 *   同姓同名や並べ替えで壊れやすくなる。
 */

import {
  DRAW_ENTRY_MAX_COUNT,
  DRAW_LABEL_MAX_LENGTH,
  drawKindsForMode,
  isDrawKindAllowedForMode,
  isDrawListKind,
  type DrawListKind,
  type DrawSettings,
  type DrawSnapshot,
} from '@/domain/draw/draw-list';
import { parseRosterText, type RosterImportResult } from '@/domain/draw/roster-import';
import {
  createDrawList as createDrawListRepo,
  deleteDrawList as deleteDrawListRepo,
  getDrawListDetail,
  getEntries,
  loadDrawEntries,
  listDrawLists as listDrawListsRepo,
  replaceEntries,
  requireDrawList,
  updateDrawList as updateDrawListRepo,
  type AdminDrawList,
  type DrawListSummary,
} from '@/infrastructure/firebase/repositories/draw-list-repository';
import { requireHostUser } from '@/lib/auth/session';
import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/infrastructure/logging/logger';
import type { DrawListDoc } from '@/types/firestore';

export type { AdminDrawList, DrawListSummary };

async function requireOwnedDrawList(listId: string): Promise<DrawListDoc> {
  const { user } = await requireHostUser();
  const list = await requireDrawList(listId);
  if (list.ownerId !== user.uid) {
    throw new AppError('FORBIDDEN');
  }
  return list;
}

/**
 * ルームへ固める形で読み出す。
 *
 * クイズの buildSnapshotForQuiz と同じ役割。**署名 URL は入れない**
 * （期限付きの URL をルームへ固めると、当日には切れている）。
 */
export async function buildDrawSnapshot(
  listId: string,
  mode: 'lottery' | 'bingo',
): Promise<DrawSnapshot> {
  const list = await requireOwnedDrawList(listId);

  if (!isDrawKindAllowedForMode(list.kind, mode)) {
    throw new AppError('DRAW_LIST_KIND_MISMATCH', {
      details: { kind: list.kind, mode, allowed: drawKindsForMode(mode) },
    });
  }

  const entries = await loadDrawEntries(list, { resolveUrls: false });
  if (entries.length === 0) {
    throw new AppError('DRAW_LIST_EMPTY');
  }

  return {
    listId: list.id,
    title: list.title,
    kind: list.kind,
    entries,
    settings: list.settings,
  };
}

export async function listDrawLists(): Promise<DrawListSummary[]> {
  const { user } = await requireHostUser();
  return listDrawListsRepo(user.uid);
}

export async function createDrawList(input: {
  title: string;
  kind: string;
  numberMin?: number | null;
  numberMax?: number | null;
}): Promise<AdminDrawList> {
  const { user } = await requireHostUser();
  if (!isDrawListKind(input.kind)) {
    throw new AppError('VALIDATION_FAILED', { details: { reason: 'unknown_draw_list_kind' } });
  }
  const kind: DrawListKind = input.kind;

  // 数字モードは範囲が要る。既定はビンゴでよく使う 1〜75。
  const numberMin = kind === 'number' ? (input.numberMin ?? 1) : null;
  const numberMax = kind === 'number' ? (input.numberMax ?? 75) : null;
  if (numberMin !== null && numberMax !== null && numberMin > numberMax) {
    throw new AppError('DRAW_LIST_RANGE_INVALID');
  }

  const created = await createDrawListRepo({
    ownerId: user.uid,
    title: input.title,
    kind,
    numberMin,
    numberMax,
  });

  logger.info('draw_list.created', { listId: created.id, kind: created.kind });
  return getDrawListDetail(created);
}

export async function getDrawList(listId: string): Promise<AdminDrawList> {
  const list = await requireOwnedDrawList(listId);
  return getDrawListDetail(list);
}

export async function updateDrawList(
  listId: string,
  patch: {
    title?: string;
    numberMin?: number | null;
    numberMax?: number | null;
    settings?: Partial<DrawSettings>;
  },
): Promise<AdminDrawList> {
  const list = await requireOwnedDrawList(listId);

  if (list.kind !== 'number' && (patch.numberMin != null || patch.numberMax != null)) {
    throw new AppError('DRAW_LIST_KIND_MISMATCH', {
      details: { reason: 'number_range_on_non_number_list' },
    });
  }
  if (list.kind === 'number') {
    const min = patch.numberMin ?? list.numberMin ?? 1;
    const max = patch.numberMax ?? list.numberMax ?? 75;
    if (min > max || max - min + 1 > DRAW_ENTRY_MAX_COUNT) {
      throw new AppError('DRAW_LIST_RANGE_INVALID');
    }
  }

  const updated = await updateDrawListRepo(listId, patch);
  return getDrawListDetail(updated);
}

export async function deleteDrawList(listId: string): Promise<void> {
  const list = await requireOwnedDrawList(listId);
  await deleteDrawListRepo(list.id);
  logger.info('draw_list.deleted', { listId: list.id });
}

/**
 * エントリを丸ごと入れ替える。
 *
 * 画面から並べ替え・編集・削除をしたときも、常に「今の全部」を送ってもらう。
 */
export async function replaceDrawEntries(
  listId: string,
  entries: ReadonlyArray<{ label: string; imageAssetId?: string | null; imageAlt?: string | null }>,
): Promise<AdminDrawList> {
  const list = await requireOwnedDrawList(listId);
  if (list.kind === 'number') {
    throw new AppError('DRAW_LIST_KIND_MISMATCH', {
      details: { reason: 'entries_on_number_list' },
    });
  }

  const cleaned = entries
    .map((entry) => ({
      label: entry.label.trim().slice(0, DRAW_LABEL_MAX_LENGTH),
      // 品目モード以外では画像を持たせない（名簿に画像を混ぜない）。
      imageAssetId: list.kind === 'item' ? (entry.imageAssetId ?? null) : null,
      imageAlt: list.kind === 'item' ? (entry.imageAlt ?? null) : null,
    }))
    .filter((entry) => entry.label.length > 0);

  await replaceEntries(listId, cleaned);
  const updated = await requireDrawList(listId);
  logger.info('draw_list.entries_replaced', { listId, count: cleaned.length });
  return getDrawListDetail(updated);
}

/**
 * 貼り付け・CSV の文字列を解釈して保存する。
 *
 * 解釈の結果（何件読めたか・何を飛ばしたか）も返し、
 * 操作者が「取り込んだつもりで入っていない」に気づけるようにする。
 */
export async function importDrawEntries(
  listId: string,
  input: { text: string; hasHeader?: boolean; labelColumnIndex?: number; append?: boolean },
): Promise<{ list: AdminDrawList; imported: RosterImportResult }> {
  const list = await requireOwnedDrawList(listId);
  if (list.kind === 'number') {
    throw new AppError('DRAW_LIST_KIND_MISMATCH', {
      details: { reason: 'import_on_number_list' },
    });
  }

  const parsed = parseRosterText(input.text, {
    hasHeader: input.hasHeader,
    labelColumnIndex: input.labelColumnIndex,
    maxRows: DRAW_ENTRY_MAX_COUNT,
  });

  const existing = input.append === true ? await getEntries(listId) : [];
  const next = [
    ...existing.map((entry) => ({
      label: entry.label,
      imageAssetId: entry.imageAssetId,
      imageAlt: entry.imageAlt,
    })),
    ...parsed.rows.map((row) => ({ label: row.label, imageAssetId: null, imageAlt: null })),
  ];

  if (next.length > DRAW_ENTRY_MAX_COUNT) {
    throw new AppError('DRAW_LIST_TOO_LARGE', {
      details: { max: DRAW_ENTRY_MAX_COUNT, given: next.length },
    });
  }

  const updated = await replaceDrawEntries(listId, next);
  return { list: updated, imported: parsed };
}
