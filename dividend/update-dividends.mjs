#!/usr/bin/env node
/**
 * dividend/dividends.json 실데이터 갱신 스크립트 (Node 22+, 의존성 없음).
 *
 * Yahoo Finance quoteSummary(crumb 인증)에서 종목별로
 *  - summaryDetail        → 연 배당금(dividendRate)·배당수익률(dividendYield)·직전 배당락일
 *                           + 배당성향(payoutRatio)·5년 평균 배당수익률·beta
 *  - calendarEvents       → 다음 배당락일(exDividendDate)·지급일(dividendDate)
 *  - defaultKeyStatistics → beta 보조 소스
 * 를 받아 병합한다. 실패 종목은 기존 값을 유지한다(데이터가 절대 비지 않음).
 *
 * 추가로 chart API(range=5y&interval=1mo&events=div) 한 번으로
 *  - divHistory   → 과거 5년 배당 지급 내역 (오래된 것부터)
 *  - priceHistory → 월별 종가 (오래된 것부터)
 * 를 받아 별도 파일 dividend/history.json에 쓴다.
 * "과거에 샀으면 배당이 얼마나 늘었을까"를 앱에서 계산하려면 둘 다 필요하다.
 *
 * 파일을 나눈 이유: 이력을 dividends.json에 같이 넣으면 19KB → 126KB(6.5배)가 된다.
 * 목록 화면은 이력이 필요 없는데 매번 6배를 받게 되므로,
 * dividends.json은 목록용으로 가볍게 두고 이력은 종목 상세를 열 때만 받는다.
 * 두 파일 다 내용이 실제로 바뀐 경우에만 asOf를 갱신한다.
 * 이력 수집이 실패한 종목은 history.json에서만 빠진다(전체 실행은 계속).
 *
 * GitHub Actions에서 매일 실행 → 변경 시 커밋 (.github/workflows/update-dividends.yml)
 * 사용: node dividend/update-dividends.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(DIR, 'dividends.json');
const HIST_PATH = join(DIR, 'history.json');

/** 유니버스 — 표시용 메타는 수동, 날짜·금액·수익률은 Yahoo에서 자동. */
const UNIVERSE = [
  // 국내 (코스피 .KS)
  { symbol: '005930.KS', code: '005930', name: '삼성전자', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#1428A0', logo: '삼' },
  { symbol: '000660.KS', code: '000660', name: 'SK하이닉스', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#EC1C24', logo: 'S' },
  { symbol: '005380.KS', code: '005380', name: '현대차', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#002C5F', logo: '현' },
  { symbol: '105560.KS', code: '105560', name: 'KB금융', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#FFB300', logo: 'K' },
  { symbol: '055550.KS', code: '055550', name: '신한지주', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#0046B8', logo: '신' },
  { symbol: '086790.KS', code: '086790', name: '하나금융지주', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#008C8C', logo: '하' },
  { symbol: '316140.KS', code: '316140', name: '우리금융지주', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#0067AC', logo: '우' },
  { symbol: '017670.KS', code: '017670', name: 'SK텔레콤', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#EA002C', logo: 'T' },
  { symbol: '030200.KS', code: '030200', name: 'KT', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#E10500', logo: 'K' },
  { symbol: '033780.KS', code: '033780', name: 'KT&G', market: 'KR', freq: '반기배당', exMonths: [6, 12], color: '#00654E', logo: 'K' },
  { symbol: '015760.KS', code: '015760', name: '한국전력', market: 'KR', freq: '연배당', exMonths: [12], color: '#E60012', logo: '한' },
  { symbol: '005490.KS', code: '005490', name: 'POSCO홀딩스', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#2AA8E0', logo: 'P' },
  { symbol: '005830.KS', code: '005830', name: 'DB손해보험', market: 'KR', freq: '연배당', exMonths: [12], color: '#0A8246', logo: 'D' },
  { symbol: '139480.KS', code: '139480', name: '이마트', market: 'KR', freq: '연배당', exMonths: [12], color: '#FFD400', logo: '이' },
  { symbol: '000810.KS', code: '000810', name: '삼성화재', market: 'KR', freq: '연배당', exMonths: [12], color: '#1F5FDB', logo: '삼' },
  { symbol: '032830.KS', code: '032830', name: '삼성생명', market: 'KR', freq: '연배당', exMonths: [12], color: '#0B72B8', logo: '삼' },
  { symbol: '138040.KS', code: '138040', name: '메리츠금융지주', market: 'KR', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#B0323F', logo: '메' },
  { symbol: '361570.KS', code: '361570', name: 'TIGER 미국배당다우존스', market: 'KR', freq: '월배당', exMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], color: '#F58220', logo: 'T' },
  // 미국
  { symbol: 'AAPL', code: 'AAPL', name: '애플', market: 'US', freq: '분기배당', exMonths: [2, 5, 8, 11], color: '#111111', logo: 'A' },
  { symbol: 'MSFT', code: 'MSFT', name: '마이크로소프트', market: 'US', freq: '분기배당', exMonths: [2, 5, 8, 11], color: '#00A4EF', logo: 'M' },
  { symbol: 'KO', code: 'KO', name: '코카콜라', market: 'US', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#F40009', logo: 'C' },
  { symbol: 'PEP', code: 'PEP', name: '펩시코', market: 'US', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#004B93', logo: 'P' },
  { symbol: 'JNJ', code: 'JNJ', name: '존슨앤드존슨', market: 'US', freq: '분기배당', exMonths: [2, 5, 8, 11], color: '#D51900', logo: 'J' },
  { symbol: 'PG', code: 'PG', name: 'P&G', market: 'US', freq: '분기배당', exMonths: [1, 4, 7, 10], color: '#003DA5', logo: 'P' },
  { symbol: 'XOM', code: 'XOM', name: '엑슨모빌', market: 'US', freq: '분기배당', exMonths: [2, 5, 8, 11], color: '#ED1C24', logo: 'X' },
  { symbol: 'CVX', code: 'CVX', name: '셰브론', market: 'US', freq: '분기배당', exMonths: [2, 5, 8, 11], color: '#0054A4', logo: 'C' },
  { symbol: 'JPM', code: 'JPM', name: 'JP모건', market: 'US', freq: '분기배당', exMonths: [1, 4, 7, 10], color: '#5A6E8C', logo: 'J' },
  { symbol: 'O', code: 'O', name: '리얼티인컴', market: 'US', freq: '월배당', exMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], color: '#0B3B60', logo: 'O' },
  { symbol: 'SCHD', code: 'SCHD', name: 'SCHD', market: 'US', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#5E2D91', logo: 'S' },
  { symbol: 'JEPI', code: 'JEPI', name: 'JEPI', market: 'US', freq: '월배당', exMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], color: '#7A5C3E', logo: 'J' },
  { symbol: 'JEPQ', code: 'JEPQ', name: 'JEPQ', market: 'US', freq: '월배당', exMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], color: '#283593', logo: 'J' },
  { symbol: 'VYM', code: 'VYM', name: 'VYM', market: 'US', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#8C1515', logo: 'V' },
  { symbol: 'VZ', code: 'VZ', name: '버라이즌', market: 'US', freq: '분기배당', exMonths: [1, 4, 7, 10], color: '#CD040B', logo: 'V' },
  { symbol: 'T', code: 'T', name: 'AT&T', market: 'US', freq: '분기배당', exMonths: [1, 4, 7, 10], color: '#00A8E0', logo: 'A' },
  { symbol: 'MO', code: 'MO', name: '알트리아', market: 'US', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#B2292E', logo: 'M' },
  { symbol: 'ABBV', code: 'ABBV', name: '애브비', market: 'US', freq: '분기배당', exMonths: [1, 4, 7, 10], color: '#071D49', logo: 'A' },
  { symbol: 'MCD', code: 'MCD', name: '맥도날드', market: 'US', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#DA291C', logo: 'M' },
  { symbol: 'HD', code: 'HD', name: '홈디포', market: 'US', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#F96302', logo: 'H' },
  { symbol: 'AVGO', code: 'AVGO', name: '브로드컴', market: 'US', freq: '분기배당', exMonths: [3, 6, 9, 12], color: '#CC0000', logo: '브' },
];

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSession() {
  const r1 = await fetch('https://fc.yahoo.com/', { headers: UA, redirect: 'manual' });
  const cookie = (r1.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('yahoo cookie 획득 실패');
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...UA, cookie },
  });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes('<')) throw new Error('yahoo crumb 획득 실패');
  return { cookie, crumb };
}

async function quoteSummary(session, symbol) {
  const modules = 'summaryDetail,calendarEvents,defaultKeyStatistics';
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    symbol
  )}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;
  try {
    const res = await fetch(url, { headers: { ...UA, cookie: session.cookie } });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.quoteSummary?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * chart API 한 번으로 배당 이력 + 월별 종가를 같이 받는다(요청 수를 늘리지 않으려고 한 번만 호출).
 * 실패하면 null — 호출부에서 새 필드를 생략한다.
 */
async function chartHistory(session, symbol) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5y&interval=1mo&events=div&crumb=${encodeURIComponent(session.crumb)}`;
  try {
    const res = await fetch(url, { headers: { ...UA, cookie: session.cookie } });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.chart?.result?.[0] ?? null;
  } catch {
    return null;
  }
}

/** epoch초 → 'YYYY-MM-DD' (UTC 기준. 배당락일·월봉 날짜는 Yahoo가 이미 거래일로 준다) */
const epochDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * 금액 자리수 — 파일을 앱이 통째로 받으므로 소수점을 최소로 줄인다.
 * 원화는 정수(231000), 달러는 소수 둘째 자리(0.26 / 313.33)면 표시에 충분하다.
 */
const money = (n, market) =>
  market === 'KR' ? Math.round(n) : Math.round(n * 100) / 100;

function parseHistory(meta, chart) {
  const divs = Object.values(chart?.events?.dividends ?? {})
    .map((d) => (typeof d?.amount === 'number' && typeof d?.date === 'number'
      ? { date: epochDate(d.date), amount: money(d.amount, meta.market) }
      : null))
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  const ts = chart?.timestamp ?? [];
  const closes = chart?.indicators?.quote?.[0]?.close ?? [];
  // 월봉의 마지막 봉은 "이번 달 진행 중" 값이라 매일 바뀐다.
  // 그대로 넣으면 asOf가 매일 갱신돼(내용이 늘 달라 보여서) 무의미 커밋이 다시 살아난다.
  const thisMonth = todayKST().slice(0, 7);
  const priceHistory = [];
  for (let i = 0; i < ts.length; i++) {
    const date = epochDate(ts[i]);
    if (date.slice(0, 7) >= thisMonth) continue;
    const c = closes[i];
    if (typeof c !== 'number' || !Number.isFinite(c)) continue;
    priceHistory.push({ date, close: money(c, meta.market) });
  }
  return {
    divHistory: divs.length > 0 ? divs : null,
    priceHistory: priceHistory.length > 0 ? priceHistory : null,
  };
}

const toDate = (raw) => {
  // Yahoo는 fmt('2026-08-11') 또는 epoch초를 준다
  const fmt = raw?.fmt;
  if (typeof fmt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fmt)) return fmt;
  const n = typeof raw === 'number' ? raw : raw?.raw;
  if (typeof n !== 'number') return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
};
/** 오늘 날짜(KST). 배당락일은 한국 거래일 기준이라 UTC로 자르면 하루가 밀린다. */
const todayKST = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const num = (raw) => {
  const n = typeof raw === 'number' ? raw : raw?.raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Yahoo 필드 단위(2026-08 실측, .fmt로 확인):
 *  - dividendYield / trailingAnnualDividendYield / payoutRatio → 소수 분수 (0.024 = 2.4%)
 *  - fiveYearAvgDividendYield                                  → 이미 퍼센트 (2.88 = 2.88%)
 *  - beta                                                      → 배수 그대로
 * 저장은 전부 "퍼센트 숫자"로 통일한다(payoutRatioPct: 62.5, fiveYearAvgYieldPct: 2.88).
 * 값이 없으면 null — 추정값을 넣지 않는다.
 */
const pct = (raw) => {
  const n = num(raw);
  return n == null ? null : Math.round(n * 1000) / 10;
};
const asIs1 = (raw) => {
  const n = num(raw);
  return n == null ? null : Math.round(n * 100) / 100;
};

function parseStock(meta, old, qs) {
  const sd = qs.summaryDetail ?? {};
  const ce = qs.calendarEvents ?? {};
  const ks = qs.defaultKeyStatistics ?? {};
  const exDate = toDate(ce.exDividendDate) ?? toDate(sd.exDividendDate);
  const payDate = toDate(ce.dividendDate);
  // Yahoo의 exDividendDate는 국내 종목에서 "직전" 배당락일을 돌려주는 경우가 많다(실측 37종목 중 21개).
  // 과거 날짜를 다음 일정이라고 단정하면 앱이 지난 날짜를 카운트다운한다.
  // 그래서 미래 날짜일 때만 nextExDate로 채택하고(nextExDateConfirmed=true),
  // 과거 날짜는 버리지 않고 lastExDate로 따로 남긴다 — 앱은 주기(exMonths)로 다음 회차를 추정해 '추정' 배지를 붙인다.
  const today = todayKST();
  const isFutureEx = exDate != null && exDate >= today;
  // 기존 값도 과거면 그대로 물려받지 않는다 — 예전 실행이 남긴 과거 날짜가 계속 살아남는다.
  const carriedEx = old?.nextExDate != null && old.nextExDate >= today ? old.nextExDate : null;
  const nextExDate = isFutureEx ? exDate : carriedEx;
  const lastExDate = !isFutureEx && exDate != null ? exDate : (old?.lastExDate ?? null);
  const divRate = num(sd.dividendRate) ?? num(sd.trailingAnnualDividendRate);
  const y = num(sd.dividendYield) ?? num(sd.trailingAnnualDividendYield);
  // 수집 실패 시 0으로 뭉개지 않는다 — null이어야 앱에서 "판단 불가"로 표시된다.
  const yieldPct = y != null ? Math.round(y * 1000) / 10 : (old?.yieldPct ?? null);
  if (exDate == null && divRate == null) return null; // 배당 정보가 전혀 없으면 실패 취급
  const payoutRatioPct = pct(sd.payoutRatio);
  const fiveYearAvgYieldPct = asIs1(sd.fiveYearAvgDividendYield);
  const trailingYieldPct = pct(sd.trailingAnnualDividendYield);
  const beta = asIs1(sd.beta) ?? asIs1(ks.beta);
  return {
    ...meta,
    symbol: undefined,
    yieldPct,
    nextExDate,
    nextExDateConfirmed: isFutureEx,
    lastExDate,
    nextPayDate: payDate ?? old?.nextPayDate ?? null,
    divRate: divRate ?? old?.divRate ?? null,
    payoutRatioPct: payoutRatioPct ?? old?.payoutRatioPct ?? null,
    fiveYearAvgYieldPct: fiveYearAvgYieldPct ?? old?.fiveYearAvgYieldPct ?? null,
    trailingYieldPct: trailingYieldPct ?? old?.trailingYieldPct ?? null,
    beta: beta ?? old?.beta ?? null,
  };
}

/**
 * 이력 배열만 한 줄로 압축해서 직렬화한다.
 * JSON.stringify(…, 2)는 {date, amount} 하나를 네 줄로 펼쳐서 이력 한 점이 60바이트 가까이 된다.
 * 앱이 매번 통째로 받는 파일이라 그대로 두면 크기가 두 배가 된다.
 * 문서 전체를 정규식으로 건드리면 기존 필드까지 위험하니, 배열을 자리표시자로 바꿔 넣고
 * 예쁘게 찍은 뒤 그 자리표시자만 압축 문자열로 되돌린다.
 */
function serializeHistory(out) {
  const compact = [];
  const marked = { ...out, stocks: {} };
  for (const [code, h] of Object.entries(out.stocks)) {
    const c = { ...h };
    for (const f of ['divHistory', 'priceHistory']) {
      if (Array.isArray(c[f])) {
        c[f] = `@@H${compact.length}@@`;
        compact.push(JSON.stringify(h[f]));
      }
    }
    marked.stocks[code] = c;
  }
  let text = JSON.stringify(marked, null, 2);
  compact.forEach((json, i) => {
    text = text.replace(`"@@H${i}@@"`, json);
  });
  return text + '\n';
}

async function main() {
  let prev = { stocks: [] };
  try {
    prev = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch {
    /* 최초 실행 */
  }
  const prevByCode = new Map((prev.stocks ?? []).map((s) => [s.code, s]));

  let prevHist = { stocks: {} };
  try {
    prevHist = JSON.parse(readFileSync(HIST_PATH, 'utf8'));
  } catch {
    /* 최초 실행 */
  }
  const prevHistByCode = prevHist.stocks ?? {};

  const session = await getSession();
  console.log('yahoo session OK');

  const stocks = [];
  const histOut = {};
  let updated = 0;
  for (const meta of UNIVERSE) {
    const old = prevByCode.get(meta.code);
    const oldHist = prevHistByCode[meta.code];
    const qs = await quoteSummary(session, meta.symbol);
    const parsed = qs ? parseStock(meta, old, qs) : null;
    if (parsed) {
      delete parsed.symbol;
      const chart = await chartHistory(session, meta.symbol);
      const h = chart ? parseHistory(meta, chart) : { divHistory: null, priceHistory: null };
      // 이력을 못 받으면 그 종목만 새 필드를 생략한다(기존 값이 있으면 물려받는다).
      const divHistory = h.divHistory ?? oldHist?.divHistory ?? null;
      const priceHistory = h.priceHistory ?? oldHist?.priceHistory ?? null;
      if (divHistory || priceHistory) {
        histOut[meta.code] = {};
        if (divHistory) histOut[meta.code].divHistory = divHistory;
        if (priceHistory) histOut[meta.code].priceHistory = priceHistory;
      }
      stocks.push(parsed);
      updated++;
      console.log(`OK   ${meta.symbol.padEnd(10)} div=${divHistory?.length ?? 0} px=${priceHistory?.length ?? 0} ex=${parsed.nextExDate} pay=${parsed.nextPayDate} rate=${parsed.divRate ?? '-'} yield=${parsed.yieldPct ?? '-'}% payout=${parsed.payoutRatioPct ?? '-'} avg5y=${parsed.fiveYearAvgYieldPct ?? '-'} beta=${parsed.beta ?? '-'}`);
    } else if (old) {
      // fetch 실패로 기존 값을 물려줄 때도 과거 배당락일은 그대로 두지 않는다(위와 같은 이유).
      // 이력은 새로 못 받았다고 버리지 않는다 — 그대로 물려준다.
      if (oldHist) histOut[meta.code] = oldHist;
      const stale = old.nextExDate != null && old.nextExDate < todayKST();
      stocks.push(
        stale
          ? { ...old, nextExDate: null, nextExDateConfirmed: false, lastExDate: old.nextExDate }
          : old
      );
      console.log(`KEEP ${meta.symbol} (fetch 실패 — 기존 값 유지)`);
    } else {
      console.log(`SKIP ${meta.symbol} (데이터 없음)`);
    }
    await sleep(500);
  }

  const nulls = (f) => stocks.filter((s) => s[f] == null).length;
  for (const f of ['yieldPct', 'payoutRatioPct', 'fiveYearAvgYieldPct', 'trailingYieldPct', 'beta'])
    console.log(`null ${f}: ${nulls(f)}/${stocks.length}`);

  // asOf를 매번 오늘로 덮으면 워크플로의 `git diff --quiet` 가드가 항상 뚫려 내용이 같아도 매일 커밋된다.
  // 그래서 stocks가 실제로 달라졌을 때만 갱신한다(배열 순서는 UNIVERSE 순서, 키 순서는 고정이라 문자열 비교로 충분).
  const changed = JSON.stringify(stocks) !== JSON.stringify(prev.stocks ?? []);
  const out = { asOf: changed ? todayKST() : (prev.asOf ?? todayKST()), stocks };
  if (!changed) console.log('stocks 변화 없음 — asOf 유지');
  writeFileSync(DATA_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\ndividends.json 갱신 완료 — ${updated}/${UNIVERSE.length}종목, asOf=${out.asOf}`);

  // history.json도 같은 가드 — 이력은 대부분의 날에 그대로라 매번 asOf를 덮으면 무의미 커밋이 된다.
  const histChanged = JSON.stringify(histOut) !== JSON.stringify(prevHistByCode);
  const histFile = {
    asOf: histChanged ? todayKST() : (prevHist.asOf ?? todayKST()),
    stocks: histOut,
  };
  if (!histChanged) console.log('history 변화 없음 — asOf 유지');
  writeFileSync(HIST_PATH, serializeHistory(histFile), 'utf8');
  console.log(`history.json 갱신 완료 — ${Object.keys(histOut).length}종목, asOf=${histFile.asOf}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
