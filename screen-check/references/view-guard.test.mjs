// 실행: node --test references/view-guard.test.mjs
// 고정하는 것 = 「보기 전용 방식은 비로컬 주소에서 풀 수 없고, 쓰기 요청은 허용 목록 밖이면 전부 막히며, 개발 QA 계정으로 대체하지 않는다」.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isLocalHost, resolveMode, assertWritableBase, normalizeConfig, decideRequest, decideWebSocket, decideWsMessage,
  destructiveMatcher, shouldSkipControl, selectViewCredentials, credentialKeysFor, redact, notAssessable,
} from './view-guard.mjs'

const SB = 'https://abc.supabase.example'          // Supabase 형태의 가짜 주소
const cfg = normalizeConfig({ readOnlyRpc: { list_my_tickets: 'STABLE 함수 — SELECT 만 한다' }, readOnlyFunctions: { 'report-view': '집계 읽기 — 저장 없음' }, allowPost: { '/storage/v1/object/list/*': '첨부 목록 조회(POST 로 읽기)' } })
const req = (method, url, tier = 'view-login', config = cfg) => decideRequest({ method, url, tier, config })

// ── 주소 분류 ─────────────────────────────────────────────
test('로컬 개발 주소 다섯 형태만 로컬이다', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', '::1', 'app.localhost', 'shop.test', 'LOCALHOST', 'localhost.']) assert.ok(isLocalHost(h), h)
  for (const h of ['example.com', 'localhost.example.com', '127.0.0.2', '10.0.0.5', '192.168.0.10', '127.0.0.1.nip.io', 'my-app.workers.dev', 'test', 'mytest', '', undefined]) assert.ok(!isLocalHost(h), String(h))
})

test('비로컬 주소는 무엇을 요청해도 보기 전용으로 강제된다', () => {
  for (const requested of [undefined, '', 'auto', 'local', 'view', 'LOCAL']) {
    const r = resolveMode({ base: 'https://abc123-app.demo.workers.dev/', requested })
    assert.equal(r.mode, 'view', String(requested))
  }
  assert.equal(resolveMode({ base: 'https://prod.example.com', requested: 'local' }).forced, true)
  assert.match(resolveMode({ base: 'https://prod.example.com', requested: 'local' }).note, /강제/)
})

test('로컬 주소는 기본 local · 명시하면 view', () => {
  assert.equal(resolveMode({ base: 'http://127.0.0.1:5174' }).mode, 'local')
  assert.equal(resolveMode({ base: 'http://[::1]:5174', requested: 'view' }).mode, 'view')
  assert.throws(() => resolveMode({ base: 'http://127.0.0.1:5174', requested: 'write' }), /알 수 없는 방식/)
  assert.throws(() => resolveMode({ base: 'not a url' }), /해석하지 못함/)
  assert.throws(() => resolveMode({ base: 'ftp://127.0.0.1/' }), /http\(s\)/)
})

test('쓰기 프로브 방식(lib.mjs·template.mjs)은 비로컬·SC_MODE=view 에서 멈춘다', () => {
  assert.doesNotThrow(() => assertWritableBase('http://127.0.0.1:5174', {}))
  assert.doesNotThrow(() => assertWritableBase('http://127.0.0.1:5174', { SC_MODE: 'local' }))
  assert.throws(() => assertWritableBase('https://prod.example.com', { SC_MODE: 'local' }), /로컬 개발 주소에서만/)
  assert.throws(() => assertWritableBase('https://preview-1.app.workers.dev', {}), /비로컬/)
  assert.throws(() => assertWritableBase('http://127.0.0.1:5174', { SC_MODE: 'view' }), /SC_MODE=view/)
})

// ── 요청 판정 ─────────────────────────────────────────────
test('읽기 메서드는 통과, 쓰기 메서드는 차단', () => {
  for (const m of ['GET', 'head', 'OPTIONS']) assert.ok(req(m, `${SB}/rest/v1/tickets?select=*`).allow, m)
  for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.ok(!req(m, `${SB}/rest/v1/tickets`).allow, m)
  assert.ok(!req('POST', 'https://prod.example.com/api/anything').allow)
})

test('로그인·토큰 갱신만 허용 — 다른 로그인 방식·로그아웃·가입은 차단', () => {
  assert.ok(req('POST', `${SB}/auth/v1/token?grant_type=password`).allow)
  assert.ok(req('POST', `${SB}/auth/v1/token?grant_type=refresh_token`).allow)
  assert.ok(!req('POST', `${SB}/auth/v1/token?grant_type=pkce`).allow)
  assert.ok(!req('POST', `${SB}/auth/v1/token`).allow)
  for (const p of ['logout', 'signup', 'otp', 'recover', 'magiclink', 'invite']) assert.ok(!req('POST', `${SB}/auth/v1/${p}`).allow, p)
  assert.ok(!req('PUT', `${SB}/auth/v1/user`).allow)
  // GET 이어도 상태를 바꾸는 인증 경로(메일 링크 소비 등)는 막는다
  assert.ok(!req('GET', `${SB}/auth/v1/verify?token=x&type=signup`).allow)
  assert.ok(!req('GET', `${SB}/auth/v1/authorize?provider=github`).allow)
  assert.ok(req('GET', `${SB}/auth/v1/user`).allow)
})

test('비로그인 단계는 로그인 요청·허용 목록까지 전부 막는다', () => {
  assert.ok(!req('POST', `${SB}/auth/v1/token?grant_type=password`, 'anonymous').allow)
  assert.ok(!req('POST', `${SB}/rest/v1/rpc/list_my_tickets`, 'anonymous').allow)
  assert.ok(req('GET', `${SB}/rest/v1/tickets`, 'anonymous').allow)
})

test('RPC POST 는 기본 전부 차단, 읽기 전용 목록에 있는 이름만 통과', () => {
  assert.ok(req('POST', `${SB}/rest/v1/rpc/list_my_tickets`).allow)
  assert.ok(!req('POST', `${SB}/rest/v1/rpc/approve_ticket`).allow)
  assert.ok(!req('POST', `${SB}/rest/v1/rpc/list_my_tickets_and_mark_read`).allow, '앞부분만 같은 이름은 통과시키지 않는다')
  assert.ok(!req('POST', `${SB}/rest/v1/rpc/LIST_MY_TICKETS`).allow, '대소문자가 다르면 다른 이름')
  assert.ok(!decideRequest({ method: 'POST', url: `${SB}/rest/v1/rpc/list_my_tickets`, tier: 'view-login' }).allow, '설정이 없으면(기본값) RPC 0개 허용')
  assert.ok(!req('PATCH', `${SB}/rest/v1/rpc/list_my_tickets`).allow)
})

test('Edge Function 은 GET 이어도 목록 밖이면 차단', () => {
  assert.ok(!req('GET', `${SB}/functions/v1/send-mail`).allow)
  assert.ok(!req('OPTIONS', `${SB}/functions/v1/send-mail`).allow)
  assert.ok(req('POST', `${SB}/functions/v1/report-view`).allow)
  assert.ok(!req('DELETE', `${SB}/functions/v1/report-view`).allow)
  assert.ok(!req('POST', `${SB}/functions/v1/report-view`, 'anonymous').allow)
})

test('allowPost 는 정확한 경로 또는 * 접두사만', () => {
  assert.ok(req('POST', `${SB}/storage/v1/object/list/attachments`).allow)
  assert.ok(!req('POST', `${SB}/storage/v1/object/attachments/a.png`).allow, '업로드 경로는 목록에 없다')
  const exact = normalizeConfig({ allowPost: { '/api/search': '검색 조회 — POST 본문으로 읽기' } })
  assert.ok(req('POST', 'https://prod.example.com/api/search', 'view-login', exact).allow)
  assert.ok(!req('POST', 'https://prod.example.com/api/search/save', 'view-login', exact).allow)
})

test('denyUrlPatterns 는 GET 도 막는다 · 주소 해석 불가도 차단', () => {
  const c = normalizeConfig({ denyUrlPatterns: ['/track/click'] })
  assert.ok(!req('GET', 'https://prod.example.com/track/click?id=1', 'view-login', c).allow)
  assert.ok(!req('POST', '::::').allow)
})

test('설정 검증 — 이유 한 줄 없는 허용 항목·모르는 키는 거부', () => {
  assert.throws(() => normalizeConfig({ readOnlyRpc: { f: '' } }), /이유 한 줄/)
  assert.throws(() => normalizeConfig({ readOnlyRpc: { f: 'ok' } }), /이유 한 줄/)
  assert.throws(() => normalizeConfig({ readOnlyRpc: { f: '두 줄\n이유' } }), /이유 한 줄/)
  assert.throws(() => normalizeConfig({ readOnlyRpc: ['f'] }), /형태/)
  assert.throws(() => normalizeConfig({ allowWrites: true }), /알 수 없는 설정 키/)
  assert.throws(() => normalizeConfig({ denyUrlPatterns: ['('] }), /정규식/)
  const d = normalizeConfig({})
  assert.equal(d.readOnlyRpc.size, 0); assert.equal(d.readOnlyFunctions.size, 0); assert.equal(d.allowPost.size, 0)
  assert.deepEqual(d.authGrantTypes, ['password', 'refresh_token']); assert.equal(d.allowWebSocket, false)
})

// ── WebSocket ─────────────────────────────────────────────
test('WebSocket 은 기본 차단 · 켜도 구독·심박만 보낸다', () => {
  assert.ok(!decideWebSocket({ config: cfg }).allow)
  assert.ok(decideWebSocket({ config: normalizeConfig({ allowWebSocket: true }) }).allow)
  assert.ok(decideWsMessage(JSON.stringify({ topic: 'realtime:x', event: 'phx_join', payload: {}, ref: '1' })).allow)
  assert.ok(decideWsMessage(JSON.stringify(['1', '2', 'phoenix', 'heartbeat', {}])).allow)
  assert.ok(!decideWsMessage(JSON.stringify({ topic: 'realtime:x', event: 'broadcast', payload: {} })).allow)
  assert.ok(!decideWsMessage(JSON.stringify(['1', '3', 'realtime:x', 'presence', { event: 'track' }])).allow)
  assert.ok(!decideWsMessage('not json').allow)
  assert.ok(!decideWsMessage(Buffer.from('x')).allow)
})

// ── 누르지 않을 조작 ─────────────────────────────────────
test('저장·등록·승인·삭제·발송·제출·확인 버튼은 건너뛴다', () => {
  for (const name of ['저장', '티켓 등록', '승인하기', '삭제', '메일 발송', '제출', '확인', 'Save', 'SUBMIT', 'Delete item', '로그아웃', '권한 요청']) {
    assert.ok(shouldSkipControl({ role: 'button', name }).skip, name)
  }
  assert.ok(shouldSkipControl({ role: 'link', name: '승인 대기 목록' }).skip, '이름이 걸리면 링크도 건너뛴다')
})

test('탭·이동 링크·열람 버튼은 누를 수 있다 · 폼 제출·이름 없는 버튼은 건너뛴다', () => {
  assert.ok(!shouldSkipControl({ role: 'tab', name: '승인 대기' }).skip, '탭은 이름과 상관없이 화면 전환')
  assert.ok(!shouldSkipControl({ role: 'link', name: '티켓 목록' }).skip)
  assert.ok(!shouldSkipControl({ role: 'link', name: '' }).skip)
  assert.ok(!shouldSkipControl({ role: 'button', name: '다음 주 ▶' }).skip)
  assert.ok(!shouldSkipControl({ role: 'button', name: 'address book' }).skip, '영문은 낱말 경계로만(address ≠ add)')
  assert.ok(shouldSkipControl({ role: 'button', name: '다음', submit: true }).skip)
  assert.ok(shouldSkipControl({ role: 'button', name: '' }).skip)
})

test('프로젝트가 더한 낱말도 건너뛴다', () => {
  const m = destructiveMatcher(['출근 찍기', 'clock in'])
  assert.ok(shouldSkipControl({ role: 'button', name: '출근 찍기' }, m).skip)
  assert.ok(shouldSkipControl({ role: 'button', name: 'Clock in now' }, m).skip)
  assert.ok(!shouldSkipControl({ role: 'button', name: '출근 현황' }, m).skip)
})

// ── 자격증명 ─────────────────────────────────────────────
test('보기 전용 계정 한 쌍이 없으면 비로그인 단계 — QA 계정으로 대체하지 않는다', () => {
  const qa = { QA_ADMIN_EMAIL: 'admin@qa.example', QA_ADMIN_PASSWORD: 'x-secret', QA_TEST_EMAIL: 't@qa.example', QA_TEST_PASSWORD: 'y' }
  const r = selectViewCredentials(qa)
  assert.equal(r.tier, 'anonymous'); assert.equal(r.email, undefined); assert.equal(r.password, undefined)
  const half = selectViewCredentials({ ...qa, SC_VIEW_EMAIL: 'viewer@ops.example' })
  assert.equal(half.tier, 'anonymous'); assert.match(half.reason, /SC_VIEW_PASSWORD 없음/)
  assert.ok(!half.reason.includes('viewer@ops.example'), '값을 문구에 넣지 않는다')
})

test('보기 전용 계정이 있으면 그것만 쓴다 · 개발 QA 계정과 같은 주소면 거부', () => {
  const ok = selectViewCredentials({ SC_VIEW_EMAIL: 'viewer@ops.example', SC_VIEW_PASSWORD: 'pw-123', QA_ADMIN_EMAIL: 'admin@qa.example' })
  assert.equal(ok.tier, 'view-login'); assert.equal(ok.email, 'viewer@ops.example')
  assert.throws(() => selectViewCredentials({ SC_VIEW_EMAIL: 'Admin@QA.example ', SC_VIEW_PASSWORD: 'pw', QA_ADMIN_EMAIL: 'admin@qa.example' }), (e) => /QA_ADMIN_EMAIL/.test(e.message) && !e.message.includes('admin@qa.example'))
})

test('보기 전용 방식에서 QA_* 역할 키를 달라고 하면 멈춘다', () => {
  assert.deepEqual(credentialKeysFor('view'), { email: 'SC_VIEW_EMAIL', password: 'SC_VIEW_PASSWORD' })
  assert.throws(() => credentialKeysFor('view', 'QA_ADMIN'), /쓰지 않는다/)
  assert.deepEqual(credentialKeysFor('local', 'QA_ADMIN'), { email: 'QA_ADMIN_EMAIL', password: 'QA_ADMIN_PASSWORD' })
  assert.throws(() => credentialKeysFor('local'), /역할 키/)
})

test('redact — 비밀 값이 로그 문구에 남지 않는다', () => {
  assert.equal(redact('fill viewer@ops.example / pw-123 실패', ['viewer@ops.example', 'pw-123']), 'fill [가림] / [가림] 실패')
  assert.equal(redact('ab', ['a']), 'ab', '3자 미만 값은 건너뛴다')
})

test('판정 불가 항목 — 로그인 단계는 쓰기·안전장치 · 비로그인은 AC·거절·접근성까지', () => {
  assert.deepEqual(notAssessable('view-login'), ['success', 'guard'])
  assert.deepEqual(notAssessable('anonymous').sort(), ['a11y', 'ac', 'deny', 'guard', 'success'])
})
