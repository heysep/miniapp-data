/**
 * 공탐지수 조건부 알림 발송기.
 *
 *   node gongtam/dispatch-alerts.mjs
 *
 * 크롤링 직후 같은 워크플로에서 돈다. 방금 갱신한 seed.json을 그대로 읽어
 * 임계값에 닿은 구독자에게만 토스 푸시를 쏜다.
 *
 * 왜 여기(Actions)인가: 토스 파트너 API는 클라이언트 인증서 mTLS다.
 * Node는 https.Agent로 바로 되지만 Supabase Edge(Deno)는 클라이언트 인증서
 * 지원이 불확실했다. 매시간 크론도 이미 여기 있어 붙일 곳이 하나 준다.
 *
 * 필요한 시크릿
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — 구독 조회·발송 기록
 *   TOSS_CERT, TOSS_CERT_KEY                 — mTLS 인증서/키 (PEM 본문)
 *   PUSH_CODE                                — 발송 코드(기본 omok-jangin-alert)
 * 하나라도 없으면 아무 일도 하지 않고 정상 종료한다(크롤링을 막지 않는다).
 */
import { readFileSync } from 'node:fs';
import https from 'node:https';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const CERT = process.env.TOSS_CERT ?? '';
const CERT_KEY = process.env.TOSS_CERT_KEY ?? '';
const PUSH_CODE = process.env.PUSH_CODE ?? 'omok-jangin-alert';
const PUSH_URL =
  'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/messenger/send-message';

const LABEL = { global: '글로벌', kospi: '코스피', crypto: '암호화폐' };
const MARKETS = ['global', 'kospi', 'crypto'];

if (SUPABASE_URL === '' || SERVICE_KEY === '' || CERT === '' || CERT_KEY === '') {
  console.log('알림 시크릿 미설정 — 발송 건너뜀');
  process.exit(0);
}

/** 같은 구간에 머무는 동안 하루 한 번까지만. 구간을 벗어났다 오면 다시 보낸다. */
function shouldSend(sub, kind, now) {
  if (sub.push_key === null || sub.push_key === '') return false;
  if (sub.last_kind !== kind) return true;
  if (sub.last_sent_at === null) return true;
  return now - new Date(sub.last_sent_at).getTime() > 20 * 60 * 60 * 1000;
}

const db = (path, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

const snap = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));
for (const m of MARKETS) {
  const v = snap[m]?.now;
  if (typeof v !== 'number' || v < 0 || v > 100) throw new Error(`${m} 값 이상: ${v}`);
}

const subsRes = await db('gongtam_alert_subs?select=*&push_key=not.is.null');
if (!subsRes.ok) throw new Error(`구독 조회 실패 ${subsRes.status}`);
const subs = await subsRes.json();

const now = Date.now();
const targets = [];
for (const sub of subs) {
  const value = snap[sub.market]?.now;
  if (typeof value !== 'number') continue;
  const kind = value <= sub.fear ? 'fear' : value >= sub.greed ? 'greed' : null;
  if (kind === null || !shouldSend(sub, kind, now)) continue;
  targets.push({ sub, kind, value });
}

// 인증서 CN으로 미니앱을 식별하므로 별도 토큰 헤더가 없다.
// 대상은 x-anon-key(앱의 getAnonymousKey 값)로 한 명씩 지정한다.
//
// 전역 fetch(undici)는 https.Agent를 무시해 클라이언트 인증서가 실리지 않는다.
// mTLS가 필요하므로 node:https로 직접 쏜다.
const agent = new https.Agent({ cert: CERT, key: CERT_KEY, keepAlive: true });

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', agent, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = {};
        try {
          json = JSON.parse(buf);
        } catch {
          /* 본문이 JSON이 아니면 상태코드로만 판단한다 */
        }
        resolve({ status: res.statusCode ?? 0, body: json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

let sent = 0;
const failed = [];
for (const { sub, kind, value } of targets) {
  try {
    const { status, body } = await post(
      PUSH_URL,
      { 'x-anon-key': sub.push_key, 'Content-Type': 'application/json' },
      JSON.stringify({
        templateSetCode: PUSH_CODE,
        context: {
          market: LABEL[sub.market],
          value: String(value),
          edge: String(kind === 'fear' ? sub.fear : sub.greed),
          side: kind === 'fear' ? '이하' : '이상',
        },
      }),
    );
    // HTTP 200이어도 봉투가 FAIL일 수 있다. resultType까지 봐야 진짜 성공이다.
    if (status !== 200 || body?.resultType !== 'SUCCESS') {
      failed.push(`${sub.market}:${status}:${body?.error?.errorCode ?? '?'}`);
      continue;
    }
    sent++;
    await db(
      `gongtam_alert_subs?device_key=eq.${encodeURIComponent(sub.device_key)}&market=eq.${sub.market}`,
      { method: 'PATCH', body: JSON.stringify({ last_sent_at: new Date(now).toISOString(), last_kind: kind }) },
    );
  } catch (e) {
    failed.push(`${sub.market}:${String(e)}`);
  }
}

console.log(
  `구독 ${subs.length} · 조건충족 ${targets.length} · 발송 ${sent}` +
    (failed.length ? ` · 실패 ${failed.length} (${failed.slice(0, 5).join(', ')})` : ''),
);
