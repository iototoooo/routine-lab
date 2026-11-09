// DB の関数が返すエラーコード（20261107000200_phase1_rpc.sql の先頭の一覧）を日本語にする。
// 知らないエラーは中身を出さずに一般的な文にする（内部の情報を画面に出さない）。

const MESSAGES: Record<string, string> = {
  not_authenticated: "ログインし直してください。",
  not_found: "見つかりませんでした。削除されたか、別のアカウントのデータです。",
  invalid_input: "入力内容を確認してください。",
  routine_limit: "ルーティンは50件まで登録できます。使っていないものをアーカイブしてください。",
  routine_archived: "アーカイブしたルーティンは編集できません。",
  no_change: "変更された項目がありません。",
  invalid_valid_from: "適用開始日は、今日以降かつ今の設定の開始日以降にしてください。",
  occurrence_closed: "この予定はすでに記録済みです。",
  deadline_passed: "記録の期限（予定日の翌日の終わり）を過ぎています。",
  invalid_start: "開始時刻は、予定日の0:00から今までの間にしてください。",
  invalid_remind_at: "再通知の時刻は、今より後で、予定日の翌日の終わりより前にしてください。",
  reason_required: "見送りの理由を選んでください。",
  // Phase 4：改善提案（20261110000000_phase4_suggestions.sql）
  stale_suggestion: "この提案のもとにした設定が変わっています。提案の一覧を開き直してください。",
  recently_decided: "この提案はすでに判断済みです（同じルーティン・同じ提案は、判断から28日間は出しません）。",
  routine_excluded: "テスト用のルーティンには改善提案を出しません。",
};

export function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    const m = /^[a-z_]+$/.exec(error.message.trim());
    return m ? m[0] : null;
  }
  return null;
}

export function errorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (error && typeof error === "object" && "message" in error && /fetch|network/i.test(String(error.message))) {
    return "通信できませんでした。電波の状態を確認して、もう一度試してください。";
  }
  return "うまく保存できませんでした。時間をおいてもう一度試してください。";
}

/** supabase-js の { data, error } を、エラーなら例外にして data を返す */
export function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}
