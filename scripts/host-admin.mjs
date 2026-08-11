#!/usr/bin/env node
/**
 * 司会者（管理画面を使える利用者）の登録・確認・削除。
 *
 *   npm run host:list
 *   npm run host:add -- user@example.com --name "山田太郎"
 *   npm run host:remove -- user@example.com
 *
 * 背景（docs/HOST_ACCESS.md）:
 *   ログイン可能なメールドメインを制限しない方針のため、
 *   司会者権限を守るのは profiles/{uid} の存在だけ。
 *   アプリ側は profiles を自動作成しないので、追加は必ずこのスクリプト
 *   （または Firebase コンソール）からの明示操作になる。
 *
 * 認証:
 *   Firebase Admin SDK の ADC を使う。事前に次のいずれかを済ませておくこと。
 *     gcloud auth application-default login
 *     または GOOGLE_APPLICATION_CREDENTIALS にサービスアカウント鍵のパスを設定
 *   エミュレータへ向ける場合は FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST を設定。
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { configExists, ENVIRONMENTS, parseArgs } from './lib/config.mjs';
import { color, fatal, heading, info, step, success, warn } from './lib/log.mjs';
import { confirmYesNo, isInteractive } from './lib/prompt.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0] ?? 'list';

// ---------------------------------------------------------------------------
// プロジェクト ID の解決
// ---------------------------------------------------------------------------
function resolveProjectId() {
  const explicit =
    (typeof flags.get('project') === 'string' ? flags.get('project') : '') ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;
  if (explicit) {
    return explicit;
  }

  // デプロイ設定から拾う（staging より production を優先しない。1つだけならそれ）
  const available = ENVIRONMENTS.filter(configExists);
  const target =
    (typeof flags.get('env') === 'string' ? flags.get('env') : '') ||
    (available.length === 1 ? available[0] : '');

  if (target) {
    const path = new URL(`../deploy/cloud-run.${target}.json`, import.meta.url);
    if (existsSync(path)) {
      const config = JSON.parse(readFileSync(path, 'utf8'));
      const id = config.firebaseProjectId ?? config.projectId;
      if (id) {
        return id;
      }
    }
  }

  fatal(
    'Firebase プロジェクト ID を特定できません。',
    [
      '次のいずれかを指定してください:',
      '  npm run host:list -- --project my-project-id',
      '  npm run host:list -- --env production',
      '  FIREBASE_PROJECT_ID=my-project-id npm run host:list',
    ].join('\n'),
  );
  return '';
}

const projectId = resolveProjectId();

// ---------------------------------------------------------------------------
// Admin SDK
// ---------------------------------------------------------------------------
let admin;
try {
  const appModule = await import('firebase-admin/app');
  const authModule = await import('firebase-admin/auth');
  const firestoreModule = await import('firebase-admin/firestore');

  const app =
    appModule.getApps().length > 0
      ? appModule.getApps()[0]
      : appModule.initializeApp({ projectId });

  admin = {
    auth: authModule.getAuth(app),
    db: firestoreModule.getFirestore(app),
    Timestamp: firestoreModule.Timestamp,
  };
} catch (error) {
  fatal(
    'Firebase Admin SDK を初期化できませんでした。',
    [
      String(error?.message ?? error),
      '',
      '認証情報を用意してください:',
      '  gcloud auth application-default login',
      'または GOOGLE_APPLICATION_CREDENTIALS にサービスアカウント鍵のパスを設定します。',
    ].join('\n'),
  );
}

const PROFILES = 'profiles';

function normalizeEmail(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
async function listHosts() {
  heading(`司会者一覧 — ${projectId}`);

  const snapshot = await admin.db.collection(PROFILES).get();
  if (snapshot.empty) {
    warn('司会者が 1 人も登録されていません。');
    info('登録するには: npm run host:add -- user@example.com --name "表示名"');
    return;
  }

  console.log('');
  console.log(`  ${'メールアドレス'.padEnd(34)} ${'表示名'.padEnd(18)} 登録日時`);
  console.log(`  ${'-'.repeat(34)} ${'-'.repeat(18)} ${'-'.repeat(20)}`);

  const rows = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    let email = data.email ?? '';
    let disabled = false;
    try {
      const user = await admin.auth.getUser(doc.id);
      email = user.email ?? email;
      disabled = user.disabled;
    } catch {
      // Auth 側が削除済み。profiles だけ残っている状態。
      email = email || '(Auth ユーザーが存在しません)';
    }
    rows.push({
      email,
      displayName: data.displayName ?? '',
      createdAt: data.createdAt?.toDate?.()?.toISOString?.().slice(0, 19).replace('T', ' ') ?? '',
      disabled,
      uid: doc.id,
    });
  }

  rows.sort((a, b) => a.email.localeCompare(b.email));
  for (const row of rows) {
    const mark = row.disabled ? color.yellow(' [無効]') : '';
    console.log(
      `  ${row.email.padEnd(34)} ${String(row.displayName).padEnd(18)} ${row.createdAt}${mark}`,
    );
  }

  console.log('');
  info(`${rows.length} 名`);
  console.log('');
  info('この一覧に載っている利用者だけが管理画面を使えます（docs/HOST_ACCESS.md）。');
}

/**
 * Firebase Authentication が初期化されていない状態か。
 *
 * API を有効化しただけでは Auth は使えず、プロジェクトごとの初期化が要る。
 * その状態で Admin SDK を呼ぶと、原因の見当がつかない次の文言が返る。
 *   There is no configuration corresponding to the provided identifier.
 */
function isAuthNotConfigured(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`;
  return (
    /no configuration corresponding to the provided identifier/i.test(text) ||
    /CONFIGURATION_NOT_FOUND/i.test(text)
  );
}

function fatalAuthNotConfigured() {
  fatal(
    `${projectId} で Firebase Authentication が有効になっていません。`,
    [
      'API の有効化とは別に、プロジェクトごとの初期化が必要です。',
      '',
      '次を実行してください:',
      `  npm run firebase:auth -- --project ${projectId}`,
      '',
      '（Google ログインの有効化だけはコンソールでの操作が必要です。',
      '  上のコマンドが該当の URL を表示します）',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------
async function addHost() {
  const email = normalizeEmail(positional[1]);
  if (!email || !email.includes('@')) {
    fatal(
      'メールアドレスを指定してください。',
      '例: npm run host:add -- user@example.com --name "山田太郎"',
    );
  }

  heading(`司会者を追加 — ${email}`);

  step('Firebase Auth のユーザーを検索');
  let user = null;
  try {
    user = await admin.auth.getUserByEmail(email);
    success(`見つかりました (uid: ${user.uid})`);
  } catch (error) {
    if (isAuthNotConfigured(error)) {
      fatalAuthNotConfigured();
    }
    if (error?.code !== 'auth/user-not-found') {
      fatal(`Auth ユーザーの検索に失敗しました: ${error?.message ?? error}`);
    }
  }

  if (!user) {
    warn('このメールアドレスの Firebase Auth ユーザーがまだ存在しません。');
    console.log('');
    info('司会者ログインは Google アカウント（Firebase Auth の Google プロバイダ）で行います。');
    info('Auth ユーザーは「本人が一度ログインした時点」で作られます。');
    console.log('');
    console.log(`  1. 本人に ${color.bold('https://q.iefainavi.net/admin/login')} で一度ログインしてもらう`);
    console.log('     （この時点では「管理権限がありません」と表示されます。それで正常です）');
    console.log('  2. そのあと、もう一度このコマンドを実行する');
    console.log('');
    process.exit(1);
  }

  step('profiles の状態を確認');
  const profileRef = admin.db.collection(PROFILES).doc(user.uid);
  const existing = await profileRef.get();
  if (existing.exists) {
    success('すでに司会者として登録されています。変更はありません。');
    return;
  }

  const displayName =
    (typeof flags.get('name') === 'string' ? flags.get('name') : '') ||
    user.displayName ||
    email.split('@')[0];

  if (isInteractive() && !flags.has('yes')) {
    console.log('');
    console.log(`  メールアドレス : ${user.email}`);
    console.log(`  表示名         : ${displayName}`);
    console.log(`  uid            : ${user.uid}`);
    console.log('');
    const ok = await confirmYesNo('この利用者へ管理画面へのアクセスを許可しますか？', false);
    if (!ok) {
      fatal('中止しました。');
    }
  }

  step('profiles を作成');
  const now = admin.Timestamp.now();
  await profileRef.create({
    uid: user.uid,
    email: user.email ?? email,
    displayName,
    hostedDomain: (user.email ?? email).split('@')[1] ?? null,
    createdAt: now,
    updatedAt: now,
    // 監査のため、誰がこの操作を行ったかを残す。
    grantedBy: process.env.USER ?? process.env.USERNAME ?? 'unknown',
    grantedVia: 'scripts/host-admin.mjs',
  });

  success(`${email} を司会者として登録しました。`);
  console.log('');
  info('本人は https://q.iefainavi.net/admin/login からログインできます。');
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------
async function removeHost() {
  const email = normalizeEmail(positional[1]);
  if (!email || !email.includes('@')) {
    fatal('メールアドレスを指定してください。', '例: npm run host:remove -- user@example.com');
  }

  heading(`司会者を削除 — ${email}`);

  let uid = typeof flags.get('uid') === 'string' ? flags.get('uid') : '';
  if (!uid) {
    try {
      const user = await admin.auth.getUserByEmail(email);
      uid = user.uid;
    } catch {
      // Auth 側が消えていても profiles が残っている可能性があるので email で探す。
      const found = await admin.db.collection(PROFILES).where('email', '==', email).limit(1).get();
      if (found.empty) {
        fatal(`該当する司会者が見つかりません: ${email}`);
      }
      uid = found.docs[0].id;
    }
  }

  const profileRef = admin.db.collection(PROFILES).doc(uid);
  if (!(await profileRef.get()).exists) {
    warn('この利用者は司会者として登録されていません。変更はありません。');
    return;
  }

  if (isInteractive() && !flags.has('yes')) {
    const ok = await confirmYesNo(`${email} の管理画面へのアクセスを取り消しますか？`, false);
    if (!ok) {
      fatal('中止しました。');
    }
  }

  await profileRef.delete();
  success(`${email} の管理権限を取り消しました。`);
  console.log('');
  info('作成済みのクイズ・ルームは残ります（所有者IDはそのままです）。');
  info('Firebase Auth のユーザー自体を無効化する場合は Firebase コンソールから行ってください。');
}

// ---------------------------------------------------------------------------
switch (command) {
  case 'list':
    await listHosts();
    break;
  case 'add':
    await addHost();
    break;
  case 'remove':
  case 'delete':
    await removeHost();
    break;
  default:
    fatal(
      `不明なコマンド: ${command}`,
      [
        '使い方:',
        '  npm run host:list',
        '  npm run host:add -- user@example.com --name "山田太郎"',
        '  npm run host:remove -- user@example.com',
      ].join('\n'),
    );
}
