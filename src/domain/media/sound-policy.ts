/**
 * 差し替える効果音として受け入れる形式。
 *
 * 画像 (image-policy.ts) と違い、**中身は変換しない**。
 * 音を再エンコードすると音質が落ちるうえ、変換ライブラリを 1 つ増やすことになる。
 * 受け取ったバイト列をそのまま保存し、ブラウザに解釈させる。
 *
 * そのぶん「ブラウザが再生できる形式か」を入口で厳しく見る。
 * 判定は拡張子や Content-Type ヘッダーではなく**実データの magic bytes** で行う
 * （画像と同じ考え方。file-type が返した mime だけを信用する）。
 */

/**
 * 受け入れる音声形式。
 *
 * どれも AudioContext.decodeAudioData が扱える。
 * FLAC は対応が分かれるため入れていない（会場で鳴らないほうが困る）。
 */
export const ACCEPTED_SOUND_MIME_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
] as const;

export type AcceptedSoundMime = (typeof ACCEPTED_SOUND_MIME_TYPES)[number];

export function isAcceptedSoundMime(mime: string): mime is AcceptedSoundMime {
  return (ACCEPTED_SOUND_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * 1 ファイルの上限。
 *
 * 効果音は数秒のものばかりで、mp3 なら 100KB 前後に収まる。
 * 上限を大きくしても投影画面の読み込みが遅くなるだけなので、余裕を見て 8MB。
 */
export const MAX_SOUND_UPLOAD_BYTES = 8 * 1024 * 1024;

/** ファイル選択ダイアログに出す拡張子。判定そのものは magic bytes で行う。 */
export const SOUND_FILE_ACCEPT = '.mp3,.wav,.ogg,.m4a,.aac,audio/*';

/** 保存するときの拡張子。ブラウザは Content-Type を見るので表示用に近い。 */
export function soundExtensionFor(mime: AcceptedSoundMime): string {
  switch (mime) {
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/vnd.wave':
      return 'wav';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
  }
}

/**
 * 保存先のパス。
 *
 * `sounds/<ownerId>/<assetId>.<ext>`
 * 差し替えるたびに新しい assetId を振る。同じパスへ上書きしないのは、
 * 会の最中に差し替えたときブラウザの古いキャッシュと食い違わないようにするため。
 */
export function buildSoundObjectPath(ownerId: string, assetId: string, extension: string): string {
  return `sounds/${ownerId}/${assetId}.${extension}`;
}
