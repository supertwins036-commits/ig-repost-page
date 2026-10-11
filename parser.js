// Instagram「情報をエクスポート」(JSON形式) の解析。ig_repost/export_parser.py の移植。
//
// Python 版を仕様の基準とし（2026-10-12 決定）、同じテストデータで同じ結果になることを
// tests/test_crosscheck.py（→ web/test/crosscheck.mjs）が確かめる。Python 版を直したら、
// ここも同じように直してから照合テストを通すこと。
//
// ブラウザでも Node でも動くように、zip の展開はここでは行わない（app.js が JSZip で展開して
// { name, data } の配列を渡す）。name はファイル名（パスを除いたもの）、data は JSON.parse 済みの値。

// 対象ファイル名 -> 取得元の種別
export const SOURCE_FILES = {
  "saved_posts.json": "saved",
  "liked_posts.json": "liked",
  "saved_collections.json": "collection",
};

// 候補にする保存コレクション（2026-10-12 本人の決定。イベント告知だけを入れる）
export const TARGET_COLLECTION = "問い合わせ";

// Python の \w（Unicode の文字・数字と _）に合わせる。結合文字(\p{M})は Python の \w に含まれない
const W = "[\\p{L}\\p{N}_]";
const POST_URL_RE = new RegExp(`https?://(?:www\\.)?instagram\\.com/(?:(?:${W}|\\.)+/)?(p|reel|reels|tv)/((?:${W}|-)+)`, "u");
const AUTHOR_IN_URL_RE = new RegExp(`instagram\\.com/((?:${W}|\\.)+)/(?:p|reel|reels|tv)/`, "u");
const PROFILE_URL_RE = new RegExp(`instagram\\.com/(?:_u/)?((?:${W}|\\.)+)/?(?:\\?|$)`, "u");
const FOLLOWERS_RE = /^followers(?:_\d+)?\.json$/;
const FOLLOWING_RE = /^following\.json$/;
const USERNAME_KEYS = ["Username", "Owner", "ユーザーネーム", "所有者"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
// Python の真偽値の判定（空文字・空の dict/list・0・None は偽）
const truthy = (v) =>
  Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : Boolean(v);

const utf8 = new TextDecoder("utf-8", { fatal: true });

// 配列の後ろに足す。push(...src) は件数が多い（数万件）と RangeError になるので使わない（レビュー M1）
function append(dest, src) {
  for (const x of src) dest.push(x);
}

// エクスポートの JSON は UTF-8 を latin-1 として二重エンコードしていることがある。
// latin-1 として表せない文字があるか、UTF-8 として読めなければ元のまま返す（Python 版と同じ）。
export function fixMojibake(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xff) return text;
    bytes[i] = c;
  }
  try {
    return utf8.decode(bytes);
  } catch {
    return text;
  }
}

// 投稿URLを正規化して { url, code, kind } を返す。投稿URLでなければ null。
export function normalizeUrl(href) {
  const m = POST_URL_RE.exec(href);
  if (!m) return null;
  const kind = m[1] === "p" ? "post" : "reel";
  const path = kind === "post" ? "p" : "reel";
  return { url: `https://www.instagram.com/${path}/${m[2]}/`, code: m[2], kind };
}

// saved_collections.json のコレクション見出し要素ならコレクション名を返す（なければ null）。
// 例: {"title": "Collection", "string_map_data": {"Name": {"value": "問い合わせ"}, ...}}
function collectionHeader(node) {
  if (!isObj(node)) return null;
  const smd = node.string_map_data;
  if (!isObj(smd)) return null;
  const name = truthy(smd.Name) ? smd.Name : smd["名前"];
  if (isObj(name) && isStr(name.value) && !truthy(name.href)) return fixMojibake(name.value);
  return null;
}

// JSON を再帰的に走査し、[投稿エントリ, 部分木内のユーザー名, 部分木内の timestamp] を返す。
// 欠けている timestamp・投稿者名は、同じレコード内（最も近い親の dict）の値で補う。
// リスト内で投稿URLを含む要素は独立したレコードとみなし、その属性は上へ伝えない。
function collect(node) {
  if (Array.isArray(node)) {
    const entries = [];
    const usernames = [];
    const timestamps = [];
    let collection = "";
    for (const item of node) {
      const header = collectionHeader(item);
      if (header !== null) {
        collection = header;
        continue;
      }
      const [childEntries, childUsers, childTs] = collect(item);
      if (!childEntries.length) {
        // 投稿URLを含まない要素は同じレコードの属性（例: label_values の Owner）
        append(usernames, childUsers);
        append(timestamps, childTs);
      }
      for (const e of childEntries) if (collection && !e.collection) e.collection = collection;
      append(entries, childEntries);
    }
    return [entries, usernames, timestamps];
  }
  if (!isObj(node)) return [[], [], []];

  const entries = [];
  const usernames = [];
  const timestamps = [];
  const rawTs = node.timestamp;
  const ownTs = typeof rawTs === "number" && rawTs > 0 ? Math.trunc(rawTs) : 0;

  // 新形式: {"label": "Username", "value": "xxx"}
  if (USERNAME_KEYS.includes(node.label) && isStr(node.value)) usernames.push(fixMojibake(node.value));
  // string_map_data 形式: {"Username": {"value": "xxx"}}
  for (const key of USERNAME_KEYS) {
    const v = node[key];
    if (isObj(v) && isStr(v.value)) usernames.push(fixMojibake(v.value));
  }

  if (isStr(node.href) && POST_URL_RE.test(node.href)) {
    entries.push({ href: node.href, timestamp: ownTs, author: "", collection: "" });
  }

  // 注意: Object.entries は "1" のような整数風のキーを先に並べる（Python の dict は書かれた順）。
  // 今のエクスポートにはそういうキーが無いので、投稿者の補い方に差は出ない（レビュー L5）
  for (const [key, value] of Object.entries(node)) {
    if (key === "href" || key === "timestamp" || key === "title") continue;
    const [e, u, t] = collect(value);
    append(entries, e);
    append(usernames, u);
    append(timestamps, t);
  }
  if (ownTs) timestamps.push(ownTs);

  const title = node.title;
  const author = isStr(title) && title ? fixMojibake(title) : usernames.length ? usernames[0] : "";
  const fillTs = ownTs || timestamps.reduce((m, t) => (t > m ? t : m), 0);
  for (const e of entries) {
    if (!e.timestamp) e.timestamp = fillTs;
    if (!e.author) e.author = author;
  }
  return [entries, usernames, timestamps];
}

// 保存・いいね・コレクションの投稿を、投稿URL単位で重複をまとめて返す（新しい順）。
// 候補: { url, code, kind, author, sources: [...], collections: [...], timestamp }
export function parseExport(files) {
  const byCode = new Map();
  let foundAny = false;
  for (const { name, data } of files) {
    const source = SOURCE_FILES[name];
    if (!source) continue;
    foundAny = true;
    const [entries] = collect(data);
    for (const entry of entries) {
      const norm = normalizeUrl(entry.href);
      if (!norm) continue;
      let author = entry.author;
      // URL にユーザー名が含まれる形式 (instagram.com/<user>/p/<code>) から補う
      if (!author) {
        const m = AUTHOR_IN_URL_RE.exec(entry.href);
        if (m) author = m[1];
      }
      let c = byCode.get(norm.code);
      if (!c) {
        c = { url: norm.url, code: norm.code, kind: norm.kind, author, sources: new Set(), collections: new Set(), timestamp: 0 };
        byCode.set(norm.code, c);
      } else if (!c.author && author) {
        c.author = author;
      }
      c.sources.add(source);
      if (entry.collection) c.collections.add(entry.collection);
      c.timestamp = Math.max(c.timestamp, entry.timestamp);
    }
  }
  if (!foundAny) {
    throw new Error(
      "saved_posts.json / saved_collections.json が見つかりません。エクスポートの形式を『JSON』にしたか確認してください。",
    );
  }
  return [...byCode.values()]
    .map((c) => ({ ...c, sources: [...c.sources].sort(), collections: [...c.collections].sort() }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

// ---- フォロー関係 -------------------------------------------------------------
// connections/followers_and_following/ 以下。フォロワーは followers_1.json, followers_2.json ... に分割される。

function usernamesOf(node) {
  const names = new Set();
  if (Array.isArray(node)) {
    for (const item of node) for (const n of usernamesOf(item)) names.add(n);
  } else if (isObj(node)) {
    const sld = node.string_list_data;
    if (Array.isArray(sld)) {
      let found = "";
      for (const d of sld) {
        if (!isObj(d)) continue;
        if (isStr(d.value) && d.value) {
          found = d.value;
        } else if (isStr(d.href)) {
          const m = PROFILE_URL_RE.exec(d.href);
          if (m) found = m[1];
        }
      }
      if (!found && isStr(node.title)) found = node.title;
      if (found) names.add(fixMojibake(found).toLowerCase());
    } else {
      for (const v of Object.values(node)) for (const n of usernamesOf(v)) names.add(n);
    }
  }
  return names;
}

export function parseConnections(files) {
  const followers = new Set();
  const following = new Set();
  let foundFollowers = false;
  let foundFollowing = false;
  for (const { name, data } of files) {
    if (FOLLOWING_RE.test(name)) {
      foundFollowing = true;
      for (const n of usernamesOf(data)) following.add(n);
    } else if (FOLLOWERS_RE.test(name)) {
      foundFollowers = true;
      for (const n of usernamesOf(data)) followers.add(n);
    }
  }
  return { followers, following, found: foundFollowers && foundFollowing };
}

export const MISSING_CONNECTIONS =
  "相互フォローの判定に必要なフォロー情報がエクスポートにありません。エクスポートの設定で『フォロワーとフォロー中』も選んでください。";
export const MISSING_COLLECTION = `コレクション「${TARGET_COLLECTION}」がエクスポートにありません。手順0の保存先の名前と、エクスポートに『保存済み』を選んだかを確かめてください。`;

// saved_collections.json に出てくるコレクションの見出しの名前（中身が0件のものも含む）
function headerNames(node, names) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const header = collectionHeader(item);
      if (header !== null) names.add(header);
      headerNames(item, names);
    }
  } else if (isObj(node)) {
    for (const v of Object.values(node)) headerNames(v, names);
  }
  return names;
}

export function parseCollectionNames(files) {
  const names = new Set();
  for (const { name, data } of files) if (SOURCE_FILES[name] === "collection") headerNames(data, names);
  return names;
}

// ページの取り込み（export_parser.build_inbox と同じ決まり）: 対象コレクションの投稿を取り出し、
// 相互フォローかどうかの印を付ける。相互フォローでない投稿も捨てずに返す（2026-10-12 決定:
// 理由つきで「対象外」に表示する）。フォロー情報やコレクションの見出しが無いときは、候補を返さず
// notice を出す（ページは記録を書き換えない）。見出しがあって中身が0件のときは、空の一覧を正常に返す
// （全部シェアしてコレクションを空にしても取り込めるように。レビュー M3）。
export function buildInbox(files, collection = TARGET_COLLECTION) {
  const all = parseExport(files);
  const conn = parseConnections(files);
  if (!conn.found) return { candidates: [], notice: MISSING_CONNECTIONS };
  if (!parseCollectionNames(files).has(collection)) return { candidates: [], notice: MISSING_COLLECTION };
  const isMutual = (author) => Boolean(author) && conn.followers.has(author.toLowerCase()) && conn.following.has(author.toLowerCase());
  const candidates = all.filter((c) => c.collections.includes(collection)).map((c) => ({ ...c, mutual: isMutual(c.author) }));
  return { candidates, notice: "" };
}

// ファイル名だけを取り出す（zip 内のパス "a/b/saved_posts.json" → "saved_posts.json"）
export function baseName(path) {
  return String(path).split("/").pop();
}

export function isRelevantFile(name) {
  return name in SOURCE_FILES || FOLLOWERS_RE.test(name) || FOLLOWING_RE.test(name);
}
