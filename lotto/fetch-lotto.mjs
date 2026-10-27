#!/usr/bin/env node
/**
 * 로또 6/45 당첨번호·등위별 당첨금 수집 → lotto.json
 *
 * miniapp-data 저장소에서는 lotto/fetch-lotto.mjs 로 두고 `node lotto/fetch-lotto.mjs` 로 돌린다
 * (기본 출력은 스크립트 옆 lotto.json). 앱 스냅샷은
 * `node data-pipeline/fetch-lotto.mjs --out src/data/lotto-snapshot.json` 으로 굽는다.
 *
 * 출처(2026-10-28 curl 확인):
 * - 최신 회차: https://www.dhlottery.co.kr/lt645/result HTML 의 회차 select value 최댓값.
 *   아래 API 는 최신 회차를 알려주지 않는다(커서가 최신+1 이면 빈 목록).
 * - 회차 데이터: /lt645/selectPstLt645InfoNew.do?srchDir=center&srchLtEpsd=N&srchCursorLtEpsd=N
 *   → data.list[] 10개, 회차 N+4 ~ N-5. 필드 ltEpsd, tm1WnNo~tm6WnNo, bnsWnNo, ltRflYmd(YYYYMMDD),
 *     rnk1WnNope~rnk5WnNope(당첨자 수), rnk1WnAmt~rnk5WnAmt(1인당 당첨금, 세전).
 * - 구 API(common.do?method=getLottoNumber)는 302 로 홈에 튕긴다. 쓰지 않는다.
 *
 * 비공개 내부 API 라 언제든 바뀔 수 있다. 응답 구조가 하나라도 어긋나면 파일을 쓰지 않고
 * exit 1 — 앱은 직전 파일(또는 번들 스냅샷)로 계속 돈다. 잘못된 번호를 내보내는 것보다 낫다.
 *
 * 증분: 기존 파일이 온전하면 (기존 최신-10) 회차부터만 다시 받는다(추첨 직후 비어 있던
 * 당첨금을 다음 실행이 채우도록 겹쳐 받는다). 없거나 깨졌으면 1회차부터 전부(약 125회 요청).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 ? resolve(process.argv[argOut + 1]) : join(HERE, 'lotto.json');
const FULL = process.argv.includes('--full');

const BASE = 'https://www.dhlottery.co.kr';
const UA = 'Mozilla/5.0 (compatible; miniapp-data/1.0; +https://github.com/heysep/miniapp-data)';
/** 당첨금을 파일에 남기는 최근 회차 수 — 번호는 전 회차, 당첨금은 최근 2년만(용량). */
const PRIZE_KEEP = 104;
/** 이 회차 수보다 적게 모이면 이상하다 — 2026-10 기준 1247회. */
const MIN_DRAWS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) {
  console.error(`[fetch-lotto] 실패: ${msg} — 파일을 쓰지 않았어요`);
  process.exit(1);
}

async function get(url, kind) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: kind === 'json' ? 'application/json' : 'text/html' }, redirect: 'manual' });
      if (res.status !== 200) throw new Error(`HTTP ${res.status} ${url}`);
      return kind === 'json' ? await res.json() : await res.text();
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

async function latestEpisode() {
  const html = await get(`${BASE}/lt645/result`, 'text');
  const vals = [...html.matchAll(/<option[^>]*value="(\d{3,5})"/g)].map((m) => Number(m[1]));
  if (vals.length === 0) fail('/lt645/result 에서 회차 select 를 못 찾았어요(페이지 구조 변경?)');
  return Math.max(...vals);
}

const isNum = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** API 한 줄 → [회차, 'YYYY-MM-DD', n1..n6, 보너스] + 당첨금. 어긋나면 fail. */
function parseRow(r) {
  const ep = r?.ltEpsd;
  if (!isNum(ep, 1, 99999)) fail(`ltEpsd 형식 이상: ${JSON.stringify(r)?.slice(0, 200)}`);
  const nums = [r.tm1WnNo, r.tm2WnNo, r.tm3WnNo, r.tm4WnNo, r.tm5WnNo, r.tm6WnNo];
  const bonus = r.bnsWnNo;
  if (!nums.every((n) => isNum(n, 1, 45)) || !isNum(bonus, 1, 45)) fail(`${ep}회 번호 범위 이상`);
  if (new Set([...nums, bonus]).size !== 7) fail(`${ep}회 번호 중복`);
  const ymd = String(r.ltRflYmd ?? '');
  if (!/^\d{8}$/.test(ymd)) fail(`${ep}회 ltRflYmd 형식 이상: ${ymd}`);
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const sorted = [...nums].sort((a, b) => a - b);
  // 당첨금: [1등 인원, 1등 1인당, … 5등 인원, 5등 1인당]. 추첨 직후엔 비어 있을 수 있다 → null.
  const prize = [];
  for (let k = 1; k <= 5; k++) prize.push(r[`rnk${k}WnNope`], r[`rnk${k}WnAmt`]);
  // 5등은 고정 5,000원. 0 이면 아직 집계 전이다.
  const prizeOk = prize.every(isCount) && r.rnk5WnAmt === 5000 && r.rnk4WnAmt === 50000;
  return { ep, row: [ep, date, ...sorted, bonus], prize: prizeOk ? prize : null };
}

function loadExisting() {
  try {
    const o = JSON.parse(readFileSync(OUT, 'utf8'));
    if (o?.v === 1 && Array.isArray(o.draws) && o.draws.length >= MIN_DRAWS) return o;
  } catch {
    /* 없음·깨짐 → 전체 수집 */
  }
  return null;
}

async function main() {
  const latest = await latestEpisode();
  if (latest < MIN_DRAWS) fail(`최신 회차가 ${latest} — 너무 작아요`);

  const prev = FULL ? null : loadExisting();
  /** ep → row */
  const rows = new Map();
  /** ep → prize */
  const prizes = new Map();
  if (prev) {
    for (const r of prev.draws) rows.set(r[0], r);
    for (const [k, v] of Object.entries(prev.prizes ?? {})) prizes.set(Number(k), v);
  }
  const from = prev ? Math.max(1, Math.min(prev.latest, latest) - 10) : 1;

  // center 커서 c 는 c+4 ~ c-5 를 준다. 위에서부터 10씩 내려간다.
  let requests = 0;
  for (let c = latest - 4; c + 4 >= from; c -= 10) {
    const cur = Math.max(1, c);
    const j = await get(`${BASE}/lt645/selectPstLt645InfoNew.do?srchDir=center&srchLtEpsd=${cur}&srchCursorLtEpsd=${cur}`, 'json');
    requests++;
    const list = j?.data?.list;
    if (!Array.isArray(list) || list.length === 0) fail(`커서 ${cur} 응답에 data.list 가 없어요: ${JSON.stringify(j)?.slice(0, 200)}`);
    for (const r of list) {
      const p = parseRow(r);
      rows.set(p.ep, p.row);
      if (p.prize) prizes.set(p.ep, p.prize);
    }
    if (cur === 1) break;
    await sleep(250);
  }

  // 1 ~ latest 가 빠짐없이 있어야 한다
  for (let e = 1; e <= latest; e++) if (!rows.has(e)) fail(`${e}회가 비어 있어요`);
  const draws = [...rows.values()].filter((r) => r[0] <= latest).sort((a, b) => a[0] - b[0]);
  if (draws.length !== latest) fail(`회차 수 ${draws.length} ≠ 최신 ${latest}`);
  // 날짜는 회차 순으로 증가해야 한다
  for (let i = 1; i < draws.length; i++) if (draws[i][1] <= draws[i - 1][1]) fail(`${draws[i][0]}회 날짜 역전`);

  const keepFrom = latest - PRIZE_KEEP + 1;
  const prizeOut = {};
  for (const [ep, p] of [...prizes.entries()].sort((a, b) => a[0] - b[0])) if (ep >= keepFrom && ep <= latest) prizeOut[ep] = p;

  const out = {
    v: 1,
    source: 'dhlottery.co.kr',
    latest,
    // 앱이 원격·스냅샷 중 신선한 쪽을 고를 때 latest 를 먼저, 같으면 prizes 개수를 본다
    draws,
    prizes: prizeOut,
  };
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
  console.log(`[fetch-lotto] 최신 ${latest}회 (${draws[draws.length - 1][1]}) · 요청 ${requests}회 · 당첨금 ${Object.keys(prizeOut).length}회차 · ${same ? '변경 없음' : `썼어요 ${text.length}B → ${OUT}`}`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
