#!/usr/bin/env node
/**
 * 動作確認用のデモクイズを作成する。
 *
 *   npm run seed:demo                     … 設定ファイルから対象を判定して作成
 *   npm run seed:demo -- --project my-proj
 *   npm run seed:demo -- --owner you@example.com   … 所有者を指定
 *   npm run seed:demo -- --replace        … 同名のデモクイズを作り直す
 *   npm run seed:demo -- --cleanup-stray  … 誤ってトップレベルへ書かれた問題を削除する
 *
 * 収録する問題（型を一通り網羅する）:
 *   1. 2 択                       … 問題画像 + 解説画像
 *   2. 3 択                       … 文章のみ
 *   3. 4 択                       … 選択肢がすべて画像（代替テキスト必須の例）
 *   4. 数値 / 完全一致            … 単位あり
 *   5. 数値 / 許容誤差            … ±50
 *   6. 数値 / 範囲指定            … 380〜430
 *
 * 画像は第三者素材を使わず、その場で SVG から描き起こす（scripts/lib/demo-images.mjs）。
 *
 * 認証は Admin SDK の ADC。事前に済ませておくこと。
 *   gcloud auth application-default login
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { configExists, ENVIRONMENTS, parseArgs } from './lib/config.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { confirmYesNo, isInteractive } from './lib/prompt.mjs';
import { PALETTE, questionImage, revealImage, shapeChoiceImage } from './lib/demo-images.mjs';
import {
  DEMO_DESCRIPTION,
  DEMO_MEDIA,
  DEMO_TITLE,
  questionsPath,
  toDomainQuestions,
} from './lib/demo-quiz.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { flags } = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 対象の解決（host-admin.mjs と同じ規則）
// ---------------------------------------------------------------------------
function readConfigFile() {
  const available = ENVIRONMENTS.filter(configExists);
  const target =
    (typeof flags.get('env') === 'string' ? flags.get('env') : '') ||
    (available.length === 1 ? available[0] : available.includes('production') ? 'production' : '');
  if (!target) {
    return null;
  }
  const path = new URL(`../deploy/cloud-run.${target}.json`, import.meta.url);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const config = readConfigFile();

const projectId =
  (typeof flags.get('project') === 'string' ? flags.get('project') : '') ||
  process.env.FIREBASE_PROJECT_ID ||
  config?.firebaseProjectId ||
  config?.projectId ||
  '';

const databaseId =
  (typeof flags.get('database') === 'string' ? flags.get('database') : '') ||
  process.env.FIRESTORE_DATABASE_ID ||
  config?.firestoreDatabaseId ||
  'smileq-live';

const bucketName =
  (typeof flags.get('bucket') === 'string' ? flags.get('bucket') : '') ||
  process.env.MEDIA_BUCKET ||
  config?.mediaBucket ||
  '';

if (!projectId) {
  fatal(
    'Firebase プロジェクト ID を特定できません。',
    '--project で指定するか、deploy/cloud-run.<env>.json を用意してください。',
  );
}
if (!bucketName) {
  fatal(
    '画像用バケットを特定できません。',
    '--bucket で指定するか、設定ファイルの mediaBucket を確認してください。',
  );
}

heading('デモクイズを作成');
info(`プロジェクト  : ${projectId}`);
info(`データベース  : ${databaseId}`);
info(`バケット      : ${bucketName}`);

// ---------------------------------------------------------------------------
// Admin SDK
// ---------------------------------------------------------------------------
const { getApps, initializeApp } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const { getStorage } = await import('firebase-admin/storage');

const app = getApps().length > 0 ? getApps()[0] : initializeApp({ projectId, storageBucket: bucketName });
const db = getFirestore(app, databaseId);
const auth = getAuth(app);
const bucket = getStorage(app).bucket(bucketName);

/** 問題のサブコレクション（quizzes/{quizId}/questions）。 */
function questionsRef(id) {
  const [root, docId, sub] = questionsPath(id);
  return db.collection(root).doc(docId).collection(sub);
}

// ---------------------------------------------------------------------------
// 以前のバージョンはトップレベルの `questions` へ書いていた。
// アプリは quizzes/{quizId}/questions を読むため、その分は使われないまま残る。
// 消しても現在の動作には影響しないので、掃除だけを行う入口を用意する。
if (flags.has('cleanup-stray')) {
  heading('誤った場所に残った問題を削除');
  const strays = await db.collection('questions').get();
  if (strays.empty) {
    success('トップレベルの questions は空です。掃除は不要です。');
    process.exit(0);
  }
  info(`トップレベルの questions に ${strays.size} 件あります。`);
  const proceed =
    flags.has('yes') || !isInteractive() ? true : await confirmYesNo('削除しますか？', true);
  if (!proceed) {
    warn('中止しました。');
    process.exit(0);
  }
  for (const doc of strays.docs) {
    await doc.ref.delete();
  }
  success(`${strays.size} 件を削除しました。`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
step('所有者を決定');

/**
 * クイズの所有者。
 *
 * 司会者として登録済みの利用者でなければ、作っても管理画面から見えない
 * （一覧は所有者で絞り込まれる）。profiles から選ぶ。
 */
async function resolveOwnerId() {
  const email = typeof flags.get('owner') === 'string' ? flags.get('owner').trim() : '';
  if (email) {
    const user = await auth.getUserByEmail(email.toLowerCase());
    const profile = await db.collection('profiles').doc(user.uid).get();
    if (!profile.exists) {
      fatal(
        `${email} は司会者として登録されていません。`,
        `先に登録してください:\n  npm run host:add -- ${email} --name "表示名"`,
      );
    }
    return user.uid;
  }

  const snapshot = await db.collection('profiles').limit(5).get();
  if (snapshot.empty) {
    fatal(
      '司会者が 1 人も登録されていません。',
      [
        '先に登録してください:',
        '  npm run host:add -- you@example.com --name "あなたの名前"',
        '',
        `対象データベース: ${databaseId}`,
      ].join('\n'),
    );
  }
  if (snapshot.size > 1) {
    info(`司会者が ${snapshot.size} 名います。--owner で指定できます。`);
  }
  return snapshot.docs[0].id;
}

const ownerId = await resolveOwnerId();
success(`所有者: ${ownerId}`);

// ---------------------------------------------------------------------------
step('既存のデモクイズを確認');

const existing = await db
  .collection('quizzes')
  .where('ownerId', '==', ownerId)
  .where('title', '==', DEMO_TITLE)
  .get();

if (!existing.empty) {
  const replace =
    flags.has('replace') ||
    (isInteractive() ? await confirmYesNo('同名のデモクイズがあります。作り直しますか？', false) : false);

  if (!replace) {
    warn('既存のデモクイズを残します。作り直す場合は --replace を付けてください。');
    info(`  npm run seed:demo -- --replace`);
    process.exit(0);
  }

  for (const doc of existing.docs) {
    // 問題 → 画像 → クイズ の順に消す（参照が残らないようにする）。
    const questions = await questionsRef(doc.id).get();
    for (const question of questions.docs) {
      await question.ref.delete();
    }
    // 以前のバージョンがトップレベルの questions へ書いていた分も片付ける。
    const strays = await db.collection('questions').where('quizId', '==', doc.id).get();
    for (const stray of strays.docs) {
      await stray.ref.delete();
    }
    const assets = await db.collection('mediaAssets').where('ownerId', '==', ownerId).get();
    for (const asset of assets.docs) {
      const objectPath = asset.data().objectPath ?? '';
      if (objectPath.includes(`/${doc.id}/`)) {
        await bucket.file(objectPath).delete({ ignoreNotFound: true });
        await asset.ref.delete();
      }
    }
    await doc.ref.delete();
  }
  success(`既存のデモクイズを削除しました（${existing.size} 件）`);
}

// ---------------------------------------------------------------------------
step('画像を生成してアップロード');

const quizId = randomUUID();

/**
 * 生成した画像を Storage へ置き、mediaAssets を作る。
 * 保存パスはアプリ本体と同じ規則（buildObjectPath）に合わせる。
 */
async function putImage(result, label) {
  const assetId = randomUUID();
  const objectPath = `${ownerId}/${quizId}/${assetId}.webp`;

  await bucket.file(objectPath).save(result.data, {
    resumable: false,
    contentType: 'image/webp',
    metadata: { cacheControl: 'private, max-age=31536000, immutable' },
  });

  const now = Timestamp.now();
  await db.collection('mediaAssets').doc(assetId).set({
    id: assetId,
    ownerId,
    bucket: bucketName,
    objectPath,
    mimeType: 'image/webp',
    byteSize: result.info.size,
    width: result.info.width,
    height: result.info.height,
    createdAt: now,
  });

  info(`  ${label} (${result.info.width}x${result.info.height}, ${Math.round(result.info.size / 1024)} KB)`);
  return assetId;
}

/** DEMO_MEDIA の定義どおりに画像を作る。 */
async function renderMedia(spec) {
  const paletteOf = (name) => PALETTE[name] ?? name;
  if (spec.kind === 'question') {
    return questionImage({
      title: spec.title,
      subtitle: spec.subtitle ?? '',
      from: paletteOf(spec.palette[0]),
      to: paletteOf(spec.palette[1] ?? spec.palette[0]),
      illustration: spec.illustration,
    });
  }
  if (spec.kind === 'reveal') {
    return revealImage({
      answer: spec.answer,
      note: spec.note ?? '',
      color: paletteOf(spec.palette[0]),
    });
  }
  return shapeChoiceImage(spec.shape, paletteOf(spec.palette[0]));
}

/** 画像キー → 実際の asset。DEMO_MEDIA を 1 件ずつ生成・アップロードする。 */
const mediaByKey = new Map();
for (const [key, spec] of Object.entries(DEMO_MEDIA)) {
  const rendered = await renderMedia(spec);
  const assetId = await putImage(rendered, key);
  mediaByKey.set(key, {
    assetId,
    url: '',
    width: rendered.info.width,
    height: rendered.info.height,
  });
}

// ---------------------------------------------------------------------------
step('クイズと問題を作成');

// 公開検証と同じ定義から問題を組み立てる（tests/unit/scripts/demo-quiz.test.ts が検証済み）。
const domainQuestions = toDomainQuestions((key) => {
  const asset = mediaByKey.get(key);
  if (!asset) {
    fatal(`画像キーが見つかりません: ${key}`);
  }
  return asset;
});

/** ドメインの Question を Firestore ドキュメント形へ落とす。 */
function toQuestionDoc(question) {
  const now = Timestamp.now();
  const isChoice = question.type === 'choice';
  const rule = isChoice ? null : question.numberRule;

  return {
    id: randomUUID(),
    quizId,
    ownerId,
    position: question.position,
    questionType: question.type,
    questionText: question.text,
    questionImageAssetId: question.image?.assetId ?? null,
    questionImageAlt: question.image?.alt ?? null,
    revealImageAssetId: question.revealImage?.assetId ?? null,
    revealImageAlt: question.revealImage?.alt ?? null,
    explanation: question.explanation,
    timeLimitSeconds: question.timeLimitSeconds,
    points: question.points,
    choices: isChoice
      ? question.choices.map((choice) => ({
          id: randomUUID(),
          position: choice.position,
          text: choice.text,
          imageAssetId: choice.image?.assetId ?? null,
          imageAlt: choice.image?.alt ?? null,
          isCorrect: choice.isCorrect,
        }))
      : [],
    numberMode: rule?.mode ?? null,
    numberCorrectValue: rule && 'correctValue' in rule ? rule.correctValue : null,
    numberTolerance: rule && 'tolerance' in rule ? rule.tolerance : null,
    numberMinValue: rule && 'minValue' in rule ? rule.minValue : null,
    numberMaxValue: rule && 'maxValue' in rule ? rule.maxValue : null,
    numberUnit: isChoice ? null : question.unit,
    numberDecimalPlaces: isChoice ? 0 : question.decimalPlaces,
    createdAt: now,
    updatedAt: now,
  };
}

const questions = domainQuestions.map(toQuestionDoc);

const now = Timestamp.now();
const batch = db.batch();

batch.set(db.collection('quizzes').doc(quizId), {
  id: quizId,
  ownerId,
  title: DEMO_TITLE,
  description: DEMO_DESCRIPTION,
  status: 'published',
  showLeaderboard: true,
  soundTheme: 'default',
  questionCount: questions.length,
  choiceQuestionCount: questions.filter((q) => q.questionType === 'choice').length,
  numberQuestionCount: questions.filter((q) => q.questionType === 'number').length,
  createdAt: now,
  updatedAt: now,
});

for (const question of questions) {
  batch.set(questionsRef(quizId).doc(question.id), question);
}

await batch.commit();
success(`${questions.length} 問のクイズを作成しました（公開済み）`);

// ---------------------------------------------------------------------------
step('書き込んだ内容を読み直して点検');

/**
 * ルーム作成時に効くのは「Firestore に何が入っているか」だけ。
 * 書いたつもりの値ではなく、実際に読める値を確かめる。
 *
 * ルーム作成は公開検証をやり直すため、ここが欠けていると
 * 「公開条件を満たしていません」で止まる。
 *   * 問題が読めるか（quizId で引けるか）
 *   * 画像の mediaAssets が引けるか（引けないと画像は無いものとして扱われる）
 *   * 文章を持たない選択肢に画像と代替テキストがあるか
 */
async function inspect() {
  const problems = [];

  // アプリと同じ場所（quizzes/{quizId}/questions）から読む。
  // ここを別の場所にすると、点検が自分の書き間違いを追認してしまう。
  const storedQuestions = await questionsRef(quizId).get();
  if (storedQuestions.size !== questions.length) {
    problems.push(`問題が ${storedQuestions.size} 件しか読めません（期待 ${questions.length} 件）`);
  }

  // 参照している画像 ID をすべて集めて、実在するか確かめる。
  const referenced = new Set();
  for (const doc of storedQuestions.docs) {
    const data = doc.data();
    for (const id of [data.questionImageAssetId, data.revealImageAssetId]) {
      if (id) referenced.add(id);
    }
    for (const choice of data.choices ?? []) {
      if (choice.imageAssetId) referenced.add(choice.imageAssetId);
    }
  }

  const assetIds = [...referenced];
  const assetDocs =
    assetIds.length > 0
      ? await db.getAll(...assetIds.map((id) => db.collection('mediaAssets').doc(id)))
      : [];
  const foundAssets = new Set(
    assetDocs
      .filter((doc) => {
        const data = doc.data();
        // getAssetRefs と同じ条件（id / bucket / objectPath が揃っていること）。
        return data && data.id && data.bucket && data.objectPath;
      })
      .map((doc) => doc.id),
  );

  for (const id of assetIds) {
    if (!foundAssets.has(id)) {
      problems.push(`画像 ${id} の mediaAssets が読めません`);
    }
  }

  // 文章を持たない選択肢は、画像と代替テキストの両方が必要。
  for (const doc of storedQuestions.docs) {
    const data = doc.data();
    for (const choice of data.choices ?? []) {
      const hasText = typeof choice.text === 'string' && choice.text.trim().length > 0;
      if (hasText) continue;
      if (!choice.imageAssetId || !foundAssets.has(choice.imageAssetId)) {
        problems.push(`第${data.position}問の選択肢に文章も画像もありません`);
      } else if (!choice.imageAlt || String(choice.imageAlt).trim().length === 0) {
        problems.push(`第${data.position}問の画像だけの選択肢に代替テキストがありません`);
      }
    }
  }

  return { problems, questionCount: storedQuestions.size, assetCount: foundAssets.size };
}

const inspection = await inspect();
if (inspection.problems.length === 0) {
  success(`問題 ${inspection.questionCount} 件 / 画像 ${inspection.assetCount} 件を読み直せました`);
} else {
  warn('読み直しで問題が見つかりました。このままではルームを作成できません。');
  for (const problem of inspection.problems) {
    console.log(`    ${problem}`);
  }
  console.log('');
  info(`データベース: ${databaseId} / バケット: ${bucketName}`);
  info('設定ファイルの firestoreDatabaseId・mediaBucket がアプリ側と一致しているか確認してください。');
  console.log('');
}

// ---------------------------------------------------------------------------
heading('作成した内容');
for (const question of questions) {
  const kind =
    question.questionType === 'choice'
      ? `${question.choices.length} 択`
      : `数値 / ${{ exact: '完全一致', absolute_tolerance: '許容誤差', range: '範囲指定' }[question.numberMode]}`;
  console.log(
    `  ${String(question.position).padStart(2)}. ${color.bold(kind.padEnd(14))} ${question.questionText ?? ''}`,
  );
}

console.log('');
info('次の手順:');
console.log('  1. 管理画面でルームを作成する');
console.log(`       ${config?.appBaseUrl ?? ''}/admin/quizzes`);
console.log('  2. 投影画面を開く（効果音はこの画面だけで鳴ります）');
console.log('  3. 二次元コードを読んで参加者として入る');
console.log('');
info('効果音がまだプレースホルダの場合: npm run sounds:install');
console.log('');
