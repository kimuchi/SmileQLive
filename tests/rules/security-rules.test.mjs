/**
 * firebase/firestore.rules の検証。
 *
 * 検証したい不変条件（docs/FIRESTORE_MODEL.md §4）:
 *
 *   1. 参加者へ正解が到達する経路がすべて塞がれている
 *      - rooms/{id}（quizSnapshot に正解が入る）を読めない
 *      - quizzes/** と questions/** を読めない
 *   2. 参加者が読めるのは rooms/{id}/public/state だけ
 *   3. rooms/{id}/staff/progress は司会・投影のみ
 *   4. members / answers は自分の行だけ（司会は全件）
 *   5. 司会者は自分のルーム・クイズだけ。他人のものは読めない
 *   6. **あらゆるロールからの書き込みがすべて拒否される**
 *      （書き込みは Cloud Run の Admin SDK 経由だけ。Rules は最終防壁）
 *
 * 実行: node scripts/test-rules.mjs
 */
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from 'firebase/firestore';
import { IDS, answerDocId } from './harness.mjs';

/** 読み取り（get）を試す。 */
const readDoc =
  (client, ...path) =>
  () =>
    getDoc(doc(client.db, ...path));

/** 一覧取得（list）を試す。 */
const listCollection =
  (client, ...path) =>
  () =>
    getDocs(collection(client.db, ...path));

/**
 * @param {ReturnType<import('./harness.mjs').createReporter>} report
 * @param {Awaited<ReturnType<import('./harness.mjs').setupRulesContext>>} ctx
 */
export default async function run(report, ctx) {
  const { host, otherHost, presenter, participant, otherParticipant, stranger } = ctx.roles;
  const unauthenticated = ctx.roles.anonymousUnauthenticated;

  const myAnswerId = answerDocId(IDS.question, participant.uid);
  const otherAnswerId = answerDocId(IDS.question, otherParticipant.uid);

  // -------------------------------------------------------------------------
  report.section('1. 正解が参加者へ到達しないこと（最重要）');
  // -------------------------------------------------------------------------

  // rooms/{id} は quizSnapshot（正解・解説）を含むため、参加者・投影担当は読めない。
  await report.denied('匿名参加者が rooms/{roomId} を読む（quizSnapshot に正解が入る）', () =>
    readDoc(participant, 'rooms', IDS.room)(),
  );
  await report.denied('投影担当が rooms/{roomId} を読む', () =>
    readDoc(presenter, 'rooms', IDS.room)(),
  );
  await report.denied('ルーム外の匿名利用者が rooms/{roomId} を読む', () =>
    readDoc(stranger, 'rooms', IDS.room)(),
  );
  await report.denied('未認証の利用者が rooms/{roomId} を読む', () =>
    readDoc(unauthenticated, 'rooms', IDS.room)(),
  );
  await report.denied('匿名参加者が rooms を一覧する', () =>
    listCollection(participant, 'rooms')(),
  );

  // quizzes/** は正解・解説そのもの。
  await report.denied('匿名参加者が quizzes/{quizId} を読む', () =>
    readDoc(participant, 'quizzes', IDS.quiz)(),
  );
  await report.denied(
    '匿名参加者が quizzes/{quizId}/questions/{questionId} を読む（正解・解説）',
    () => readDoc(participant, 'quizzes', IDS.quiz, 'questions', IDS.question)(),
  );
  await report.denied('匿名参加者が questions を一覧する', () =>
    listCollection(participant, 'quizzes', IDS.quiz, 'questions')(),
  );
  await report.denied('投影担当が quizzes/{quizId}/questions/{questionId} を読む', () =>
    readDoc(presenter, 'quizzes', IDS.quiz, 'questions', IDS.question)(),
  );
  // 共有: 所有者と共有相手だけが読める。共有しても参加者へは広がらない。
  await report.allowed('共有された司会者が quizzes/{quizId} を読む', () =>
    readDoc(host, 'quizzes', IDS.sharedQuiz)(),
  );
  await report.allowed('共有された司会者が共有クイズの questions を読む', () =>
    readDoc(host, 'quizzes', IDS.sharedQuiz, 'questions', IDS.sharedQuestion)(),
  );
  await report.denied('共有されていない司会者が他人のクイズを読む', () =>
    readDoc(host, 'quizzes', IDS.otherQuiz)(),
  );
  await report.denied('匿名参加者が共有されたクイズを読む', () =>
    readDoc(participant, 'quizzes', IDS.sharedQuiz)(),
  );
  await report.denied('匿名参加者が共有されたクイズの questions を読む', () =>
    readDoc(participant, 'quizzes', IDS.sharedQuiz, 'questions', IDS.sharedQuestion)(),
  );
  await report.denied('投影担当が共有されたクイズを読む', () =>
    readDoc(presenter, 'quizzes', IDS.sharedQuiz)(),
  );
  await report.denied('共有相手でもクイズを書き換える', () =>
    setDoc(doc(host.db, 'quizzes', IDS.sharedQuiz), { title: '書き換え' }, { merge: true }),
  );

  await report.denied(
    '匿名参加者が collectionGroup("questions") で回り込む（横断クエリでも漏れない）',
    () => getDocs(query(collectionGroup(participant.db, 'questions'))),
  );
  await report.denied('匿名参加者が mediaAssets を読む', () =>
    readDoc(participant, 'mediaAssets', IDS.asset)(),
  );

  // -------------------------------------------------------------------------
  report.section('2. 公開状態 rooms/{roomId}/public/state');
  // -------------------------------------------------------------------------

  await report.allowed('匿名参加者が rooms/{roomId}/public/state を読む', () =>
    readDoc(participant, 'rooms', IDS.room, 'public', 'state')(),
  );
  await report.allowed('投影担当が rooms/{roomId}/public/state を読む', () =>
    readDoc(presenter, 'rooms', IDS.room, 'public', 'state')(),
  );
  await report.allowed('司会者が rooms/{roomId}/public/state を読む', () =>
    readDoc(host, 'rooms', IDS.room, 'public', 'state')(),
  );
  await report.denied('ルーム外の匿名利用者が rooms/{roomId}/public/state を読む', () =>
    readDoc(stranger, 'rooms', IDS.room, 'public', 'state')(),
  );
  await report.denied('未認証の利用者が rooms/{roomId}/public/state を読む', () =>
    readDoc(unauthenticated, 'rooms', IDS.room, 'public', 'state')(),
  );

  // 公開状態に正解・問題文・選択肢が入っていないことも確認する
  // （Rules で読めるドキュメントなので、中身そのものが防壁になる）。
  const publicState = await getDoc(doc(participant.db, 'rooms', IDS.room, 'public', 'state'));
  const publicJson = JSON.stringify(publicState.data() ?? {});
  report.check(
    'public/state に正解・解説・選択肢が含まれない',
    !publicJson.includes('isCorrect') &&
      !publicJson.includes('choices') &&
      !publicJson.includes('explanation') &&
      !publicJson.includes('正解'),
    publicJson.slice(0, 120),
  );

  // -------------------------------------------------------------------------
  report.section('3. 進捗 rooms/{roomId}/staff/progress');
  // -------------------------------------------------------------------------

  await report.denied('匿名参加者が rooms/{roomId}/staff/progress を読む', () =>
    readDoc(participant, 'rooms', IDS.room, 'staff', 'progress')(),
  );
  await report.denied('ルーム外の匿名利用者が rooms/{roomId}/staff/progress を読む', () =>
    readDoc(stranger, 'rooms', IDS.room, 'staff', 'progress')(),
  );
  await report.denied('未認証の利用者が rooms/{roomId}/staff/progress を読む', () =>
    readDoc(unauthenticated, 'rooms', IDS.room, 'staff', 'progress')(),
  );
  await report.allowed('投影担当が rooms/{roomId}/staff/progress を読む', () =>
    readDoc(presenter, 'rooms', IDS.room, 'staff', 'progress')(),
  );
  await report.allowed('司会者が rooms/{roomId}/staff/progress を読む', () =>
    readDoc(host, 'rooms', IDS.room, 'staff', 'progress')(),
  );

  // -------------------------------------------------------------------------
  report.section('4. members — 自分の行だけ（司会は全件）');
  // -------------------------------------------------------------------------

  await report.allowed('参加者が自分の members を読む', () =>
    readDoc(participant, 'rooms', IDS.room, 'members', participant.uid)(),
  );
  await report.denied('参加者が他人の members を読む', () =>
    readDoc(participant, 'rooms', IDS.room, 'members', otherParticipant.uid)(),
  );
  await report.denied('参加者が members を一覧する（ニックネーム名簿の抜き取り）', () =>
    listCollection(participant, 'rooms', IDS.room, 'members')(),
  );
  await report.denied('投影担当が他人の members を読む', () =>
    readDoc(presenter, 'rooms', IDS.room, 'members', participant.uid)(),
  );
  await report.allowed('司会者が任意の members を読む', () =>
    readDoc(host, 'rooms', IDS.room, 'members', participant.uid)(),
  );
  await report.allowed('司会者が members を一覧する', () =>
    listCollection(host, 'rooms', IDS.room, 'members')(),
  );

  // -------------------------------------------------------------------------
  report.section('5. answers — 自分の回答だけ（司会は全件）');
  // -------------------------------------------------------------------------

  await report.allowed('参加者が自分の answers を読む', () =>
    readDoc(participant, 'rooms', IDS.room, 'answers', myAnswerId)(),
  );
  await report.denied('参加者が他人の answers を読む（正誤が漏れる）', () =>
    readDoc(participant, 'rooms', IDS.room, 'answers', otherAnswerId)(),
  );
  await report.denied('参加者が answers を無条件に一覧する', () =>
    listCollection(participant, 'rooms', IDS.room, 'answers')(),
  );
  await report.allowed('参加者が participantId == 自分 で answers を絞り込む', () =>
    getDocs(
      query(
        collection(participant.db, 'rooms', IDS.room, 'answers'),
        where('participantId', '==', participant.uid),
      ),
    ),
  );
  await report.denied('参加者が participantId == 他人 で answers を絞り込む', () =>
    getDocs(
      query(
        collection(participant.db, 'rooms', IDS.room, 'answers'),
        where('participantId', '==', otherParticipant.uid),
      ),
    ),
  );
  await report.denied('投影担当が answers を読む', () =>
    readDoc(presenter, 'rooms', IDS.room, 'answers', myAnswerId)(),
  );
  await report.allowed('司会者が answers を一覧する', () =>
    listCollection(host, 'rooms', IDS.room, 'answers')(),
  );

  // -------------------------------------------------------------------------
  report.section('6. events — 監査ログは司会のみ');
  // -------------------------------------------------------------------------

  await report.denied('参加者が events を読む', () =>
    readDoc(participant, 'rooms', IDS.room, 'events', '3')(),
  );
  await report.denied('投影担当が events を読む', () =>
    readDoc(presenter, 'rooms', IDS.room, 'events', '3')(),
  );
  await report.allowed('司会者が events を読む', () =>
    readDoc(host, 'rooms', IDS.room, 'events', '3')(),
  );

  // -------------------------------------------------------------------------
  report.section('7. 司会者は自分のものだけ読める');
  // -------------------------------------------------------------------------

  await report.allowed('司会者が自分の rooms/{roomId} を読む', () =>
    readDoc(host, 'rooms', IDS.room)(),
  );
  await report.allowed('司会者が自分の quizzes/{quizId} を読む', () =>
    readDoc(host, 'quizzes', IDS.quiz)(),
  );
  await report.allowed('司会者が自分の questions を読む', () =>
    readDoc(host, 'quizzes', IDS.quiz, 'questions', IDS.question)(),
  );
  await report.allowed('司会者が自分の mediaAssets を読む', () =>
    readDoc(host, 'mediaAssets', IDS.asset)(),
  );
  await report.allowed('司会者が自分の profiles を読む', () =>
    readDoc(host, 'profiles', host.uid)(),
  );

  await report.denied('別の司会者が他人の rooms/{roomId} を読む', () =>
    readDoc(otherHost, 'rooms', IDS.room)(),
  );
  await report.denied('別の司会者が他人の quizzes/{quizId} を読む', () =>
    readDoc(otherHost, 'quizzes', IDS.quiz)(),
  );
  await report.denied('別の司会者が他人の questions を読む', () =>
    readDoc(otherHost, 'quizzes', IDS.quiz, 'questions', IDS.question)(),
  );
  await report.denied('別の司会者が他人の mediaAssets を読む', () =>
    readDoc(otherHost, 'mediaAssets', IDS.asset)(),
  );
  await report.denied('司会者が別の司会者の rooms を読む', () =>
    readDoc(host, 'rooms', IDS.otherRoom)(),
  );
  await report.denied('司会者が別の司会者の profiles を読む', () =>
    readDoc(host, 'profiles', otherHost.uid)(),
  );
  await report.denied('参加者が profiles を読む', () =>
    readDoc(participant, 'profiles', host.uid)(),
  );

  // -------------------------------------------------------------------------
  report.section('8. presentationLinks — 誰からも読めない（交換は API 経由）');
  // -------------------------------------------------------------------------

  await report.denied('司会者が presentationLinks を読む', () =>
    readDoc(host, 'presentationLinks', IDS.presentationLink)(),
  );
  await report.denied('投影担当が presentationLinks を読む', () =>
    readDoc(presenter, 'presentationLinks', IDS.presentationLink)(),
  );
  await report.denied('参加者が presentationLinks を読む', () =>
    readDoc(participant, 'presentationLinks', IDS.presentationLink)(),
  );

  // -------------------------------------------------------------------------
  report.section('9. 明示していないパスはすべて拒否');
  // -------------------------------------------------------------------------

  await report.denied('司会者が未定義コレクションを読む', () =>
    readDoc(host, 'unknownCollection', 'anything')(),
  );
  await report.denied('参加者が未定義コレクションを読む', () =>
    readDoc(participant, 'unknownCollection', 'anything')(),
  );

  // -------------------------------------------------------------------------
  report.section('10. あらゆるロールからの書き込みがすべて拒否される');
  // -------------------------------------------------------------------------
  // 書き込みは Cloud Run（Admin SDK）経由だけ。Rules 側では 1 件も通さない。
  // ※ 読み取り検証をすべて終えてから実行する（拒否された書き込みのロールバックが
  //    ほかの検証へ影響しないようにするため）。

  const writeTargets = (client) => [
    {
      label: 'rooms/{roomId} を書き換える（フェーズ改ざん）',
      run: () =>
        setDoc(doc(client.db, 'rooms', IDS.room), { phase: 'answer_revealed' }, { merge: true }),
    },
    {
      label: 'rooms を新規作成する',
      run: () => setDoc(doc(client.db, 'rooms', `forged-${client.name}`), { ownerId: client.uid }),
    },
    {
      label: 'public/state を書き換える（進行の乗っ取り）',
      run: () =>
        setDoc(
          doc(client.db, 'rooms', IDS.room, 'public', 'state'),
          { phase: 'answer_revealed' },
          { merge: true },
        ),
    },
    {
      label: 'staff/progress を書き換える',
      run: () =>
        setDoc(
          doc(client.db, 'rooms', IDS.room, 'staff', 'progress'),
          { answeredCount: 999 },
          { merge: true },
        ),
    },
    {
      label: '自分の members を書き換える（得点の詐称）',
      run: () =>
        setDoc(
          doc(client.db, 'rooms', IDS.room, 'members', client.uid ?? 'anonymous'),
          { totalPoints: 999_999 },
          { merge: true },
        ),
    },
    {
      label: '自分の answers を新規作成する（回答の直接書き込み）',
      run: () =>
        setDoc(
          doc(
            client.db,
            'rooms',
            IDS.room,
            'answers',
            answerDocId(IDS.question, client.uid ?? 'anonymous'),
          ),
          {
            participantId: client.uid ?? 'anonymous',
            isCorrect: true,
            pointsAwarded: 999_999,
          },
        ),
    },
    {
      label: '他人の answers を書き換える',
      run: () =>
        setDoc(
          doc(client.db, 'rooms', IDS.room, 'answers', otherAnswerId),
          { isCorrect: false },
          { merge: true },
        ),
    },
    {
      label: 'answers を削除する',
      run: () => deleteDoc(doc(client.db, 'rooms', IDS.room, 'answers', myAnswerId)),
    },
    {
      label: 'events を追記する（監査ログの偽造）',
      run: () => setDoc(doc(client.db, 'rooms', IDS.room, 'events', '4'), { eventType: 'forged' }),
    },
    {
      label: 'quizzes を書き換える',
      run: () => setDoc(doc(client.db, 'quizzes', IDS.quiz), { title: '改ざん' }, { merge: true }),
    },
    {
      label: 'questions を書き換える（正解の付け替え）',
      run: () =>
        setDoc(
          doc(client.db, 'quizzes', IDS.quiz, 'questions', IDS.question),
          { explanation: '改ざん' },
          { merge: true },
        ),
    },
    {
      label: 'profiles を作る（司会者への昇格）',
      run: () => setDoc(doc(client.db, 'profiles', client.uid ?? 'anonymous'), { uid: client.uid }),
    },
    {
      label: 'mediaAssets を作る',
      run: () =>
        setDoc(doc(client.db, 'mediaAssets', `forged-${client.name}`), { ownerId: client.uid }),
    },
    {
      label: 'presentationLinks を作る（投影リンクの偽造）',
      run: () =>
        setDoc(doc(client.db, 'presentationLinks', `forged-${client.name}`), { roomId: IDS.room }),
    },
    {
      label: '未定義コレクションへ書き込む',
      run: () => setDoc(doc(client.db, 'unknownCollection', `forged-${client.name}`), { x: 1 }),
    },
  ];

  const roleLabels = [
    ['未認証', unauthenticated],
    ['匿名参加者', participant],
    ['投影担当', presenter],
    ['司会者（所有者）', host],
    ['別の司会者', otherHost],
  ];

  for (const [roleLabel, client] of roleLabels) {
    for (const target of writeTargets(client)) {
      await report.denied(`${roleLabel} が ${target.label}`, target.run);
    }
  }
}
