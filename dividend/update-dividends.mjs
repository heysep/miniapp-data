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
 * GitHub Actions에서 매일 실행 → 변경 시 커밋 (.github/workflows/update-dividends.yml)
 * 사용: node dividend/update-dividends.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'dividends.json');

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

const toDate = (raw) => {
  // Yahoo는 fmt('2026-08-11') 또는 epoch초를 준다
  const fmt = raw?.fmt;
  if (typeof fmt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fmt)) return fmt;
  const n = typeof raw === 'number' ? raw : raw?.raw;
  if (typeof n !== 'number') return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
};
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
    nextExDate: exDate ?? old?.nextExDate ?? null,
    nextPayDate: payDate ?? old?.nextPayDate ?? null,
    divRate: divRate ?? old?.divRate ?? null,
    payoutRatioPct: payoutRatioPct ?? old?.payoutRatioPct ?? null,
    fiveYearAvgYieldPct: fiveYearAvgYieldPct ?? old?.fiveYearAvgYieldPct ?? null,
    trailingYieldPct: trailingYieldPct ?? old?.trailingYieldPct ?? null,
    beta: beta ?? old?.beta ?? null,
  };
}

async function main() {
  let prev = { stocks: [] };
  try {
    prev = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch {
    /* 최초 실행 */
  }
  const prevByCode = new Map((prev.stocks ?? []).map((s) => [s.code, s]));

  const session = await getSession();
  console.log('yahoo session OK');

  const stocks = [];
  let updated = 0;
  for (const meta of UNIVERSE) {
    const old = prevByCode.get(meta.code);
    const qs = await quoteSummary(session, meta.symbol);
    const parsed = qs ? parseStock(meta, old, qs) : null;
    if (parsed) {
      delete parsed.symbol;
      stocks.push(parsed);
      updated++;
      console.log(`OK   ${meta.symbol.padEnd(10)} ex=${parsed.nextExDate} pay=${parsed.nextPayDate} rate=${parsed.divRate ?? '-'} yield=${parsed.yieldPct ?? '-'}% payout=${parsed.payoutRatioPct ?? '-'} avg5y=${parsed.fiveYearAvgYieldPct ?? '-'} beta=${parsed.beta ?? '-'}`);
    } else if (old) {
      stocks.push(old);
      console.log(`KEEP ${meta.symbol} (fetch 실패 — 기존 값 유지)`);
    } else {
      console.log(`SKIP ${meta.symbol} (데이터 없음)`);
    }
    await sleep(400);
  }

  const nulls = (f) => stocks.filter((s) => s[f] == null).length;
  for (const f of ['yieldPct', 'payoutRatioPct', 'fiveYearAvgYieldPct', 'trailingYieldPct', 'beta'])
    console.log(`null ${f}: ${nulls(f)}/${stocks.length}`);

  const out = { asOf: new Date().toISOString().slice(0, 10), stocks };
  writeFileSync(DATA_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\ndividends.json 갱신 완료 — ${updated}/${UNIVERSE.length}종목, asOf=${out.asOf}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
