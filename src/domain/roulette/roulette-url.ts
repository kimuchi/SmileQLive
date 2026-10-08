/**
 * ルーレットの盤面を URL でやりとりする。
 *
 * `/roulette?json={...}` の形で、盤面まるごとを URL に載せる。
 * サーバーに何も保存しないので、**この URL が保存先**になる。
 * 貼っておけば来年も同じ盤面が開けるし、他の人へそのまま渡せる。
 *
 * 形は配布されているルーレット（exe.tanidaiz.com/roulette.php）に**合わせてある**。
 *
 *   {
 *     "name": ["山田", "田中"],
 *     "ratio": [1, 2],
 *     "show_characters_value": true,
 *     "decel_value": 0.008,
 *
 *     // ここから下はこの画面だけの項目。あちらは無視する。
 *     "speed_value": 720,
 *     "stop_seconds": 5,
 *     "background_url": "https://example.com/bg.jpg"
 *   }
 *
 * 揃えている理由は、すでに配られている URL をそのまま開けるようにするため。
 * 会場で「去年の URL がある」と言われたときに、作り直さずに済む。
 * 逆にこちらで書き出した URL をあちらへ貼っても開ける
 * （`decel_value` は、こちらの速さと止まる秒数から換算して書き出している）。
 *
 * **外から来た文字列として扱う。** 長さ・型・件数をすべて検査し、
 * 壊れていても例外を投げずに「読めなかった」を返す。
 * 会場で URL が壊れていたときに、白い画面ではなく編集欄を出したい。
 */

import { decelValueFor, stopSecondsFromDecel } from '@/domain/roulette/spin';
import {
  clampSpeed,
  clampStopSeconds,
  clampWeight,
  normalizeBackgroundUrl,
  normalizeLabel,
  ROULETTE_ITEM_MAX_COUNT,
  ROULETTE_SPEED_DEFAULT,
  ROULETTE_STOP_SECONDS_DEFAULT,
  type RouletteConfig,
  type RouletteItem,
} from '@/domain/roulette/wheel';

/** URL のクエリ名。配布サイトと同じ。 */
export const ROULETTE_QUERY_KEY = 'json';

/**
 * 受け取る JSON の長さの上限。
 *
 * 200 項目 × 60 文字でも 20KB ほど。余裕を見て 64KB で頭打ちにする。
 * ブラウザやサーバーが受け付ける URL の長さを超えたものを、
 * 律儀に解こうとして時間を使わないため。
 */
export const ROULETTE_JSON_MAX_LENGTH = 64 * 1024;

/** URL に載せる形。 */
type RouletteJson = {
  name: string[];
  ratio: number[];
  show_characters_value: boolean;
  /** 配布サイト互換。こちらの速さと止まる秒数から換算して書き出す。 */
  decel_value: number;
  /** 回っている間の速さ（度/秒）。 */
  speed_value: number;
  /** ストップを押してから止まるまでの秒数。 */
  stop_seconds: number;
  /** 背景画像の URL。無ければ入れない。 */
  background_url?: string;
};

export type RouletteParseResult =
  | { ok: true; config: RouletteConfig; truncated: number }
  | { ok: false; reason: 'empty' | 'invalid' };

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  // 配布サイトは数値で入れるが、手で書いた URL では文字列のことがある。
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * `?json=` の中身を盤面へ読み解く。
 *
 * 名前と重みの数が合わないことがある（手で書き足した URL など）。
 * **足りない重みは 1 として扱い、余った重みは捨てる。** 名前の側を正とする。
 * 名前が空の行は落とす（扇にならないため）。
 */
export function parseRouletteJson(
  raw: string | null | undefined,
  makeId: () => string,
): RouletteParseResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (raw.length > ROULETTE_JSON_MAX_LENGTH) {
    return { ok: false, reason: 'invalid' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid' };
  }

  const record = parsed as Partial<RouletteJson>;
  const names = record.name;
  if (!Array.isArray(names)) {
    return { ok: false, reason: 'invalid' };
  }

  const ratios = Array.isArray(record.ratio) ? record.ratio : [];

  const items: RouletteItem[] = [];
  let truncated = 0;
  for (const [index, rawName] of names.entries()) {
    if (typeof rawName !== 'string') {
      continue;
    }
    const label = normalizeLabel(rawName);
    if (label.length === 0) {
      continue;
    }
    if (items.length >= ROULETTE_ITEM_MAX_COUNT) {
      truncated += 1;
      continue;
    }
    items.push({
      id: makeId(),
      label,
      weight: clampWeight(toNumber(ratios[index]) ?? 1),
    });
  }

  if (items.length === 0) {
    return { ok: false, reason: 'invalid' };
  }

  const spinSpeed = clampSpeed(toNumber(record.speed_value) ?? ROULETTE_SPEED_DEFAULT);

  return {
    ok: true,
    truncated,
    config: {
      items,
      // 指定が無ければ出す。文字の無い盤面は「壊れている」ように見える。
      showLabels: record.show_characters_value !== false,
      spinSpeed,
      stopSeconds: readStopSeconds(record, spinSpeed),
      backgroundUrl: normalizeBackgroundUrl(record.background_url),
    },
  };
}

/**
 * 止まるまでの秒数を読む。
 *
 * こちらで書き出した URL には `stop_seconds` が入っている。
 * 配布サイトから来た URL には `decel_value` しか無いので、
 * **この画面の速さでその減速をかけたら何秒で止まるか**へ読み替える。
 * 数字は違っても「速く止まる設定は速く止まる」という感じは保たれる。
 */
function readStopSeconds(record: Partial<RouletteJson>, spinSpeed: number): number {
  const explicit = toNumber(record.stop_seconds);
  if (explicit !== null) {
    return clampStopSeconds(explicit);
  }
  const decel = toNumber(record.decel_value);
  if (decel !== null && decel > 0) {
    return clampStopSeconds(stopSecondsFromDecel(decel, spinSpeed));
  }
  return ROULETTE_STOP_SECONDS_DEFAULT;
}

/**
 * いまの盤面を URL に載せる形にする。
 *
 * 名前が空の項目は入れない。空の扇が載った URL を配ってしまわないため。
 * 背景が手元のファイル（`blob:`）のときは載せない。**渡した相手には開けないため**で、
 * 載せると「送ったのに背景が出ない」という分かりにくい壊れ方になる。
 */
export function toRouletteJson(config: RouletteConfig): string {
  const items = config.items
    .map((item) => ({ ...item, label: normalizeLabel(item.label) }))
    .filter((item) => item.label.length > 0);

  const background = config.backgroundUrl;
  const shareableBackground =
    background !== null && !background.toLowerCase().startsWith('blob:') ? background : null;

  const payload: RouletteJson = {
    name: items.map((item) => item.label),
    ratio: items.map((item) => item.weight),
    show_characters_value: config.showLabels,
    // 配布サイトへ貼ったときも近い回り方になるよう、換算して書き出す。
    decel_value: Number(decelValueFor(config.spinSpeed, config.stopSeconds).toFixed(6)),
    speed_value: config.spinSpeed,
    stop_seconds: config.stopSeconds,
    ...(shareableBackground !== null ? { background_url: shareableBackground } : {}),
  };
  return JSON.stringify(payload);
}

/**
 * 共有用の URL を組み立てる。
 *
 * `origin` は画面から渡す（サーバー側の設定に依存させない。
 * 会場では社内 DNS 名で開いていることがあり、設定した正式ドメインを返すと
 * その場で開けない URL を配ってしまう）。
 */
export function buildRouletteUrl(
  origin: string,
  config: RouletteConfig,
  path = '/roulette',
): string {
  const url = new URL(path, origin);
  url.searchParams.set(ROULETTE_QUERY_KEY, toRouletteJson(config));
  return url.toString();
}
