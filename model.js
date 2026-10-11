// 記録の中身と、振り分け・判定の決まり（画面から切り離して Node でテストする）。
//
// 決定（2026-10-12、本人）:
//  - 候補はコレクション「問い合わせ」の投稿だけ。すべてイベント告知として扱う（Q1・Q2）
//  - 相互フォローでない投稿は「対象外（相互フォローではない）」に理由つきで出す（Q3）
//  - 開催地は岡山市役所から直線距離150km以内が対象（Q4）。オンラインは距離を見ずに対象（Q10）
//  - 始まりの日は必須、終わりの日は任意（空なら1日だけ）。終わったら「対象外（終了）」（Q5・Q11）
//  - ハイライトは始まりの日の月で「2026年11月」（Q8・Q9）

import { CENTER_LABEL, RADIUS_KM } from "./places.js";
import { distanceFromCenterKm, findPlace, parseLatLon } from "./geo.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 実在する日付か（2026-13-45 や 2026-02-30 を弾く）
function isDate(text) {
  if (!DATE_RE.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 日本時間の今日（YYYY-MM-DD）。端末のタイムゾーン設定に左右されないようにする。
export function todayJST(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);
}

export function highlightName(start) {
  const [y, m] = start.split("-").map(Number);
  return `${y}年${m}月`;
}

// 取り込み: エクスポートの候補を記録に突き合わせる。入力済みの開催地・日付や「シェアした」は引き継ぐ。
// 「問い合わせ」から外された投稿は消さずに in_latest=false にする（記録を勝手に消さないため）。
export function mergeImport(state, candidates, fileCount, now = new Date()) {
  const counts = { added: 0, addedNonMutual: 0, kept: 0, removed: 0 };
  const seen = new Set();
  for (const c of candidates) {
    seen.add(c.code);
    const prev = state.posts[c.code];
    if (prev) counts.kept++;
    else {
      counts.added++;
      if (!c.mutual) counts.addedNonMutual++;
    }
    state.posts[c.code] = {
      status: "todo",
      event: null,
      ...prev,
      url: c.url,
      author: c.author,
      kind: c.kind,
      saved_at: c.timestamp,
      mutual: c.mutual,
      in_latest: true,
    };
  }
  for (const [code, p] of Object.entries(state.posts)) {
    if (!seen.has(code) && p.in_latest !== false) {
      p.in_latest = false;
      counts.removed++;
    }
  }
  state.last_import = { at: now.toISOString(), file_count: fileCount, counts };
  return counts;
}

// 投稿をどのタブに出すかを決める。
// tab: pending（判定待ち）/ todo（シェア対象）/ done / skipped / outside（対象外）
export function categorize(post, today) {
  if (post.status === "done") return { tab: "done", ...eventInfo(post) };
  if (post.status === "skipped") return { tab: "skipped", ...eventInfo(post) };
  if (post.in_latest === false) return { tab: "outside", reason: "「問い合わせ」から外れた", ...eventInfo(post) };
  if (!post.mutual) return { tab: "outside", reason: "相互フォローではない", ...eventInfo(post) };
  if (!post.event) return { tab: "pending" };
  const info = eventInfo(post);
  if ((post.event.end || post.event.start) < today) return { tab: "outside", reason: "終了", ...info };
  // 判定は丸める前の距離で行う（丸めると 150.04km が「150.0」になって対象に入る。レビュー M2）。
  // 座標が欠けた記録は距離が NaN になるので、!(km <= 半径) で範囲外に倒す
  if (!post.event.online && !(distanceKm(post.event) <= RADIUS_KM)) return { tab: "outside", reason: "範囲外", ...info };
  return { tab: "todo", ...info };
}

function distanceKm(ev) {
  return distanceFromCenterKm([ev.lat, ev.lon]);
}

function eventInfo(post) {
  const ev = post.event;
  if (!ev) return {};
  return {
    place: ev.online ? "オンライン" : ev.place,
    distance: ev.online ? null : Math.round(distanceKm(ev) * 10) / 10, // 表示用（小数1桁）
    highlight: highlightName(ev.start),
    period: ev.end && ev.end !== ev.start ? `${ev.start}〜${ev.end}` : ev.start,
  };
}

export class InputError extends Error {}

// 画面の入力（開催地・座標・オンライン・日付）を検証して、記録に入れる形にする。
export function buildEvent({ place = "", latlon = "", online = false, start = "", end = "" }) {
  if (!isDate(start)) throw new InputError("始まりの日を選んでください");
  if (end && !isDate(end)) throw new InputError("終わりの日の形式が正しくありません");
  if (end && end < start) throw new InputError("終わりの日が始まりの日より前になっています");
  const base = { start, end: end && end !== start ? end : "" };
  if (online) return { online: true, place: "オンライン", ...base };
  // 座標を入れたときは座標を優先し、一覧の選択は使わない（名前と距離の出どころを食い違わせない。レビュー L8）
  let coords = null;
  let name = "";
  if (String(latlon).trim()) {
    coords = parseLatLon(String(latlon).slice(0, 64));
    if (!coords) throw new InputError("座標を読み取れません（例: 34.6551, 133.9195 や 34.65510° N, 133.91950° E）");
    name = `座標 ${coords[0].toFixed(4)}, ${coords[1].toFixed(4)}`;
  } else if (String(place).trim()) {
    name = String(place).trim().slice(0, 64);
    coords = findPlace(name);
  }
  if (!coords) throw new InputError("開催地を一覧から選ぶか、座標を入力するか、「オンライン」を選んでください");
  return { online: false, place: name, lat: coords[0], lon: coords[1], ...base };
}

export const RULE_TEXT = `${CENTER_LABEL}から${RADIUS_KM}km以内（直線距離）`;
