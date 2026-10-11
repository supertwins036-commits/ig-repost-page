// 開催地の距離判定（条件3: 岡山市役所から直線距離150km以内。2026-10-12 決定）。
// ig_repost/geo.py の移植。座標表は places.js（geo.py から生成）を使う。
// 外部のジオコーディングサービスは使わない（開催地を外に送らないため）。

import { CENTER, LAT_RANGE, LON_RANGE, PLACES, RADIUS_KM } from "./places.js";

const EARTH_RADIUS_KM = 6371.0088; // 平均地球半径（geo.py と同じ値）

export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const [lat1, lon1, lat2, lon2] = [a[0], a[1], b[0], b[1]].map(rad);
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function inJapan(lat, lon) {
  return LAT_RANGE[0] <= lat && lat <= LAT_RANGE[1] && LON_RANGE[0] <= lon && lon <= LON_RANGE[1];
}

// 座標の文字列を [緯度, 経度] にする（geo.py の parse_latlon と同じ決まり）。
// 「34.6551, 133.9195」「34.65510° N, 133.91950° E」（iPhone のマップでコピーした形）「北緯34.6551 東経133.9195」。
// 区切りは半角/全角カンマ・読点・空白。日本の範囲外（緯度と経度の取り違えを含む）は null。
const COORD = "(北緯|南緯|東経|西経)?\\s*(-?\\d+(?:\\.\\d+)?)\\s*°?\\s*([NSEWnsew])?";
const LATLON_RE = new RegExp(`^\\s*\\(?\\s*${COORD}\\s*[,，、\\s]\\s*${COORD}\\s*\\)?\\s*$`);

function coordValue(prefix, num, hemi) {
  const v = Number(num);
  // 南緯・西経（S・W）は負の値。日本の範囲外になるので結果的に null になる
  return ["S", "W"].includes((hemi || "").toUpperCase()) || prefix === "南緯" || prefix === "西経" ? -Math.abs(v) : v;
}

export function parseLatLon(text) {
  const m = LATLON_RE.exec(text || "");
  if (!m) return null;
  const lat = coordValue(m[1], m[2], m[3]);
  const lon = coordValue(m[4], m[5], m[6]);
  return inJapan(lat, lon) ? [lat, lon] : null;
}

// 「岡山県 倉敷市」または「倉敷市」から座標を引く。一覧に無ければ null。
export function findPlace(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  const pref = parts.length > 1 ? parts[0] : "";
  const city = parts.length ? parts[parts.length - 1] : "";
  for (const [p, cities] of Object.entries(PLACES)) {
    if (pref && p !== pref) continue;
    for (const [c, lat, lon] of cities) if (c === city) return [lat, lon];
  }
  return null;
}

export function distanceFromCenterKm(latlon) {
  return haversineKm(CENTER, latlon);
}

export function withinRadius(latlon) {
  return distanceFromCenterKm(latlon) <= RADIUS_KM;
}
