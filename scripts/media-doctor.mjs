#!/usr/bin/env node
/**
 * 画像アップロードが通るかを 1 コマンドで確かめる。
 *
 *   npm run media:doctor                          既定の設定で一通り確認する
 *   npm run media:doctor -- --file ./failed.jpg   実際に失敗した画像を通してみる
 *   npm run media:doctor -- --env production      使う設定ファイルを指定する
 *
 * なぜ要るか:
 *   管理画面に出るのは「画像を…できませんでした」の一言だけで、
 *   画像そのものが悪いのか、保存先（Cloud Storage）の設定が悪いのかが分からない。
 *   ここでは本番と同じ順序で 1 段ずつ試し、**どこで落ちたか**を名指しする。
 *
 *     1. 動いているサービスが見ている保存先（手元の設定と食い違っていないか）
 *     2. 画像の判定（magic bytes）
 *     3. 変換（sharp: 回転補正 → 縮小 → WebP）
 *     4. 保存先バケットへの書き込み
 *     5. 配信用の署名付き URL の発行
 *     6. 後片付け（テスト用オブジェクトの削除）
 *
 * 方針:
 *   - アプリと同じ設定の読み方をする（MEDIA_BUCKET → FIREBASE_STORAGE_BUCKET → 既定）。
 *   - 何も壊さない。書くのは `__media-doctor/` 配下のテスト用オブジェクトだけで、最後に消す。
 *   - Windows / macOS / Linux で同じコマンドが動くよう、シェル機能に依存しない。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { configExists, configPath, ENVIRONMENTS, parseArgs } from './lib/config.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { flags } = parseArgs(process.argv.slice(2));

if (flags.has('help')) {
  heading('画像アップロードの診断');
  info('npm run media:doctor');
  info('npm run media:doctor -- --file ./失敗した画像.jpg');
  info('npm run media:doctor -- --env production');
  info('npm run media:doctor -- --skip-service   （動いているサービスを見ない）');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/**
 * デプロイ設定を読む（無くても止めない）。
 * 手元だけで動かす場合は環境変数だけで足りるため、ここで止めると診断できない。
 */
function readConfigSoftly() {
  const requested = typeof flags.get('env') === 'string' ? flags.get('env') : null;
  const available = ENVIRONMENTS.filter(configExists);
  const candidates = requested ? [requested] : available;

  // 両方あるのに黙って片方だけ見ると、「設定は合っているのに直らない」に陥る。
  if (!requested && available.length > 1) {
    warn(
      `設定ファイルが ${available.length} つあります（${available.join(' / ')}）。` +
        `いまは ${available[0]} を見ています。別のほうを見るには --env ${available[1]} を付けてください。`,
    );
  }

  for (const environment of candidates) {
    if (!configExists(environment)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(new URL(configPath(environment)), 'utf8'));
      return { environment, config: parsed };
    } catch {
      warn(`設定ファイルを読めませんでした: deploy/cloud-run.${environment}.json`);
    }
  }
  return { environment: null, config: null };
}

const { environment: configEnvironment, config } = readConfigSoftly();

const projectId =
  process.env.FIREBASE_PROJECT_ID || config?.firebaseProjectId || config?.projectId || '';

/** アプリ (`src/lib/env/server-env.ts`) と同じ順序で決める。 */
const bucketName =
  (typeof flags.get('bucket') === 'string' ? flags.get('bucket') : '') ||
  process.env.MEDIA_BUCKET ||
  process.env.QUIZ_MEDIA_BUCKET ||
  config?.mediaBucket ||
  process.env.FIREBASE_STORAGE_BUCKET ||
  (projectId ? `${projectId}.firebasestorage.app` : '');

heading('画像アップロードの診断');
info(`プロジェクト  : ${projectId || color.yellow('（不明）')}`);
info(`保存先        : ${bucketName || color.yellow('（不明）')}`);
info(`設定の出どころ: ${bucketSource()}`);
if (configEnvironment) {
  info(`設定ファイル  : deploy/cloud-run.${configEnvironment}.json`);
}

function bucketSource() {
  if (typeof flags.get('bucket') === 'string') return '--bucket';
  if (process.env.MEDIA_BUCKET) return '環境変数 MEDIA_BUCKET';
  if (process.env.QUIZ_MEDIA_BUCKET) return '環境変数 QUIZ_MEDIA_BUCKET';
  if (config?.mediaBucket) return `deploy/cloud-run.${configEnvironment}.json の mediaBucket`;
  if (process.env.FIREBASE_STORAGE_BUCKET) return '環境変数 FIREBASE_STORAGE_BUCKET';
  return '既定値（<プロジェクトID>.firebasestorage.app）';
}

if (!projectId) {
  fatal(
    'Firebase プロジェクト ID を特定できません。',
    'deploy/cloud-run.<env>.json を用意するか、FIREBASE_PROJECT_ID を設定してください。',
  );
}

const problems = [];

// ---------------------------------------------------------------------------
// 1. 動いているサービスの設定
//
// ここがいちばん見落としやすい。手元の設定ファイルを直しても、**デプロイし直すまで
// 動いているサービスの環境変数は古いまま**で、「設定は合っているのに直らない」になる。
// 実際に動いているリビジョンが何を見ているかを、先に突き合わせる。
// ---------------------------------------------------------------------------
if (config?.serviceName && config?.region && config?.projectId && !flags.has('skip-service')) {
  step('動いているサービスの保存先を確認');
  const deployed = deployedMediaBucket(config.projectId, config.region, config.serviceName);

  if (deployed === null) {
    info(
      color.dim(
        'サービスを読めませんでした（未デプロイ、または gcloud が使えません）。飛ばします。',
      ),
    );
  } else if (deployed === '') {
    problems.push(
      `動いているサービス ${config.serviceName} に MEDIA_BUCKET が設定されていません。` +
        `そのためアプリは既定値（${projectId}.firebasestorage.app）へ書こうとします。` +
        `npm run deploy でデプロイし直すと、設定ファイルの mediaBucket が渡ります。`,
    );
    warn(`MEDIA_BUCKET が未設定です（既定値 ${projectId}.firebasestorage.app が使われます）`);
  } else if (deployed !== bucketName) {
    problems.push(
      `設定ファイルは ${bucketName} ですが、動いているサービスは ${deployed} を見ています。` +
        `デプロイし直すか、--env で見る設定を合わせてください。`,
    );
    warn(`食い違っています: 設定 ${bucketName} / 稼働中 ${deployed}`);
  } else {
    success(`動いているサービスも ${deployed} を見ています`);
  }
}

/**
 * 動いているリビジョンの MEDIA_BUCKET を読む。
 *
 * 返り値: 文字列（設定あり）/ 空文字（サービスはあるが未設定）/ null（読めない）
 */
function deployedMediaBucket(project, region, service) {
  const result = spawnSync(
    'gcloud',
    [
      'run',
      'services',
      'describe',
      service,
      '--project',
      project,
      '--region',
      region,
      '--format=value(spec.template.spec.containers[0].env.filter("name:MEDIA_BUCKET").extract("value").flatten())',
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );

  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// 2. 画像の判定
// ---------------------------------------------------------------------------
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

step('画像を読む');

const filePath = typeof flags.get('file') === 'string' ? flags.get('file') : null;
let sourceBytes;
let sourceLabel;

if (filePath) {
  if (!existsSync(filePath)) {
    fatal(`ファイルが見つかりません: ${filePath}`);
  }
  sourceBytes = readFileSync(filePath);
  sourceLabel = basename(filePath);
  info(`${sourceLabel} (${Math.round(sourceBytes.length / 1024)} KB)`);
  if (sourceBytes.length > MAX_UPLOAD_BYTES) {
    problems.push('この画像は 8MB を超えています。アプリでも拒否されます。');
    warn('8MB を超えています（アプリでも拒否されます）');
  }
} else {
  const sharp = (await import('sharp')).default;
  sourceBytes = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: '#2f82ff' },
  })
    .jpeg()
    .toBuffer();
  sourceLabel = '検査用に作った JPEG';
  info(`${sourceLabel} (${Math.round(sourceBytes.length / 1024)} KB)`);
  info(color.dim('実際に失敗した画像があれば --file で指定してください。'));
}

const { fileTypeFromBuffer } = await import('file-type');
const detected = await fileTypeFromBuffer(sourceBytes);

if (!detected) {
  problems.push('画像の種類を判定できませんでした（先頭のバイト列が画像ではありません）。');
  warn('種類を判定できませんでした。壊れているか、画像ではありません。');
} else if (!ACCEPTED.includes(detected.mime)) {
  problems.push(
    `${detected.mime} は受け付けません。JPEG・PNG・WebP のいずれかへ変換してください` +
      `（iPhone の HEIC は「互換性優先」で撮るか、書き出し時に JPEG を選びます）。`,
  );
  warn(`${detected.mime}（拡張子: ${detected.ext}）は受け付けません`);
} else {
  success(`${detected.mime} として読めました`);
}

// ---------------------------------------------------------------------------
// 3. 変換
// ---------------------------------------------------------------------------
step('変換する（回転補正 → 縮小 → WebP）');

let processed = null;
try {
  const sharp = (await import('sharp')).default;
  info(`sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}`);

  const pipeline = sharp(sourceBytes, { failOn: 'error' });
  const metadata = await pipeline.metadata();
  info(
    `元画像: ${metadata.width ?? '?'}x${metadata.height ?? '?'} ` +
      `${metadata.format ?? '?'}${metadata.space ? ` / ${metadata.space}` : ''}` +
      `${(metadata.pages ?? 1) > 1 ? ` / ${metadata.pages} コマ` : ''}`,
  );

  if ((metadata.pages ?? 1) > 1) {
    problems.push('動く画像（アニメーション）は受け付けません。1 枚の画像にしてください。');
    warn('コマが複数あります。アニメーションは受け付けません。');
  }

  const result = await pipeline
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  processed = result;
  success(
    `WebP へ変換できました: ${result.info.width}x${result.info.height} ` +
      `${Math.round(result.info.size / 1024)} KB`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  problems.push(`画像を変換できませんでした: ${message}`);
  warn(`変換に失敗しました: ${message}`);
}

// ---------------------------------------------------------------------------
// 4〜6. 保存先
// ---------------------------------------------------------------------------
step('保存先へ書き込む');

if (!bucketName) {
  problems.push('保存先のバケット名を特定できませんでした。');
  warn('バケット名が分かりません。MEDIA_BUCKET を設定してください。');
} else if (!processed) {
  warn('変換できていないので、書き込みは試しません。');
} else {
  const { getApps, initializeApp } = await import('firebase-admin/app');
  const { getStorage } = await import('firebase-admin/storage');

  const app =
    getApps().length > 0 ? getApps()[0] : initializeApp({ projectId, storageBucket: bucketName });
  const bucket = getStorage(app).bucket(bucketName);

  // 実データと混ざらない場所へ書く。名前で用途が分かるようにしておく。
  const objectPath = `__media-doctor/${new Date().toISOString().replace(/[:.]/g, '-')}.webp`;
  let written = false;

  try {
    await bucket.file(objectPath).save(processed.data, {
      resumable: false,
      contentType: 'image/webp',
      metadata: { cacheControl: 'private, max-age=60' },
    });
    written = true;
    success(`書き込めました: ${bucketName}/${objectPath}`);
  } catch (error) {
    problems.push(describeStorageFailure(bucketName, error));
    warn(describeStorageFailure(bucketName, error));
  }

  if (written) {
    step('配信用の署名付き URL を発行する');
    try {
      const [url] = await bucket.file(objectPath).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 10 * 60 * 1000,
      });
      success('発行できました（管理画面と投影画面はこの URL で画像を出します）');
      info(color.dim(`${url.slice(0, 80)}…`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      /*
        手元の gcloud auth application-default login は**利用者の資格情報**で、
        サービスアカウントではない。利用者の資格情報には client_email が無いため、
        署名だけは原理的にできない。手元で出る分には異常ではないので、
        「本番も駄目」と誤解させないよう分けて出す。
      */
      if (/without .?client_email/i.test(message)) {
        warn('手元の資格情報では署名できません（利用者アカウントには署名鍵がありません）。');
        info('これは手元だけの制限です。Cloud Run 上では実行サービスアカウントが署名します。');
        info('本番側を確かめる: npm run deploy:doctor（実行サービスアカウントの権限を見ます）');
        info(
          color.dim(
            '手元で実際に試すなら: gcloud auth application-default login ' +
              '--impersonate-service-account=<実行サービスアカウント>',
          ),
        );
      } else {
        problems.push(
          '署名付き URL を発行できませんでした。実行サービスアカウントに ' +
            '「サービス アカウント トークン作成者」が自分自身に対して要ります。' +
            `画像は保存できますが、画面に出ません: ${message}`,
        );
        warn(`署名に失敗しました: ${message}`);
      }
    }

    step('後片付け');
    try {
      await bucket.file(objectPath).delete();
      success('検査用のオブジェクトを削除しました');
    } catch {
      warn(`検査用のオブジェクトが残りました: ${bucketName}/${objectPath}`);
    }
  }
}

/**
 * 保存に失敗した理由を、直し方が分かる日本語にする（アプリ側と同じ考え方）。
 *
 * 元のメッセージは必ず末尾に残す。当てはめを間違えたときに、
 * 本当の原因まで消してしまわないため。
 */
function describeStorageFailure(bucket, error) {
  const status = typeof error?.code === 'number' ? error.code : null;
  const message = error instanceof Error ? error.message : String(error);
  const detail = ` （元のメッセージ: ${message}）`;

  // 認証を先に見る。認証が通っていないと、実在するバケットも「無い」ように見える。
  if (
    status === 401 ||
    /credential|unauthenticated|could not load the default|metadata|invalid_grant/i.test(message)
  ) {
    return (
      '認証情報を読み込めませんでした。' +
      '手元で試す場合は gcloud auth application-default login を実行してください。' +
      detail
    );
  }
  if (status === 403 || /permission|forbidden|access/i.test(message)) {
    return (
      `保存先のバケット ${bucket} へ書き込む権限がありません。` +
      '実行サービスアカウントに「Storage オブジェクト管理者」を付けてください。' +
      detail
    );
  }
  if (status === 404 || /does not exist|Not Found/i.test(message)) {
    return (
      `保存先のバケット ${bucket} が見つかりません。` +
      'Firebase コンソールで Storage を有効にするか、MEDIA_BUCKET を実在するバケット名に直してください。' +
      detail
    );
  }
  return `${bucket} への書き込みに失敗しました: ${message}`;
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------
console.log('');
if (problems.length === 0) {
  success('画像アップロードは一通り動きます。');
  process.exit(0);
}

warn(`${problems.length} 件の問題が見つかりました。`);
for (const problem of problems) {
  console.log(`    ${color.yellow('・')} ${problem}`);
}
process.exit(1);
