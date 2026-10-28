#!/usr/bin/env node
/**
 * 연금복권720+ 당첨번호 수집 → pension720.json
 *
 * miniapp-data 저장소에서는 pension720/fetch-pension.mjs 로 두고 `node pension720/fetch-pension.mjs` 로 돌린다
 * (기본 출력은 스크립트 옆 pension720.json). 앱 스냅샷은
 * `node data-pipeline/fetch-pension.mjs --out src/data/pension-snapshot.json` 으로 굽는다.
 *
 * 출처(2026-10-28 curl 확인, https://www.dhlottery.co.kr/pt720/result 페이지 스크립트에서 찾음):
 * - 전 회차 목록: /pt720/selectPstPt720WnList.do → data.result[] 에 1회부터 최신까지 한 번에 온다(338개).
 *   필드 psltEpsd(회차), psltRflYmd(YYYYMMDD), wnBndNo(1등 조, "1"~"5"), wnRnkVl(1등 6자리), bnsRnkVl(보너스 6자리).
 *   6자리는 앞자리 0 이 있다("022049") — 숫자로 바꾸면 깨진다. 문자열 그대로 둔다.
 * - 회차별 등위 당첨금: /pt720/selectPstPt720Info.do?srchPsltEpsd=N → wnSqNo 1~7, 21(보너스)의 wnAmt.
 *   1·100·250·338회 모두 1등 1,680,000,000 / 2등 120,000,000 / 3등 1,000,000 / 4등 100,000 / 5등 50,000 /
 *   6등 5,000 / 7등 1,000 / 보너스 120,000,000 으로 같았다. 앱은 이 값을 상수로 쓰므로 최신 회차에서 다시 대조하고,
 *   다르면 실패한다(규칙이 바뀌었는데 옛 금액을 보여주지 않게).
 * - 구 API(gameResult.do?method=win720)는 302 로 errorPage 에 튕긴다. 쓰지 않는다.
 *
 * 비공개 내부 API 라 언제든 바뀔 수 있다. 응답 구조가 하나라도 어긋나면 파일을 쓰지 않고
 * exit 1 — 앱은 직전 파일(또는 번들 스냅샷)로 계속 돈다. 잘못된 번호를 내보내는 것보다 낫다.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 ? resolve(process.argv[argOut + 1]) : join(HERE, 'pension720.json');

const BASE = 'https://www.dhlottery.co.kr';
const UA = 'Mozilla/5.0 (compatible; miniapp-data/1.0; +https://github.com/heysep/miniapp-data)';
/** 이 회차 수보다 적으면 이상하다 — 2026-10 기준 338회. */
const MIN_DRAWS = 330;
/** 1회 추첨일(목). 이후 매주 목요일 — 1~338회 전부 7일 간격인 것을 확인했다. */
const EP1_UTC = Date.UTC(2020, 4, 7);
const DAY = 86_400_000;
/** wnSqNo → 1인당 당첨금(세전). 1·2등·보너스는 연금식 총액(월 지급액 × 개월 수). 앱 src/core/pension.ts PRIZES 와 같아야 한다. */
const EXPECTED_AMT = { 1: 1_680_000_000, 2: 120_000_000, 3: 1_000_000, 4: 100_000, 5: 50_000, 6: 5_000, 7: 1_000, 21: 120_000_000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) {
  console.error(`[fetch-pension] 실패: ${msg} — 파일을 쓰지 않았어요`);
  process.exit(1);
}

async function getJson(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        redirect: 'manual',
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

const SIX = /^\d{6}$/;

/** API 한 줄 → [회차, 'YYYY-MM-DD', 1등 조, '1등 6자리', '보너스 6자리']. 어긋나면 fail. */
function parseRow(r) {
  const ep = r?.psltEpsd;
  if (!Number.isInteger(ep) || ep < 1 || ep > 99999) fail(`psltEpsd 형식 이상: ${JSON.stringify(r)?.slice(0, 200)}`);
  const ymd = String(r.psltRflYmd ?? '');
  if (!/^\d{8}$/.test(ymd)) fail(`${ep}회 psltRflYmd 형식 이상: ${ymd}`);
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const expectDate = new Date(EP1_UTC + (ep - 1) * 7 * DAY).toISOString().slice(0, 10);
  if (date !== expectDate) fail(`${ep}회 날짜 ${date} ≠ 매주 목요일 계산 ${expectDate}`);
  const jo = Number(r.wnBndNo);
  if (!/^[1-5]$/.test(String(r.wnBndNo ?? ''))) fail(`${ep}회 wnBndNo(조) 형식 이상: ${r.wnBndNo}`);
  if (typeof r.wnRnkVl !== 'string' || !SIX.test(r.wnRnkVl)) fail(`${ep}회 1등 번호 형식 이상: ${r.wnRnkVl}`);
  if (typeof r.bnsRnkVl !== 'string' || !SIX.test(r.bnsRnkVl)) fail(`${ep}회 보너스 번호 형식 이상: ${r.bnsRnkVl}`);
  return [ep, date, jo, r.wnRnkVl, r.bnsRnkVl];
}

async function main() {
  const j = await getJson(`${BASE}/pt720/selectPstPt720WnList.do`);
  const list = j?.data?.result;
  if (!Array.isArray(list) || list.length < MIN_DRAWS) fail(`data.result 가 없거나 ${MIN_DRAWS}개 미만: ${JSON.stringify(j)?.slice(0, 200)}`);

  const rows = new Map();
  for (const r of list) {
    const row = parseRow(r);
    if (rows.has(row[0])) fail(`${row[0]}회가 두 번 왔어요`);
    rows.set(row[0], row);
  }
  const latest = Math.max(...rows.keys());
  for (let e = 1; e <= latest; e++) if (!rows.has(e)) fail(`${e}회가 비어 있어요`);
  const draws = [...rows.values()].sort((a, b) => a[0] - b[0]);
  if (draws.length !== latest) fail(`회차 수 ${draws.length} ≠ 최신 ${latest}`);

  // 최신 회차 당첨금 표가 앱 상수와 같은지 — 다르면 규칙이 바뀐 것이다
  await sleep(250);
  const info = await getJson(`${BASE}/pt720/selectPstPt720Info.do?srchPsltEpsd=${latest}`);
  const items = info?.data?.result;
  if (!Array.isArray(items) || items.length === 0) fail(`${latest}회 당첨금 응답이 비어 있어요`);
  const mine = items.filter((x) => x?.psltEpsd === latest);
  if (mine.length === 0) fail(`${latest}회 당첨금 응답에 그 회차가 없어요`);
  for (const [sq, amt] of Object.entries(EXPECTED_AMT)) {
    const hit = mine.find((x) => x.wnSqNo === Number(sq));
    if (!hit) fail(`${latest}회 wnSqNo ${sq} 가 없어요`);
    if (hit.wnAmt !== amt) fail(`${latest}회 wnSqNo ${sq} 당첨금 ${hit.wnAmt} ≠ ${amt} — 당첨금 규칙이 바뀌었는지 확인하세요`);
  }
  // 당첨금 응답의 1등 번호가 목록과 같아야 한다(두 API 가 같은 회차를 말하는지)
  const first = mine.find((x) => x.wnSqNo === 1);
  if (first.wnRnkVl !== draws[latest - 1][3] || String(first.wnBndNo) !== String(draws[latest - 1][2]))
    fail(`${latest}회 1등 번호가 두 API 에서 달라요: ${first.wnBndNo}조 ${first.wnRnkVl} vs ${draws[latest - 1][2]}조 ${draws[latest - 1][3]}`);

  const out = { v: 1, source: 'dhlottery.co.kr', latest, draws };
  // 실제 내용이 같으면 파일을 건드리지 않는다(워크플로가 빈 커밋을 만들지 않게). 시각 필드를 두지 않는 이유.
  const text = JSON.stringify(out);
  let same = false;
  try {
    same = readFileSync(OUT, 'utf8') === text;
  } catch {
    /* 새 파일 */
  }
  if (!same) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, text);
  }
  const d = draws[latest - 1];
  console.log(`[fetch-pension] 최신 ${latest}회 (${d[1]}) ${d[2]}조 ${d[3]} · 보너스 ${d[4]} · ${same ? '변경 없음' : `썼어요 ${text.length}B → ${OUT}`}`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
