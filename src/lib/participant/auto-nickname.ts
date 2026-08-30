import 'server-only';
import { randomInt } from 'node:crypto';

/**
 * 名前を聞かずに参加してもらうときの表示名。
 *
 * 投票では参加者に名前を入力させない。二次元コードを読んだらそのまま投票させる。
 * それでも参加者行には表示名がいる（司会が名簿を開いたときに空欄が並ぶと、
 * どの行が誰なのか以前に、何行あるのかも読めない）ので、サーバーが割り当てる。
 *
 * **順番に振らない。** 「参加者1」「参加者2」と振るには通し番号を数える場所が要り、
 * 開場直後に全員が同時に読む場面で、そこが取り合いになる（参加人数の加算で
 * 一度やらかしている。transactions.ts の bumpParticipantCount を参照）。
 * 乱数なら誰とも相談せずに決められる。
 *
 * 紛らわしい文字（I・O・0・1）を外した 32 文字から 6 桁引く。
 * 500 人の会場でどこか 1 組がぶつかる見込みは 1 万分の 1 ほど。
 * それでもぶつかりうるので、**呼び出し側は重複したら引き直すこと**
 * （ルームの中でニックネームは一意、という決まりはこのモードでも崩さない）。
 */

const PREFIX = '参加者';

/** 紛らわしい I・O・0・1 を外した 32 文字。 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const SUFFIX_LENGTH = 6;

export function createAutoNickname(): string {
  let suffix = '';
  for (let index = 0; index < SUFFIX_LENGTH; index += 1) {
    suffix += ALPHABET.charAt(randomInt(ALPHABET.length));
  }
  return `${PREFIX}${suffix}`;
}
