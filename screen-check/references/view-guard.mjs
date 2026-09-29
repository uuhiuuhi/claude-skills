// screen-check 보기 전용 방식(v0.3) 가드 — 「쓰기를 약속이 아니라 기술로 막는다」 규칙만 둔다.
// playwright 를 import 하지 않는다 → `node --test view-guard.test.mjs` 로 브라우저 없이 단위 검증한다.
// 쓰는 곳: view-check.mjs(보기 전용 실행기) · lib.mjs / template.mjs(로컬 방식의 비로컬 주소 거부).
//
// 규칙 요약
//  ① 로컬 개발 주소(localhost · 127.0.0.1 · [::1] · *.localhost · *.test)가 아니면 무조건 보기 전용이다. 이를 푸는 옵션은 없다.
//  ② 요청은 GET·HEAD·OPTIONS 만 통과. 그 밖의 메서드는 막고 「차단된 쓰기 시도」로 적는다.
//     예외(허용 목록 · 기본값 최소): 로그인·토큰 갱신(POST /auth/v1/token?grant_type=password|refresh_token · 로그인 단계에서만)
//     + 프로젝트가 이유 한 줄과 함께 적은 읽기 전용 RPC·Edge Function·POST 경로.
//  ③ WebSocket 은 기본 차단. 켜면 연결·구독·심박 메시지만 보내고 broadcast·presence 같은 송신은 버린다.
//  ④ 이름이 저장·등록·승인·삭제·발송·제출·확인… 인 버튼·링크는 누르지 않는다(탭은 누른다).
//  ⑤ 자격증명은 SC_VIEW_EMAIL / SC_VIEW_PASSWORD 한 쌍만. 개발 QA 계정(QA_*)으로 대체하지 않는다.

/** 로컬 개발 주소인가 — 정확히 이 다섯 형태만 인정한다(127.0.0.2·사설 IP·nip.io 등은 비로컬). */
export function isLocalHost(hostname) {
  const h = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!h) return false
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.test')
}

function parseBase(base) {
  let u
  try { u = new URL(String(base)) } catch { throw new Error(`기준 주소를 해석하지 못함: ${base}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`기준 주소는 http(s) 만: ${u.protocol}`)
  return u
}

/** 실행 방식 결정. requested = --mode 또는 SC_MODE(view | local · 비우면 auto).
 *  비로컬 주소면 무엇을 요청했든 view 로 강제한다(forced=true) — 쓰기 프로브를 비로컬에 허용하는 값은 없다. */
export function resolveMode({ base, requested } = {}) {
  const u = parseBase(base)
  const req = String(requested ?? '').trim().toLowerCase() || 'auto'
  if (!['auto', 'view', 'local'].includes(req)) throw new Error(`알 수 없는 방식: ${requested} (view | local)`)
  const local = isLocalHost(u.hostname)
  if (!local) return { mode: 'view', host: u.host, local, forced: req !== 'view', note: req === 'local' ? '비로컬 주소 — local 요청을 무시하고 보기 전용으로 강제했다' : '' }
  return { mode: req === 'view' ? 'view' : 'local', host: u.host, local, forced: false, note: '' }
}

/** 로컬 방식(쓰기 프로브가 있는 lib.mjs·template.mjs)이 시작 전에 부른다 — 비로컬 주소이거나 SC_MODE=view 면 멈춘다. */
export function assertWritableBase(base, env = process.env) {
  const r = resolveMode({ base, requested: env?.SC_MODE })
  if (r.mode !== 'local') {
    throw new Error(`쓰기 프로브 방식은 로컬 개발 주소에서만 돈다(대상 ${r.host}${r.local ? ' · SC_MODE=view' : ' · 비로컬'}). 운영·미리보기 주소는 view-check.mjs(보기 전용)로 확인한다.`)
  }
  return r
}

// ── 설정(프로젝트 몫) ─────────────────────────────────────────────
/** 허용 목록 항목은 「이름 → 이유 한 줄」. 이유가 없으면 설정을 거부한다(왜 읽기 전용인지 적는 것이 프로젝트 책임). */
function reasonMap(obj, field) {
  const out = new Map()
  if (obj == null) return out
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${field} 는 { 이름: "이유 한 줄" } 형태여야 한다`)
  for (const [k, v] of Object.entries(obj)) {
    const why = typeof v === 'string' ? v.trim() : ''
    if (why.length < 4 || /[\r\n]/.test(why)) throw new Error(`${field}.${k} — 읽기 전용인 이유 한 줄이 필요하다(4자 이상 · 한 줄)`)
    out.set(k, why)
  }
  return out
}

export const DEFAULT_GRANT_TYPES = Object.freeze(['password', 'refresh_token'])
/** 방법과 상관없이 막는 주소(GET 이어도 상태를 바꾸는 인증 경로). 프로젝트가 denyUrlPatterns 로 더한다. */
export const DEFAULT_DENY_URL = Object.freeze([String.raw`/auth/v1/(?:verify|authorize|callback|logout|signup|otp|recover|magiclink|invite)(?:[/?]|$)`])
export const DEFAULT_LOGIN = Object.freeze({ path: '/login', email: '#login-email', password: '#login-password', submit: 'button[type=submit]' })

/** view-config.json → 검증된 설정. 모든 필드는 선택 · 기본값이 최소 허용이다. */
export function normalizeConfig(raw = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('설정은 JSON 객체여야 한다')
  const known = ['readOnlyRpc', 'readOnlyFunctions', 'allowPost', 'authGrantTypes', 'denyUrlPatterns', 'extraDestructive', 'allowWebSocket', 'login', '$comment']
  const unknown = Object.keys(raw).filter((k) => !known.includes(k))
  if (unknown.length) throw new Error(`알 수 없는 설정 키: ${unknown.join(', ')}`)
  const grants = raw.authGrantTypes ?? DEFAULT_GRANT_TYPES
  if (!Array.isArray(grants) || grants.some((g) => typeof g !== 'string' || !g)) throw new Error('authGrantTypes 는 문자열 배열')
  const deny = [...DEFAULT_DENY_URL, ...(raw.denyUrlPatterns ?? [])].map((p) => { try { return new RegExp(p, 'i') } catch { throw new Error(`denyUrlPatterns 정규식 오류: ${p}`) } })
  const extra = raw.extraDestructive ?? []
  if (!Array.isArray(extra) || extra.some((w) => typeof w !== 'string' || !w.trim())) throw new Error('extraDestructive 는 문자열 배열')
  return {
    readOnlyRpc: reasonMap(raw.readOnlyRpc, 'readOnlyRpc'),
    readOnlyFunctions: reasonMap(raw.readOnlyFunctions, 'readOnlyFunctions'),
    allowPost: reasonMap(raw.allowPost, 'allowPost'),
    authGrantTypes: [...grants],
    denyUrl: deny,
    extraDestructive: extra.map((w) => w.trim()),
    allowWebSocket: raw.allowWebSocket === true,
    login: { ...DEFAULT_LOGIN, ...(raw.login ?? {}) },
  }
}

// ── 요청 판정 ─────────────────────────────────────────────────────
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const allow = (reason) => ({ allow: true, reason })
const deny = (reason) => ({ allow: false, reason })

/** 한 요청을 통과시킬지. tier = 'anonymous'(비로그인) | 'view-login'(보기 전용 로그인).
 *  비로그인 단계는 읽기 메서드만 통과(로그인 요청조차 막는다). 판정 중 예외는 호출자가 「차단」으로 처리한다(fail-closed). */
export function decideRequest({ method, url, tier = 'anonymous', config }) {
  const cfg = config ?? normalizeConfig({})
  const m = String(method ?? '').toUpperCase()
  let u
  try { u = new URL(String(url)) } catch { return deny('주소 해석 불가') }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return SAFE_METHODS.has(m) ? allow('브라우저 내부 자원') : deny(`${m} ${u.protocol}`)
  for (const re of cfg.denyUrl) if (re.test(u.pathname + u.search)) return deny(`금지 주소(${re.source})`)
  const path = u.pathname.replace(/\/+$/, '')
  // Edge Function 은 GET 이어도 코드가 무엇을 하는지 모른다 → 목록에 있을 때만 통과
  const fn = path.match(/\/functions\/v1\/([^/]+)/)
  if (fn) {
    const name = decodeURIComponent(fn[1])
    if (!cfg.readOnlyFunctions.has(name)) return deny(`Edge Function ${name} — 읽기 전용 목록에 없음`)
    if (tier !== 'view-login' && !SAFE_METHODS.has(m)) return deny(`비로그인 단계 — ${m} 차단`)
    return ['GET', 'HEAD', 'OPTIONS', 'POST'].includes(m) ? allow(`읽기 전용 Edge Function(${name})`) : deny(`${m} Edge Function ${name}`)
  }
  if (SAFE_METHODS.has(m)) return allow('읽기 메서드')
  if (tier !== 'view-login') return deny(`비로그인 단계 — ${m} 차단`)
  if (m === 'POST') {
    if (/\/auth\/v1\/token$/.test(path)) {
      const g = u.searchParams.get('grant_type') ?? ''
      return cfg.authGrantTypes.includes(g) ? allow(`로그인·토큰 갱신(${g})`) : deny(`허용 목록 밖 로그인 방식 grant_type=${g || '(없음)'}`)
    }
    const rpc = path.match(/\/rest\/v1\/rpc\/([^/]+)$/)
    if (rpc) {
      const name = decodeURIComponent(rpc[1])
      return cfg.readOnlyRpc.has(name) ? allow(`읽기 전용 RPC(${name})`) : deny(`RPC ${name} — 읽기 전용 목록에 없음`)
    }
    for (const [p] of cfg.allowPost) {
      const hit = p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p.replace(/\/+$/, '')
      if (hit) return allow(`허용 POST(${p})`)
    }
  }
  return deny(`${m} — 쓰기 메서드`)
}

// ── WebSocket ─────────────────────────────────────────────────────
/** 연결 자체를 허용할지 — 기본 차단(실시간 갱신은 안 보이지만 화면의 첫 데이터는 REST 로 온다). */
export function decideWebSocket({ config } = {}) {
  return config?.allowWebSocket ? allow('allowWebSocket=true') : deny('WebSocket 기본 차단(보기 전용)')
}

/** 연결을 허용했을 때 페이지 → 서버 메시지 판정. Phoenix(Supabase Realtime) v1 객체·v2 배열 둘 다 읽는다.
 *  연결·구독·해제·심박·토큰 갱신만 보낸다. broadcast·presence 는 다른 사용자에게 닿는 송신이라 버린다. 해석 못 하면 버린다. */
export const SAFE_WS_EVENTS = Object.freeze(['phx_join', 'phx_leave', 'heartbeat', 'access_token'])
export function decideWsMessage(message) {
  if (typeof message !== 'string') return deny('이진 메시지')
  let msg
  try { msg = JSON.parse(message) } catch { return deny('해석 불가 메시지') }
  const event = Array.isArray(msg) ? msg[3] : msg?.event
  return SAFE_WS_EVENTS.includes(event) ? allow(`실시간 ${event}`) : deny(`실시간 송신 ${event ?? '(이벤트 없음)'}`)
}

// ── 누르지 않을 조작 ───────────────────────────────────────────────
/** 이름에 들어 있으면 누르지 않는다. 넓게 잡는다 — 잘못 건너뛰면 확인 범위가 줄 뿐이지만, 잘못 누르면 운영 기록이 남는다. */
export const DESTRUCTIVE_KO = Object.freeze(['저장', '등록', '승인', '반려', '거절', '삭제', '제거', '발송', '전송', '보내', '제출', '확인', '완료', '처리', '접수', '배정', '게시', '업로드', '수정', '변경', '적용', '추가', '생성', '만들기', '초대', '해지', '비활성', '활성화', '복구', '되살리', '결제', '결재', '동의', '초기화', '취소', '종료', '로그아웃', '잠금', '신청', '요청', '가져오기', '이관', '병합', '보관'])
export const DESTRUCTIVE_EN = Object.freeze(['save', 'submit', 'delete', 'remove', 'send', 'approve', 'reject', 'confirm', 'create', 'add', 'update', 'edit', 'publish', 'post', 'upload', 'apply', 'reset', 'pay', 'invite', 'import', 'archive', 'sign out', 'log out', 'logout'])

export function destructiveMatcher(extra = []) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ko = [...DESTRUCTIVE_KO, ...extra.filter((w) => /[^\x00-\x7f]/.test(w))].map(esc)
  const en = [...DESTRUCTIVE_EN, ...extra.filter((w) => !/[^\x00-\x7f]/.test(w))].map(esc)
  return new RegExp(`(?:${ko.join('|')})|\\b(?:${en.join('|')})\\b`, 'i')
}

/** 이 조작을 건너뛸지. role = button | link | tab | menuitem …, submit = 폼 안의 제출 버튼인가.
 *  탭은 화면 전환이라 누른다. 제출 버튼·이름 없는 버튼은 이름과 상관없이 건너뛴다. */
export function shouldSkipControl({ role, name, submit = false }, matcher = destructiveMatcher()) {
  const r = String(role ?? '').toLowerCase()
  const n = String(name ?? '').replace(/\s+/g, ' ').trim()
  if (r === 'tab') return { skip: false, reason: '탭(화면 전환)' }
  if (submit) return { skip: true, reason: '폼 제출 버튼' }
  if (!n) return r === 'link' ? { skip: false, reason: '이름 없는 링크(이동)' } : { skip: true, reason: '이름 없는 조작 — 무엇을 하는지 모름' }
  const hit = n.match(matcher)
  return hit ? { skip: true, reason: `이름에 「${hit[0]}」` } : { skip: false, reason: '이동·열람' }
}

// ── 자격증명 ──────────────────────────────────────────────────────
export const VIEW_KEYS = Object.freeze({ email: 'SC_VIEW_EMAIL', password: 'SC_VIEW_PASSWORD' })

/** 보기 전용 계정 고르기. 한 쌍이 다 있으면 'view-login', 아니면 'anonymous'(비로그인 단계만).
 *  QA_* 키는 값으로 쓰지 않는다 — 같은 주소가 QA_*_EMAIL 에 있으면(개발 QA 계정 재사용) 거부한다. 값은 오류 문구에 넣지 않는다. */
export function selectViewCredentials(env = {}) {
  const email = String(env[VIEW_KEYS.email] ?? '').trim()
  const password = String(env[VIEW_KEYS.password] ?? '')
  if (!email || !password) {
    const missing = [!email && VIEW_KEYS.email, !password && VIEW_KEYS.password].filter(Boolean)
    return { tier: 'anonymous', reason: `${missing.join('·')} 없음 — 비로그인 단계만 돈다(QA_* 계정으로 대체하지 않는다)` }
  }
  const clash = Object.keys(env).filter((k) => /^QA_[A-Z0-9_]*EMAIL$/.test(k) && String(env[k] ?? '').trim().toLowerCase() === email.toLowerCase())
  if (clash.length) throw new Error(`${VIEW_KEYS.email} 가 개발 QA 계정(${clash.join('·')})과 같은 주소다 — 보기 전용 방식은 최소 권한 전용 계정만 쓴다`)
  return { tier: 'view-login', email, password, reason: '보기 전용 계정' }
}

/** 로그인에 쓸 env 키 이름. 보기 전용 방식에서 QA_* 역할 키를 달라고 하면 멈춘다(대체 금지). */
export function credentialKeysFor(mode, roleKey) {
  if (mode === 'view') {
    if (roleKey && roleKey !== 'view') throw new Error(`보기 전용 방식은 ${roleKey}_* 계정을 쓰지 않는다 — ${VIEW_KEYS.email}/${VIEW_KEYS.password} 만`)
    return { email: VIEW_KEYS.email, password: VIEW_KEYS.password }
  }
  if (!roleKey) throw new Error('로컬 방식은 역할 키(QA_TEST · QA_ADMIN …)가 필요하다')
  return { email: `${roleKey}_EMAIL`, password: `${roleKey}_PASSWORD` }
}

/** 로그·오류 문구에서 비밀 값을 지운다(값이 3자 이상일 때만 · 짧은 값은 오탐이 커서 건너뜀). */
export function redact(text, secrets = []) {
  let s = String(text ?? '')
  for (const v of secrets) if (typeof v === 'string' && v.length >= 3) s = s.split(v).join('[가림]')
  return s
}

// ── 채점표 ────────────────────────────────────────────────────────
export const TIER_LABEL = Object.freeze({ anonymous: '비로그인', 'view-login': '보기 전용 로그인' })
/** 보기 전용 방식에서 판정할 수 없는 평가 항목(score.mjs RUBRIC 키) — 점수를 주지 않고 「—」로 둔다. */
export function notAssessable(tier) {
  const always = ['success', 'guard']            // 쓰기 경로 · 확인/되돌리기 버튼은 누르지 않으므로
  return tier === 'view-login' ? always : [...always, 'ac', 'deny', 'a11y']   // 비로그인은 로그인 안쪽 화면을 못 봤다
}
