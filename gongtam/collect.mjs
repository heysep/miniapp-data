/**
 * 공탐지수 데이터 수집기.
 *
 *   node scripts/collect.mjs > src/data/seed.json
 *
 * 브라우저에서 직접 못 부르는 소스를 여기서 모아 정적 JSON으로 만든다.
 * - 글로벌: CNN Fear & Greed. 공식 API가 아니라 dataviz 엔드포인트이고
 *   봇을 막으므로 브라우저와 같은 헤더가 필요하다(없으면 "I'm a teapot").
 * - 암호화폐: alternative.me 공개 API. 이쪽은 CORS가 열려 있어 앱에서 직접도 부른다.
 * - 코스피: 공식 공포탐욕지수가 존재하지 않는다. 아래 산출식으로 직접 만든다.
 *
 * 이 파일이 만드는 JSON에는 사용자 정보가 하나도 없다. 공개 시세만 담는다.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n) => Math.round(n);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 야후는 429를 자주 뱉는다. 호스트를 번갈아 쓰고 지수 백오프로 재시도한다. */
async function getJson(url, headers = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const u = i % 2 === 1 ? url.replace('query1.', 'query2.') : url;
    try {
      const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
      if (res.ok) return res.json();
      lastErr = new Error(`${res.status} ${u}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(1500 * 2 ** i);
  }
  throw lastErr;
}

/** CNN Fear & Greed — 현재값과 비교값, 그리고 과거 시계열 */
async function global() {
  const j = await getJson('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    Referer: 'https://edition.cnn.com/',
    Origin: 'https://edition.cnn.com',
  });
  const f = j.fear_and_greed;
  const hist = (j.fear_and_greed_historical?.data ?? []).map((d) => ({
    t: Math.floor(d.x / 1000),
    v: round(d.y),
  }));
  return {
    now: round(f.score),
    prev: { day: round(f.previous_close), week: round(f.previous_1_week), month: round(f.previous_1_month), year: round(f.previous_1_year) },
    history: hist,
  };
}

/** alternative.me Crypto Fear & Greed */
async function crypto() {
  const j = await getJson('https://api.alternative.me/fng/?limit=2000&format=json');
  const rows = j.data.map((d) => ({ t: Number(d.timestamp), v: Number(d.value) })).sort((a, b) => a.t - b.t);
  const at = (daysAgo) => {
    const target = rows[rows.length - 1].t - daysAgo * 86400;
    let best = rows[0];
    for (const r of rows) if (Math.abs(r.t - target) < Math.abs(best.t - target)) best = r;
    return best.v;
  };
  return {
    now: rows[rows.length - 1].v,
    prev: { day: at(1), week: at(7), month: at(30), year: at(365) },
    history: rows,
  };
}

/**
 * 코스피 공포탐욕지수 — 직접 산출.
 *
 * CNN이 7개 지표를 쓰는 것을 국내에서 구할 수 있는 것만으로 좁혀 3개를 쓴다.
 * 각 지표를 0~100으로 정규화해 단순 평균한다. 가중치를 임의로 주면 근거를 댈 수 없어
 * 동일 가중으로 둔다.
 *
 *  1) 모멘텀 — 종가가 125일 이동평균에서 얼마나 위/아래인가 (±10%를 0~100에 대응)
 *  2) 변동성 — 최근 20일 변동성이 1년 변동성 대비 낮으면 탐욕, 높으면 공포
 *  3) 강도   — 최근 20일 중 오른 날의 비율
 */
function kospiIndex(closes) {
  const n = closes.length;
  const last = closes[n - 1];

  const ma125 = closes.slice(-125).reduce((s, c) => s + c, 0) / Math.min(125, n);
  const momentum = clamp(((last / ma125 - 1) / 0.1) * 50 + 50, 0, 100);

  const rets = [];
  for (let i = 1; i < n; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const sd = (arr) => {
    const m = arr.reduce((s, x) => s + x, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  };
  const vol20 = sd(rets.slice(-20));
  const vol250 = sd(rets.slice(-250));
  // 단기 변동성이 장기보다 낮으면 시장이 편안하다는 뜻이라 탐욕 쪽
  const volatility = clamp((1 - vol20 / (vol250 || vol20 || 1)) * 50 + 50, 0, 100);

  const up = rets.slice(-20).filter((r) => r > 0).length;
  const strength = (up / 20) * 100;

  return round((momentum + volatility + strength) / 3);
}

/**
 * 코스피 일봉. 야후는 429를 상시로 뱉어 쓸 수 없어 네이버를 쓴다.
 * 응답이 정식 JSON이 아니라 작은따옴표 섞인 JS 배열 리터럴이라 손으로 파싱한다.
 */
async function kospiDaily() {
  const end = new Date();
  const start = new Date(end.getTime() - 6 * 365 * 86400_000);
  const fmt = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const res = await fetch(
    `https://api.finance.naver.com/siseJson.naver?symbol=KOSPI&requestType=1&startTime=${fmt(start)}&endTime=${fmt(end)}&timeframe=day`,
    { headers: { 'User-Agent': UA } }
  );
  if (!res.ok) throw new Error(`naver ${res.status}`);
  const text = await res.text();
  const rows = [];
  for (const m of text.matchAll(/\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/g)) {
    const [, d, , , , close] = m;
    const t = Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 1000);
    rows.push({ t, c: Number(close) });
  }
  if (rows.length < 300) throw new Error(`코스피 데이터가 너무 적다: ${rows.length}일`);
  return rows;
}

async function kospi() {
  const rows = await kospiDaily();

  const history = [];
  // 250일치가 쌓인 시점부터 지수를 만든다
  for (let i = 250; i < rows.length; i++) {
    history.push({ t: rows[i].t, v: kospiIndex(rows.slice(0, i + 1).map((x) => x.c)) });
  }
  const at = (daysAgo) => {
    const target = history[history.length - 1].t - daysAgo * 86400;
    let best = history[0];
    for (const h of history) if (Math.abs(h.t - target) < Math.abs(best.t - target)) best = h;
    return best.v;
  };
  return {
    now: history[history.length - 1].v,
    prev: { day: at(1), week: at(7), month: at(30), year: at(365) },
    history,
  };
}

const [g, c, k] = await Promise.all([global(), crypto(), kospi()]);
process.stdout.write(
  JSON.stringify({ asOf: Math.floor(Date.now() / 1000), global: g, kospi: k, crypto: c })
);
