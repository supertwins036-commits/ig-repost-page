// 記録の保存先: 記録専用の非公開リポジトリ ig-repost-data の state.json（2026-10-12 決定）。
// コードのある CheckInstagram と分け、鍵が漏れてもページのコードは書き換えられないようにしている（compliance M1）。
// GitHub の REST API（contents）で読み書きする。鍵（fine-grained token）は、このリポジトリの
// Contents の読み書きだけに絞って本人が作り、この端末の localStorage にだけ置く。
//
// 記録に入れるのは投稿のID・URL・投稿者名・入力した開催地と日付・状態だけ。エクスポートの zip や
// フォロワーの一覧は入れない（個人データを GitHub に置く範囲を最小にするため）。

export const OWNER = "supertwins036-commits";
export const REPO = "ig-repost-data";
export const PATH = "state.json";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
const TOKEN_KEY = "ig_repost_token";
const EXPIRES_KEY = "ig_repost_token_expires";

export function emptyState() {
  return { version: 1, updated: "", last_import: null, posts: {} };
}

// ---- 鍵 ------------------------------------------------------------------------
// localStorage はプライベートブラウズなどで使えないことがあるので、失敗しても落とさない。
export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token, expires = "") {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    if (token && expires) localStorage.setItem(EXPIRES_KEY, expires);
    else localStorage.removeItem(EXPIRES_KEY);
    return true;
  } catch {
    return false;
  }
}

// 鍵の有効期限（YYYY-MM-DD）。GitHub は期限のヘッダーをブラウザに見せない（CORS で公開されていない）ので、
// 鍵を作ったときに画面に出る期限を本人に入力してもらって覚えておく（レビュー H1）。
export function getTokenExpiry() {
  try {
    return localStorage.getItem(EXPIRES_KEY) || "";
  } catch {
    return "";
  }
}

// ---- UTF-8 と base64（contents API は base64 でやり取りする） ------------------------
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class StoreError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function explain(status, res) {
  if (status === 401) return "鍵（トークン）が無効か、期限が切れています。S3・S4 の手順で作り直してください。";
  // 回数制限でも 403 が返る（x-ratelimit-remaining は CORS で読める。レビュー L7）
  if (status === 403 && res?.headers.get("x-ratelimit-remaining") === "0") {
    return "GitHub の利用回数の上限に達しました。1時間ほど待ってからもう一度試してください。";
  }
  if (status === 403) return "鍵（トークン）に書き込みの権限がありません。Contents を「Read and write」にしてください。";
  if (status === 404) return "記録のリポジトリが見つかりません。鍵の対象に ig-repost-data を選んだか確認してください。";
  return `GitHub との通信に失敗しました（${status || "接続できません"}）。電波の良いところでもう一度試してください。`;
}

async function request(method, body) {
  const token = getToken();
  if (!token) throw new StoreError("鍵（トークン）が登録されていません。「設定」から登録してください。");
  let res;
  try {
    res = await fetch(method === "GET" ? `${API}?t=${Date.now()}` : API, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new StoreError(explain(0));
  }
  return res;
}

// 記録の中身が壊れていないか（壊れていたら空の記録で上書きしない。レビュー L6）
function parseState(json) {
  if (json.encoding === "none" || typeof json.content !== "string") {
    throw new StoreError("記録のファイルが大きすぎて読めません（1MB超）。開発者に連絡してください（自動では上書きしません）。");
  }
  let data;
  try {
    data = JSON.parse(fromBase64(json.content));
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.posts !== "object" || data.posts === null || Array.isArray(data.posts)) {
    throw new StoreError("記録のファイル（ig-repost-data の state.json）が壊れています。自動では上書きしません。開発者に連絡してください。");
  }
  return { ...emptyState(), ...data };
}

// 最後に保存した記録とその sha。保存の直後は GitHub が古い sha を返すことがあるので、
// 次の保存ではまずこれを使う（レビュー M4）。
let cache = null;

// 記録を読む。まだファイルが無ければ空の記録を返す（初回）。
export async function load() {
  const res = await request("GET");
  if (res.status === 404) {
    // ファイルが無いのか、リポジトリが見えないのかを区別する
    const probe = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
      headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/vnd.github+json" },
      cache: "no-store",
    }).catch(() => null);
    if (probe && probe.ok) {
      cache = { state: emptyState(), sha: null };
      return { state: emptyState() };
    }
    throw new StoreError(explain(404), 404);
  }
  if (!res.ok) throw new StoreError(explain(res.status, res), res.status);
  const json = await res.json();
  const state = parseState(json);
  cache = { state: structuredClone(state), sha: json.sha };
  return { state };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const RETRY_WAITS_MS = [0, 500, 1500]; // テストでは短くできるよう公開する

// 記録を更新する。mutate(state) で記録を書き換え、コミットとして保存する。
// 別の端末が先に保存して競合したら（409/422）、少し待って最新を読み直し、同じ操作をやり直す。
export async function update(mutate, message) {
  for (let attempt = 0; attempt < RETRY_WAITS_MS.length; attempt++) {
    if (RETRY_WAITS_MS[attempt]) await sleep(RETRY_WAITS_MS[attempt]);
    if (attempt > 0 || !cache) await load();
    const state = structuredClone(cache.state);
    mutate(state);
    state.updated = new Date().toISOString();
    const res = await request("PUT", {
      message: `記録: ${message}`,
      content: toBase64(JSON.stringify(state, null, 1) + "\n"),
      ...(cache.sha ? { sha: cache.sha } : {}),
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      cache = { state: structuredClone(state), sha: json.content?.sha ?? null };
      if (!cache.sha) cache = null; // sha が分からなければ次回は読み直す
      return state;
    }
    if (res.status !== 409 && res.status !== 422) throw new StoreError(explain(res.status, res), res.status);
  }
  throw new StoreError("ほかの端末での保存と重なりました。少し待ってからもう一度押してください。");
}

// テスト用: 手元の控えを捨てる
export function resetCache() {
  cache = null;
}
