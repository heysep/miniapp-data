/**
 * 여행 통화 환율(하나은행 고시, 원화) 수집 → fx.json
 *
 * 출처: 네이버 증권 시장지표 환율(stockExchangeType HANA = 하나은행 고시회차)
 *   - 현재 회차: https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW
 *   - 일별(오늘 행 포함, 현찰 살 때 cashBuyValue 포함):
 *     https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW&page=1&pageSize=40
 *   2026-10-28 curl 로 12개 통화 전부 응답 확인(USD closePrice "1,339.60", cashBuyValue "1,363.04",
 *   localTradedAt 2026-10-28T13:11:44+09:00, 하나은행 317회차). pageSize 는 10 이상이어야 한다(5 는 too_small).
 *
 * 단위 함정: JPY·VND 는 100단위 고시다(JPY 848.04 = 100엔). 응답의 unit 은 "KRW" 라 드러나지 않는다.
 *   → PER 로 고정하고, 통화별 정상 범위로 단위가 바뀌면 실패하게 한다.
 *
 * 사용: node fx/fetch-fx.mjs [출력경로]   (기본: 이 파일 옆 fx.json)
 *   앱 스냅샷 갱신: node data-pipeline/fetch-fx.mjs src/data/fx-snapshot.json
 *
 * 원칙: 통화 하나라도 검증에 어긋나면 파일을 쓰지 않고 exit 1(all-or-nothing).
 * updatedAt 은 수집 시각이 아니라 고시 시각(localTradedAt) — 회차가 안 바뀌면 같은 파일이 나와 커밋이 안 생긴다.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** code → [고시 단위, 최소, 최대(고시값 기준, 원)] */
export const CURRENCIES = {
  USD: [1, 900, 2200],
  JPY: [100, 500, 1500],
  EUR: [1, 1000, 2600],
  CNY: [1, 120, 350],
  VND: [100, 3, 10],
  THB: [1, 25, 65],
  TWD: [1, 25, 70],
  PHP: [1, 12, 40],
  HKD: [1, 110, 300],
  SGD: [1, 700, 1700],
  GBP: [1, 1200, 2900],
  AUD: [1, 600, 1500],
};
const BASE = 'https://m.stock.naver.com/front-api/marketIndex';
const SOURCE = '하나은행 고시 환율 (네이버 증권)';
const HISTORY_DAYS = 30;

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? resolve(here, 'fx.json'));

function fail(msg) {
  console.error(`fetch-fx: ${msg} — 파일을 쓰지 않았어요`);
  process.exit(1);
}

/** "1,339.60" · "-0.50" → 숫자. 형식이 다르면 NaN */
function num(s) {
  if (typeof s !== 'string' || !/^-?[\d,]+(\.\d+)?$/.test(s.trim())) return NaN;
  return Number(s.replace(/,/g, ''));
}
/** detail 용: "2026-10-28T13:11:44+09:00" → "2026-10-28" */
function isoKstDate(iso) {
  const m = typeof iso === 'string' && /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\+09:00$/.exec(iso);
  return m ? m[1] : null;
}
/** prices 행 용: 날짜만 온다 "2026-10-28" */
function rowDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
const round2 = (n) => Math.round(n * 100) / 100;

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (miniapp-data fx bot)', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    fail(`${url} ${e?.name ?? e}`);
  }
  if (!res.ok) fail(`${url} HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    fail(`${url} JSON 아님`);
  }
}

async function fetchOne(code, [per, min, max]) {
  const rc = `FX_${code}KRW`;
  const ok = (n) => Number.isFinite(n) && n >= min && n <= max;
  const detail = await getJson(`${BASE}/productDetail?category=exchange&reutersCode=${rc}`);
  const prices = await getJson(`${BASE}/prices?category=exchange&reutersCode=${rc}&page=1&pageSize=40`);

  if (detail?.isSuccess !== true) return `${code} productDetail isSuccess != true`;
  const d = detail.result;
  if (d?.reutersCode !== rc) return `${code} reutersCode ${d?.reutersCode}`;
  if (d?.unit !== 'KRW') return `${code} unit ${d?.unit}`;
  if (d?.stockExchangeType?.code !== 'HANA') return `${code} 고시기관 ${d?.stockExchangeType?.code}`;
  const rate = num(d.closePrice);
  const fluct = num(d.fluctuations);
  if (!ok(rate)) return `${code} closePrice ${d.closePrice} (범위 ${min}~${max}, 단위 ${per})`;
  if (!Number.isFinite(fluct)) return `${code} fluctuations ${d.fluctuations}`;
  const tradeDate = isoKstDate(d.localTradedAt);
  if (!tradeDate) return `${code} localTradedAt ${d.localTradedAt}`;
  const prevRate = round2(rate - fluct);
  if (!ok(prevRate)) return `${code} 전일 계산값 ${prevRate}`;

  if (prices?.isSuccess !== true || !Array.isArray(prices.result)) return `${code} prices 구조`;
  const rows = [];
  for (const r of prices.result) {
    const date = rowDate(r?.localTradedAt);
    const p = num(r?.closePrice);
    if (!date || !ok(p)) return `${code} prices 행 ${JSON.stringify(r).slice(0, 120)}`;
    rows.push({ date, rate: p, cashBuy: num(r?.cashBuyValue) });
  }
  if (rows.length < 10) return `${code} prices ${rows.length}행 — 너무 적음`;

  // 현찰 살 때: 오늘 행이 있고 그 매매기준율이 detail 회차와 같을 때만 채택(두 호출 사이 회차가 바뀌면 어긋난다)
  const today = rows.find((r) => r.date === tradeDate);
  if (!today) return `${code} 오늘(${tradeDate}) 행 없음`;
  if (today.rate !== rate) return `RETRY ${code} 회차 어긋남 detail ${rate} / prices ${today.rate}`;
  let cashBuy = null;
  if (Number.isFinite(today.cashBuy)) {
    if (today.cashBuy < rate || today.cashBuy > rate * 1.2) return `${code} cashBuyValue ${today.cashBuy} — 매매기준율 ${rate} 대비 이상`;
    cashBuy = today.cashBuy;
  }

  const byDate = new Map(rows.map((r) => [r.date, r.rate]));
  const all = [...byDate.entries()].map(([date, r]) => ({ date, rate: r })).sort((a, b) => a.date.localeCompare(b.date));
  const before = all.filter((r) => r.date < tradeDate).at(-1);
  if (!before) return `${code} 전일 행 없음`;
  if (Math.abs(before.rate - prevRate) > 0.011) return `${code} 전일 불일치 — 계산 ${prevRate} / 일별 ${before.rate} (${before.date})`;

  const cut = new Date(`${tradeDate}T00:00:00Z`);
  cut.setUTCDate(cut.getUTCDate() - HISTORY_DAYS);
  const cutStr = cut.toISOString().slice(0, 10);
  const history = all.filter((r) => r.date > cutStr);
  if (history.length < 10) return `${code} 30일 내 ${history.length}행`;

  return { code, per, name: String(d.name ?? code), updatedAt: d.localTradedAt, rate, prevRate, cashBuy, history };
}

const results = {};
for (const [code, spec] of Object.entries(CURRENCIES)) {
  let r = await fetchOne(code, spec);
  if (typeof r === 'string' && r.startsWith('RETRY')) {
    await new Promise((ok) => setTimeout(ok, 3000));
    r = await fetchOne(code, spec); // 회차가 막 바뀐 순간이면 한 번만 다시
  }
  if (typeof r === 'string') fail(r.replace(/^RETRY /, ''));
  results[code] = r;
}

// 통화마다 같은 고시일이어야 한다. 시각은 회차 경계에서 몇 분 어긋날 수 있어 가장 이른 것을 기준 시각으로 쓴다.
const stamps = Object.values(results).map((r) => r.updatedAt);
const dates = new Set(stamps.map(isoKstDate));
if (dates.size !== 1) fail(`통화별 고시일이 다름 ${[...dates].join(',')}`);
const updatedAt = stamps.sort()[0];

const data = {
  updatedAt,
  source: SOURCE,
  currencies: Object.fromEntries(
    Object.values(results).map(({ code, per, rate, prevRate, cashBuy, history }) => [code, { per, rate, prevRate, cashBuy, history }]),
  ),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
const usd = results.USD;
console.log(`fetch-fx: ${out} ← ${Object.keys(results).length}개 통화, USD ${usd.rate} (현찰 ${usd.cashBuy}), ${updatedAt}`);
