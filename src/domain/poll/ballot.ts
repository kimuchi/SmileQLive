/**
 * 投票用紙 — 「何に投票するか」の一覧。
 *
 * クイズや抽選リストと同じく、司会者が事前に用意して使い回す資産。
 *
 * 選び方は 2 通り。
 *   flat   … 選択肢を平らに並べる（例: 出し物 A / B / C）
 *   nested … 2 段階で選ぶ（例: 部署を選んでから、その部署の出し物を選ぶ）
 *            候補が多いときに、スマホの画面で選びやすくなる。
 *
 * 何位まで選ぶか（rankDepth）と、順位ごとの点数（points）は自由に決められる。
 * 1 位だけ選ぶ会も、3 位まで選んで点数を重み付けする会もある。
 *
 * ここはドメイン層。Firestore にも React にも依存しない。
 */

export const BALLOT_STRUCTURES = ['flat', 'nested'] as const;
export type BallotStructure = (typeof BALLOT_STRUCTURES)[number];

export const BALLOT_STRUCTURE_LABELS: Record<BallotStructure, string> = {
  flat: '一覧から選ぶ',
  nested: '2段階で選ぶ',
};

export const BALLOT_STRUCTURE_HINTS: Record<BallotStructure, string> = {
  flat: '選択肢を並べて、そこから選びます。候補が 20 件くらいまでならこちら。',
  nested: 'まず大きな区分（部署・チームなど）を選び、その中から選びます。候補が多いときに。',
};

export function isBallotStructure(value: unknown): value is BallotStructure {
  return typeof value === 'string' && (BALLOT_STRUCTURES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

/** 1 枚の投票用紙に入れられる選択肢の数。 */
export const BALLOT_OPTION_MAX_COUNT = 200;
/** 2 段階のときの 1 階層目の数。 */
export const BALLOT_GROUP_MAX_COUNT = 50;
/** 選択肢 1 件の文字数。会場の後方から読める長さを超えない値。 */
export const BALLOT_LABEL_MAX_LENGTH = 60;

/** 何位まで選べるか。1 位だけ〜5 位まで。 */
export const RANK_DEPTH_MIN = 1;
export const RANK_DEPTH_MAX = 5;
/** 順位ごとの点数。0 も許す（順位は付けるが点は入れない、という使い方）。 */
export const RANK_POINTS_MIN = 0;
export const RANK_POINTS_MAX = 1000;

// ---------------------------------------------------------------------------
// 中身
// ---------------------------------------------------------------------------

/** 2 段階のときの 1 階層目。 */
export type BallotGroup = {
  id: string;
  position: number;
  label: string;
};

/** 投票の対象。 */
export type BallotOption = {
  id: string;
  position: number;
  label: string;
  /**
   * 属する 1 階層目の ID。
   * flat では null。nested では必ず入る（入っていない選択肢は選べない）。
   */
  groupId: string | null;
  /** 補足（発表者名・部署名など）。無ければ null。 */
  note: string | null;
};

export type PollSettings = {
  /**
   * 何位まで選ぶか。
   *
   * 1 なら「いちばん良かったものを 1 つ」。3 なら 1〜3 位を選ぶ。
   */
  rankDepth: number;
  /**
   * 順位ごとの点数。`points[0]` が 1 位ぶん。
   *
   * 長さは rankDepth と同じ。3 位まで選ぶ会で `[5, 3, 1]` のように重みを付ける。
   */
  points: number[];
  /**
   * 結果発表で何位まで出すか。
   *
   * 3 なら 3 位 → 2 位 → 1 位の順に出す。1 なら 1 位だけ。
   * 選ぶ順位の数（rankDepth）とは別に決められる。
   * 3 位まで選ばせて 1 位だけ発表する、という会もある。
   */
  revealDepth: number;
  /** 結果の文字の大きさ（1920x1080 基準の px）。 */
  resultFontSize: number;
  /** 投影の背景に敷く画像。無ければ既定の背景。 */
  backgroundAssetId: string | null;
};

export const DEFAULT_POLL_SETTINGS: PollSettings = {
  rankDepth: 1,
  points: [1],
  revealDepth: 3,
  resultFontSize: 160,
  backgroundAssetId: null,
};

/** 発表できる順位の数の上限。これ以上出しても会場が飽きる。 */
export const REVEAL_DEPTH_MAX = 10;

/**
 * 順位ごとの点数を rankDepth の長さにそろえる。
 *
 * 保存済みの設定は、あとから rankDepth を変えると長さが食い違う。
 * 足りない順位は 1 点、余った順位は捨てる。
 */
export function normalizePoints(points: readonly number[], rankDepth: number): number[] {
  const depth = clampRankDepth(rankDepth);
  return Array.from({ length: depth }, (_, index) => {
    const value = points[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // 既定は「1 位ほど高い」。3 位まで選ぶなら 3,2,1。
      return depth - index;
    }
    return Math.min(RANK_POINTS_MAX, Math.max(RANK_POINTS_MIN, Math.round(value)));
  });
}

export function clampRankDepth(value: number): number {
  if (!Number.isFinite(value)) {
    return RANK_DEPTH_MIN;
  }
  return Math.min(RANK_DEPTH_MAX, Math.max(RANK_DEPTH_MIN, Math.round(value)));
}

export function clampRevealDepth(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(REVEAL_DEPTH_MAX, Math.max(1, Math.round(value)));
}

/**
 * 保存済みの設定を読む。
 *
 * 足りない項目は既定で埋め、点数の長さは rankDepth にそろえる。
 * 画面とサーバーで別々に埋めると食い違うので、読むときは必ずここを通す。
 */
export function pollSettingsOf(value: Partial<PollSettings> | null | undefined): PollSettings {
  const rankDepth = clampRankDepth(value?.rankDepth ?? DEFAULT_POLL_SETTINGS.rankDepth);
  return {
    rankDepth,
    points: normalizePoints(value?.points ?? [], rankDepth),
    revealDepth: clampRevealDepth(value?.revealDepth ?? DEFAULT_POLL_SETTINGS.revealDepth),
    resultFontSize: value?.resultFontSize ?? DEFAULT_POLL_SETTINGS.resultFontSize,
    backgroundAssetId: value?.backgroundAssetId ?? null,
  };
}

/**
 * 実際に発表できる順位の数。
 *
 * 選択肢が 2 件しか無い用紙で「3位まで発表」と決めても、3 位は存在しない。
 * そのまま出すと、司会が「3位を発表」を押したのに投影へ何も出ない。
 * 選択肢の数で頭打ちにして、司会画面・投影・サーバーの三者で同じ数を使う。
 */
export function effectiveRevealDepth(settings: PollSettings, optionCount: number): number {
  return clampRevealDepth(Math.min(settings.revealDepth, Math.max(1, optionCount)));
}

/**
 * ルームへ固める投票用紙。
 *
 * クイズの quizSnapshot と同じ考え方で、**ルームを作った瞬間の内容を写し取る**。
 * 当日に用紙を編集されても、進行中の投票の中身は変わらない。
 */
export type PollSnapshot = {
  ballotId: string;
  title: string;
  structure: BallotStructure;
  groups: BallotGroup[];
  options: BallotOption[];
  settings: PollSettings;
};

/** その 1 階層目に属する選択肢。flat では全件。 */
export function optionsOfGroup(
  snapshot: Pick<PollSnapshot, 'structure' | 'options'>,
  groupId: string | null,
): BallotOption[] {
  if (snapshot.structure === 'flat') {
    return [...snapshot.options];
  }
  return snapshot.options.filter((option) => option.groupId === groupId);
}

/**
 * 投票として受け付けてよい並びか。
 *
 * - 1 件以上、rankDepth 件以下
 * - 同じ選択肢を 2 つの順位へ入れない（1 位も 2 位も同じ人、は数えようがない）
 * - 用紙に無い選択肢を入れない
 * - 2 段階のとき、どの階層にも属していない選択肢は選べない
 */
export type BallotValidation = { ok: true } | { ok: false; reason: BallotRejectReason };

export type BallotRejectReason =
  'empty' | 'too_many' | 'duplicate' | 'unknown_option' | 'orphan_option';

export function validateChoices(
  snapshot: PollSnapshot,
  optionIds: readonly string[],
): BallotValidation {
  if (optionIds.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (optionIds.length > snapshot.settings.rankDepth) {
    return { ok: false, reason: 'too_many' };
  }
  if (new Set(optionIds).size !== optionIds.length) {
    return { ok: false, reason: 'duplicate' };
  }

  const byId = new Map(snapshot.options.map((option) => [option.id, option]));
  for (const id of optionIds) {
    const option = byId.get(id);
    if (!option) {
      return { ok: false, reason: 'unknown_option' };
    }
    if (snapshot.structure === 'nested' && option.groupId === null) {
      return { ok: false, reason: 'orphan_option' };
    }
  }
  return { ok: true };
}

/** 順位の呼び名。「1位」「2位」… */
export function rankLabel(rank: number): string {
  return `${rank}位`;
}
