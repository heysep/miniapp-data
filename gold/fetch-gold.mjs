/**
 * 국내 금 시세(KRX 금시장, 원/g) 수집 → gold.json
 *
 * 출처: 네이버 증권 시장지표 「국내 금」(reutersCode M04020000, 한국거래소 KRX 금시장, 단위 원/g)
 *   - 현재가: https://m.stock.naver.com/front-api/marketIndex/productDetail?category=metals&reutersCode=M04020000
 *   - 일별 종가: https://m.stock.naver.com/front-api/marketIndex/prices?category=metals&reutersCode=M04020000&page=1&pageSize=40
 *   2026-10-28 curl 로 둘 다 응답 확인(closePrice "170,390", unit "원/g", localTradedAt 2026-10-27T15:19:57+09:00).
 *
 * 사용: node gold/fetch-gold.mjs [출력경로]   (기본: 이 파일 옆 gold.json)
 *   앱 스냅샷 갱신: node data-pipeline/fetch-gold.mjs src/data/gold-snapshot.json
 *
 * 원칙: 응답 구조가 하나라도 어긋나면 파일을 쓰지 않고 exit 1. 반쯤 맞는 데이터를 커밋하지 않는다.
 * updatedAt 은 수집 시각이 아니라 거래소 체결 시각(localTradedAt) — 화면의 「○○ 기준」이 사실이 되고,
 * 장 마감 후 반복 실행은 같은 파일을 만들어 커밋이 생기지 않는다.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE = 'M04020000';
const BASE = 'https://m.stock.naver.com/front-api/marketIndex';
const DETAIL_URL = `${BASE}/productDetail?category=metals&reutersCode=${CODE}`;
const PRICES_URL = `${BASE}/prices?category=metals&reutersCode=${CODE}&page=1&pageSize=40`;
const SOURCE = 'KRX 금시장 국내 금 1g (네이버 증권)';
/** 원/g 정상 범위. 벗어나면 단위·필드가 바뀐 것으로 본다 */
const MIN_PRICE = 30_000;
const MAX_PRICE = 1_000_000;
const HISTORY_DAYS = 30;

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? resolve(here, 'gold.json'));

function fail(msg) {
  console.error(`fetch-gold: ${msg} — 파일을 쓰지 않았어요`);
  process.exit(1);
}

/** "170,390" · "-3,040" → 숫자. 형식이 다르면 NaN */
function num(s) {
  if (typeof s !== 'string' || !/^-?[\d,]+(\.\d+)?$/.test(s.trim())) return NaN;
  return Number(s.replace(/,/g, ''));
}
const okPrice = (n) => Number.isFinite(n) && n >= MIN_PRICE && n <= MAX_PRICE;
/** "2026-10-27T15:19:57+09:00" → "2026-10-27" (KST 날짜 그대로) */
function kstDate(iso) {
  const m = typeof iso === 'string' && /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\+09:00$/.exec(iso);
  return m ? m[1] : null;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (miniapp-data gold bot)', Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) fail(`${url} HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    fail(`${url} JSON 아님`);
  }
}

const detail = await getJson(DETAIL_URL);
const prices = await getJson(PRICES_URL);

// ── 현재가 검증 ──
if (detail?.isSuccess !== true) fail('productDetail isSuccess != true');
const d = detail.result;
if (d?.reutersCode !== CODE) fail(`reutersCode ${d?.reutersCode}`);
if (d?.unit !== '원/g') fail(`unit ${d?.unit}`);
if (d?.stockExchangeType?.code !== 'KRX') fail(`거래소 ${d?.stockExchangeType?.code}`);
const price = num(d.closePrice);
const fluct = num(d.fluctuations);
if (!okPrice(price)) fail(`closePrice ${d.closePrice}`);
if (!Number.isFinite(fluct)) fail(`fluctuations ${d.fluctuations}`);
const tradeDate = kstDate(d.localTradedAt);
if (!tradeDate) fail(`localTradedAt ${d.localTradedAt}`);
const prevClose = price - fluct;
if (!okPrice(prevClose)) fail(`전일 종가 계산값 ${prevClose}`);

// ── 일별 종가 검증 ──
if (prices?.isSuccess !== true || !Array.isArray(prices.result)) fail('prices 구조');
const rows = [];
for (const r of prices.result) {
  const date = kstDate(r?.localTradedAt);
  const p = num(r?.closePrice);
  if (!date || !okPrice(p)) fail(`prices 행 ${JSON.stringify(r).slice(0, 120)}`);
  rows.push({ date, pricePerGram: p });
}
if (rows.length < 10) fail(`prices ${rows.length}행 — 너무 적음`);

// 오늘 행이 이미 있으면 현재가로 덮고, 없으면(장중) 앞에 붙인다. 중복 금지.
const byDate = new Map(rows.map((r) => [r.date, r.pricePerGram]));
byDate.set(tradeDate, price);
const all = [...byDate.entries()].map(([date, pricePerGram]) => ({ date, pricePerGram })).sort((a, b) => a.date.localeCompare(b.date));

// 전일 종가 교차 확인: 거래일 바로 앞 행
const before = all.filter((r) => r.date < tradeDate).at(-1);
if (!before) fail('전일 행 없음');
if (before.pricePerGram !== prevClose) fail(`전일 종가 불일치 — 계산 ${prevClose} / 일별 ${before.pricePerGram} (${before.date})`);

// 최근 30일(달력 기준, 거래일 포함)
const cut = new Date(`${tradeDate}T00:00:00Z`);
cut.setUTCDate(cut.getUTCDate() - HISTORY_DAYS);
const cutStr = cut.toISOString().slice(0, 10);
const history = all.filter((r) => r.date > cutStr);
if (history.length < 10) fail(`30일 내 ${history.length}행`);

const data = {
  updatedAt: d.localTradedAt,
  source: SOURCE,
  pricePerGram: price,
  prevClosePerGram: prevClose,
  history,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
console.log(`fetch-gold: ${out} ← ${price.toLocaleString('ko-KR')}원/g (${d.localTradedAt}), 전일 ${prevClose.toLocaleString('ko-KR')}, ${history.length}일`);
