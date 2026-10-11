// 画面の動き。zip の解析は parser.js、判定は model.js、記録の保存は store.js。
// zip は JSZip でこの端末の中だけで開き、どこにも送らない（2026-10-12 決定）。

import { CENTER_LABEL, PLACES } from "./places.js";
import { baseName, buildInbox, isRelevantFile } from "./parser.js";
import { InputError, RULE_TEXT, buildEvent, categorize, mergeImport, todayJST } from "./model.js";
import { StoreError, getToken, getTokenExpiry, load, setToken, update } from "./store.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let state = null; // 記録（store.load の結果）
let tab = "todo";
let firstRender = true;
let loadedAt = 0;
let busy = false;

const TAB_LABELS = { pending: "判定待ち", todo: "シェア対象", done: "シェア済み", skipped: "除外", outside: "対象外" };
const EMPTY = {
  pending: "判定待ちの投稿はありません",
  todo: "シェア対象の投稿はありません（「判定待ち」で開催地と日付を入力してください）",
  done: "シェア済みの投稿はありません",
  skipped: "除外した投稿はありません",
  outside: "対象外の投稿はありません",
};
const PLACE_OPTIONS =
  '<option value="">一覧から選ぶ</option>' +
  Object.entries(PLACES)
    .map(([p, cities]) => `<optgroup label="${esc(p)}">${cities.map(([c]) => `<option value="${esc(`${p} ${c}`)}">${esc(c)}</option>`).join("")}</optgroup>`)
    .join("");

function message(text, kind = "info") {
  const el = $("#msg");
  el.className = text ? kind : "";
  el.textContent = text || "";
}

// 日本時間の日付どうしの差（「今日」「N日前」を経過時間ではなく暦で数える）
function daysAgo(iso) {
  const day = (d) => Date.parse(`${todayJST(d)}T00:00:00Z`);
  return Math.round((day(new Date()) - day(new Date(iso))) / 86400000);
}

function fmtDate(ts) {
  if (!ts) return "";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" }).format(new Date(ts * 1000));
}

// ---- 記録の読み込みと保存 ----------------------------------------------------------

async function refresh() {
  if (!getToken()) {
    $("#settings").open = true;
    render();
    return;
  }
  try {
    const res = await load();
    state = res.state;
    loadedAt = Date.now();
    message("");
    showTokenInfo();
    render();
  } catch (e) {
    message(e instanceof StoreError ? e.message : `読み込みに失敗しました: ${e.message}`, "bad");
    render(); // 前に読めた記録があれば、そのまま表示を続ける（一時的な電波の不調で一覧を消さない）
    if (e.status === 401 || e.status === 403 || e.status === 404) $("#settings").open = true;
  }
}

function showTokenInfo() {
  const el = $("#tokenInfo");
  const expires = getTokenExpiry();
  if (!expires) {
    el.textContent = "鍵は登録済みです（有効期限が未入力のため、期限の前に知らせることができません）。";
    return;
  }
  // 期限の日の終わりまで使える。日本時間の暦で残り日数を数える
  const days = Math.round((Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${todayJST()}T00:00:00Z`)) / 86400000);
  el.textContent = `鍵の有効期限: ${expires}（あと${days}日）`;
  if (days <= 7) {
    message(days < 0
      ? "鍵（トークン）の期限が切れています。S3・S4 の手順で作り直してください。"
      : `鍵（トークン）の期限があと${days}日で切れます。S3・S4 の手順で作り直してください。`, "bad");
  }
}

async function save(mutate, label, okText) {
  if (busy) {
    message("保存中です。終わってからもう一度押してください。", "info");
    return false;
  }
  busy = true;
  document.body.style.cursor = "progress";
  try {
    state = await update(mutate, label);
    loadedAt = Date.now();
    if (okText) message(okText, "ok");
    render();
    return true;
  } catch (e) {
    message(e instanceof StoreError ? e.message : `保存できませんでした: ${e.message}`, "bad");
    return false;
  } finally {
    busy = false;
    document.body.style.cursor = "";
  }
}

// ---- エクスポートの読み込み（手順3） --------------------------------------------------

async function readZips(fileList) {
  const files = [];
  const names = [];
  for (const file of fileList) {
    names.push(file.name);
    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch {
      throw new InputError(`${file.name} は zip として開けませんでした。Instagram のエクスポートを選んでください。`);
    }
    for (const entry of Object.values(zip.files)) {
      const name = baseName(entry.name);
      if (entry.dir || !isRelevantFile(name)) continue;
      const text = await entry.async("string");
      try {
        files.push({ name, data: JSON.parse(text) });
      } catch {
        throw new InputError(`${file.name} の中の ${name} を読めませんでした（壊れている可能性があります）。`);
      }
    }
  }
  if (!files.length) throw new InputError("Instagram のエクスポートではないようです（保存済みの情報が見つかりません）。");
  return { files, names };
}

async function onImport(ev) {
  const picked = [...ev.target.files];
  ev.target.value = ""; // 同じファイルをもう一度選べるようにする
  if (!picked.length) return;
  if (busy) {
    message("保存中です。終わってからもう一度選んでください。", "info");
    return;
  }
  if (!state) {
    message("先に鍵（トークン）を登録して、記録を読み込んでください。", "bad");
    return;
  }
  message("読み込んでいます…（このiPhoneの中で処理しています）");
  let inbox;
  let names;
  try {
    const read = await readZips(picked);
    names = read.names;
    inbox = buildInbox(read.files);
  } catch (e) {
    message(e instanceof InputError ? e.message : `読み込めませんでした: ${e.message}`, "bad");
    return;
  }
  if (inbox.notice) {
    // フォロー情報やコレクションが無いときは、記録を書き換えない（全件「外れた」扱いになるのを防ぐ）
    message(inbox.notice, "bad");
    return;
  }
  let counts;
  // zip の名前には本人のユーザー名が入るので、記録とコミットメッセージには件数だけを残す（compliance L1）
  const ok = await save((s) => { counts = mergeImport(s, inbox.candidates, names.length); }, `取り込み（候補 ${inbox.candidates.length}件）`);
  if (!ok) return;
  const pending = Object.values(state.posts).filter((p) => categorize(p, todayJST()).tab === "pending").length;
  message(
    `取り込みました（${names.join("、")}）\n` +
      `新しく追加: ${counts.added}件` + (counts.addedNonMutual ? `（うち相互フォローではない ${counts.addedNonMutual}件は対象外へ）` : "") + "\n" +
      `前回からの引き継ぎ: ${counts.kept}件` +
      (counts.removed ? `／「問い合わせ」から外れた: ${counts.removed}件` : "") +
      (pending ? `\n判定待ち: ${pending}件` : ""),
    "ok",
  );
  if (pending) selectTab("pending");
  else render();
}

// ---- 表示 -----------------------------------------------------------------------

function selectTab(t) {
  tab = t;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === t);
  render();
}

function renderStatus() {
  const li = state?.last_import;
  const parts = [`条件: 「問い合わせ」・相互フォロー・${RULE_TEXT}`];
  if (li) {
    const d = daysAgo(li.at);
    const when = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).format(new Date(li.at));
    parts.unshift(d >= 7 ? `<span class="warn">前回の取り込み: ${when}（${d}日前）</span>` : `前回の取り込み: ${when}（${d === 0 ? "今日" : `${d}日前`}）`);
  } else if (state) {
    parts.unshift(`<span class="warn">まだ取り込んでいません。「エクスポートを読み込む」から zip を選んでください。</span>`);
  } else {
    parts.unshift(`<span class="warn">${getToken()
      ? "記録を読み込めていません（下の案内を確認してから「再読み込み」を押してください）。"
      : "最初に「設定」から鍵（トークン）を登録してください。"}</span>`);
  }
  $("#status").innerHTML = parts.join("<br>");
}

function card(code, p, info) {
  const head = `
    <div class="who">${p.author ? "@" + esc(p.author) : "(投稿者不明)"}</div>
    <div class="sub">${p.kind === "reel" ? "リール" : "投稿"}・保存 ${esc(fmtDate(p.saved_at))}</div>`;
  // リンクは Instagram の投稿URLだけを通す（記録が書き換えられていても別のサイトへ飛ばない）
  const url = /^https:\/\/www\.instagram\.com\/(p|reel)\/[\w-]+\/$/.test(p.url) ? p.url : "#";
  const open = `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Instagramで開く</a>`;
  const where = info.place
    ? `<div class="ev ${info.tab === "todo" ? "ok" : ""}">開催地: ${esc(info.place)}${info.distance != null ? `（${esc(CENTER_LABEL)}から約${info.distance}km）` : ""}<br>日程: ${esc(info.period)}</div>`
    : "";
  let body = "";
  if (info.tab === "pending") {
    body = `
      <div class="sub">投稿を開いて、開催地と日付を確かめて入力してください。</div>
      <div class="acts">${open}</div>
      <div class="judge">
        <label>開催地<select data-k="place">${PLACE_OPTIONS}</select></label>
        <label>一覧に無いとき: 座標（マップ アプリで会場を長押しして出る数字）
          <input data-k="latlon" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="例: 34.6551, 133.9195"></label>
        <label class="check"><input data-k="online" type="checkbox"> オンラインのイベント</label>
        <div class="dates">
          <label>始まりの日（必須）<input data-k="start" type="date"></label>
          <label>終わりの日（任意）<input data-k="end" type="date"></label>
        </div>
        <div class="err" data-k="err"></div>
        <div class="acts"><button class="btn ok" data-a="event">登録</button><button class="btn" data-a="skip">除外</button></div>
      </div>`;
  } else if (info.tab === "todo") {
    body = `${where}
      <div class="hl">ハイライトの追加先: <b>${esc(info.highlight)}</b></div>
      <div class="acts">${open}<button class="btn ok" data-a="done">シェアした</button></div>
      <div class="acts"><button class="btn" data-a="skip">除外</button><button class="btn" data-a="clear">判定をやり直す</button></div>`;
  } else if (info.tab === "outside") {
    body = `<div class="reason">対象外: ${esc(info.reason)}</div>${where}
      <div class="acts">${open}${p.event ? `<button class="btn" data-a="clear">判定をやり直す</button>` : ""}</div>`;
  } else {
    const label = info.tab === "done" ? `シェア済み ${esc(p.shared_at ? fmtDate(Date.parse(p.shared_at) / 1000) : "")}` : "除外";
    body = `<div class="sub">${label}</div>${where}${info.highlight ? `<div class="sub">ハイライト: ${esc(info.highlight)}</div>` : ""}
      <div class="acts">${open}<button class="btn" data-a="undo">未処理に戻す</button></div>`;
  }
  return `<div class="card" data-code="${esc(code)}">${head}${body}</div>`;
}

// 判定待ちカードの入力中の値。Instagram やマップから戻ったときの再読み込みや、別のカードの操作で
// 一覧を作り直しても消えないようにする（レビュー H2）。登録できたら、そのカードの分は捨てる
const drafts = new Map();

function saveDrafts() {
  for (const el of document.querySelectorAll(".card")) {
    const judge = el.querySelector(".judge");
    if (!judge) continue;
    const v = (k) => judge.querySelector(`[data-k=${k}]`);
    const draft = { place: v("place").value, latlon: v("latlon").value, online: v("online").checked, start: v("start").value, end: v("end").value };
    if (draft.place || draft.latlon || draft.online || draft.start || draft.end) drafts.set(el.dataset.code, draft);
    else drafts.delete(el.dataset.code);
  }
}

function restoreDrafts() {
  for (const el of document.querySelectorAll(".card")) {
    const draft = drafts.get(el.dataset.code);
    const judge = el.querySelector(".judge");
    if (!draft || !judge) continue;
    const v = (k) => judge.querySelector(`[data-k=${k}]`);
    v("place").value = draft.place;
    v("latlon").value = draft.latlon;
    v("online").checked = draft.online;
    v("start").value = draft.start;
    v("end").value = draft.end;
    for (const k of ["place", "latlon"]) v(k).disabled = draft.online;
  }
}

function render() {
  saveDrafts();
  renderStatus();
  const today = todayJST();
  const rows = state ? Object.entries(state.posts).map(([code, p]) => [code, p, categorize(p, today)]) : [];
  const counts = { pending: 0, todo: 0, done: 0, skipped: 0, outside: 0 };
  for (const [, , info] of rows) counts[info.tab]++;
  for (const b of document.querySelectorAll("#tabs button")) {
    b.innerHTML = `${TAB_LABELS[b.dataset.tab]}<span class="n">${counts[b.dataset.tab]}</span>`;
  }
  if (firstRender && state) {
    firstRender = false;
    if (counts.pending && !counts.todo) return selectTab("pending"); // 最初は入力が要るものから
  }
  const list = rows
    .filter(([, , info]) => info.tab === tab)
    .sort(([, a], [, b]) =>
      tab === "todo" ? a.event.start.localeCompare(b.event.start) : (b.saved_at || 0) - (a.saved_at || 0));
  $("#list").innerHTML = list.length ? list.map(([code, p, info]) => card(code, p, info)).join("") : `<div class="empty">${state ? EMPTY[tab] : ""}</div>`;
  restoreDrafts();
}

// ---- 操作 -----------------------------------------------------------------------

async function onAction(e) {
  const btn = e.target.closest("button[data-a]");
  if (!btn || !state) return;
  const el = btn.closest(".card");
  const code = el.dataset.code;
  const p = state.posts[code];
  const who = p.author ? `@${p.author}` : code;
  const a = btn.dataset.a;
  if (a === "event") {
    const val = (k) => el.querySelector(`[data-k=${k}]`);
    let event;
    try {
      event = buildEvent({
        place: val("place").value, latlon: val("latlon").value, online: val("online").checked,
        start: val("start").value, end: val("end").value,
      });
    } catch (err) {
      val("err").textContent = err instanceof InputError ? err.message : String(err);
      return;
    }
    const ok = await save((s) => { s.posts[code].event = event; }, `開催地と日付 ${code}`, `${who} を登録しました`);
    // 保存後の作り直しで画面の値が下書きに拾われるので、登録できたら最後に捨てる（失敗なら入力はそのまま残る）
    if (ok) drafts.delete(code);
  } else if (a === "done") {
    await save((s) => { s.posts[code].status = "done"; s.posts[code].shared_at = new Date().toISOString(); }, `シェアした ${code}`, `${who} をシェア済みにしました`);
  } else if (a === "skip") {
    await save((s) => { s.posts[code].status = "skipped"; }, `除外 ${code}`, `${who} を除外しました`);
  } else if (a === "undo") {
    await save((s) => { s.posts[code].status = "todo"; delete s.posts[code].shared_at; }, `未処理に戻す ${code}`, `${who} を未処理に戻しました`);
  } else if (a === "clear") {
    await save((s) => { s.posts[code].event = null; }, `判定をやり直す ${code}`, `${who} を判定待ちに戻しました`);
  }
}

// 入力したらエラー表示を消す。オンラインにしたら開催地の欄を使えなくする（座標は一覧より優先される: model.buildEvent）
function onInput(e) {
  const el = e.target.closest(".judge");
  if (!el) return;
  el.querySelector("[data-k=err]").textContent = "";
  if (e.target.dataset.k === "online") {
    for (const k of ["place", "latlon"]) el.querySelector(`[data-k=${k}]`).disabled = e.target.checked;
  }
}

$("#zip").addEventListener("change", onImport);
$("#reload").addEventListener("click", () => (busy ? message("保存中です。終わってからもう一度押してください。", "info") : refresh()));
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) selectTab(b.dataset.tab); });
$("#list").addEventListener("click", onAction);
$("#list").addEventListener("input", onInput);
$("#saveToken").addEventListener("click", async () => {
  const t = $("#token").value.trim();
  const expires = $("#tokenExpires").value;
  if (!t) return message("鍵（トークン）を貼り付けてください。", "bad");
  if (!expires) return message("鍵の有効期限（鍵を作った画面に出る日付）を選んでください。期限の前に知らせるために使います。", "bad");
  if (!setToken(t, expires)) return message("この端末では鍵を保存できませんでした（プライベートブラウズでは保存できません）。", "bad");
  $("#token").value = "";
  $("#settings").open = false;
  await refresh();
});
$("#clearToken").addEventListener("click", () => {
  setToken("");
  state = null;
  render();
  message("鍵を消しました。");
});
// Instagram アプリから戻ってきたとき、別の端末での操作を反映する（1分以上たっていれば）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !busy && Date.now() - loadedAt > 60000 && getToken()) refresh();
});

refresh();
