// providers/redact.mjs — **단일 공용 시크릿 마스커** (2026-09-02 3차 리뷰 H1)
//
// 왜 있나: 마스킹 규칙이 codex.mjs 안에만 있어서, 나중에 붙은 진단(diagnose.mjs)·보고서(report.mjs)가
// **자기 사본**을 따로 만들었고 그 사본이 R2 에서 이미 고친 세 형식(`{"api_key":"…"}` ·
// `Authorization: Bearer …` · `PRIVATE_KEY="a b c"`)을 다시 통과시켰다. 마스커는 하나여야 한다.
// codex.mjs 는 이 모듈을 **재수출**한다(기존 `providers/codex.mjs` import 경로가 깨지지 않게).
//
// 규율:
//   · 이름(키)은 남기고 값만 가린다 — 무엇이 새려 했는지는 사람이 알아야 한다.
//   · 배열 순서가 규율이다: ① Authorization/Bearer/Cookie 헤더 ② 인용값(JSON·셸) ③ 비인용 KEY=VALUE
//     ④ URL·PEM·토큰 형태. ①을 ③보다 **먼저** 두는 이유: `Authorization` 은 ③의 `AUTH` 에도 걸려
//     `Bearer` 만 가리고 토큰을 남긴다.
//   · `deepRedact(obj)` — 문자열뿐 아니라 객체·배열·Map/Set 을 **깊이** 훑는다(스냅숏·매니페스트·상태 JSON
//     안의 토큰이 보고서로 새지 않게). 순환 참조는 `[Circular]` 로 끊는다.
export const REDACTED = '***REDACTED***'

/** 인용값·JSON 키로 인정하는 자격증명 이름(엄격) — `author` 같은 평범한 키를 가리지 않게 좁혔다. */
const SECRET_KEY_STRICT = 'password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|public[_-]?key_?secret|access[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?role|credentials?|authorization|auth[_-]?token|auth[_-]?key|session[_-]?key|signing[_-]?key|client[_-]?secret|dsn|connection[_-]?string'
const REDACTIONS = [
  // Authorization / Proxy-Authorization 헤더 — 스킴은 남기고 값만 가린다(무엇이 새려 했는지는 보여야 한다)
  [/\b((?:proxy-)?authorization\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?(["']?)([^\s"',;)}\]]{6,})/gi,
    (_, head, scheme, q) => `${head}${scheme ? scheme + ' ' : ''}${q}***REDACTED***`],
  // 스킴만 있는 형태(`Bearer <token>` · `Basic <b64>`)도 값만 가린다
  [/\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/g, (_, s) => `${s} ***REDACTED***`],
  // Cookie / Set-Cookie — 값 전체(세션 쿠키가 곧 자격증명이다)
  [/\b(set-cookie|cookie)(\s*:\s*)([^\r\n]{4,})/gi, (_, k, sep) => `${k}${sep}***REDACTED***`],
  // 인용값 — JSON(`"api_key":"…"`) · 셸(`PRIVATE_KEY="a b c"`) · 공백 포함 값. 키 앞뒤 따옴표를 모두 허용한다.
  [new RegExp(String.raw`\b([A-Za-z0-9_-]*(?:${SECRET_KEY_STRICT})[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)(["'])([^"'\r\n]{4,})(["'])`, 'gi'),
    (_, k, sep, q1, __, q2) => `${k}${sep}${q1}***REDACTED***${q2}`],
  // KEY=VALUE / KEY: VALUE (SUPABASE_SERVICE_ROLE_KEY=… · CLIENT_SECRET: … · DATABASE_URL · x-api-key: …)
  // 값 자리의 `***REDACTED***` 와 인증 스킴(`Bearer`)은 건너뛴다 — 앞 규칙이 이미 가린 것을 다시 가리면
  // `Authorization: ***REDACTED*** ***REDACTED***` 처럼 **무엇이 새려 했는지**가 사라진다.
  [/\b([A-Za-z0-9_-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SERVICE[_-]?ROLE|CREDENTIAL|AUTH|SESSION[_-]?KEY|SIGNING[_-]?KEY|DSN|CONNECTION[_-]?STRING)[A-Za-z0-9_-]*)(\s*[=:]\s*)(['"]?)(?!\*\*\*REDACTED\*\*\*)(?!(?:Bearer|Basic|Digest|Token)\b)([^'"\s]{6,})/gi,
    (_, k, sep, qq) => `${k}${sep}${qq}***REDACTED***`],
  // URL credential — postgres://user:pass@host · https://u:p@h
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]{1,200})@/gi, (_, proto, user) => `${proto}${user}:***REDACTED***@`],
  // PEM 블록 전체
  [/-----BEGIN ([A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END \1-----/g, '-----BEGIN $1-----***REDACTED***-----END $1-----'],
  [/(sb_secret_)[A-Za-z0-9_-]{8,}/g, '$1***REDACTED***'],
  // JWT (Supabase anon/service · OAuth id_token) — 3조각(h.p.s) 뿐 아니라 **서명부가 잘린 2조각**(h.p)도 잡는다.
  // 로그·diff 는 줄을 자르므로 실제로 새는 형태는 대개 2조각이다(diagnose.mjs 가 이 그물을 자기 사본으로 덧대고 있었다).
  // 헤더까지 통째로 지우는 이유: 헤더가 남으면 `eyJ…\.` 형태가 그대로 보여 「JWT 가 새지 않았다」를 grep 으로 증명할 수 없다.
  [/eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)+/g, 'eyJ***REDACTED***'],
  [/(sk-)(?:proj-)?[A-Za-z0-9_-]{16,}/g, '$1***REDACTED***'],
  [/(gh[pousr]_)[A-Za-z0-9]{16,}/g, '$1***REDACTED***'],
  [/(xox[abprs]-)[A-Za-z0-9-]{10,}/g, '$1***REDACTED***'],
  [/(AKIA)[0-9A-Z]{16}/g, '$1****************'],
  // OAuth client secret 관용 표기(GOCSPX- = Google · 그 밖의 client_secret 키는 위 KEY=VALUE 가 잡는다)
  [/(GOCSPX-)[A-Za-z0-9_-]{10,}/g, '$1***REDACTED***'],
  [/\b(client[_-]?secret)(["']?\s*[=:]\s*["']?)([^\s"',}]{6,})/gi, (_, k, sep) => `${k}${sep}***REDACTED***`],
]
export function redactSecrets(text) {
  let s = String(text ?? '')
  for (const [re, rep] of REDACTIONS) s = s.replace(re, rep)
  return s
}

// ── 깊은 마스킹 (H1) ──────────────────────────────────────────────────────────────────
/** 키 이름만으로 값 전체를 가려야 하는 자리 — 값이 랜덤 문자열이라 패턴으로는 못 잡는다. */
const SECRET_FIELD_RE = new RegExp(`^[A-Za-z0-9_-]*(?:${SECRET_KEY_STRICT})[A-Za-z0-9_-]*$`, 'i')
export const isSecretFieldName = (k) => SECRET_FIELD_RE.test(String(k ?? ''))

/**
 * 객체·배열·문자열을 깊이 마스킹한 **새 값**을 돌려준다(입력은 고치지 않는다 · 순환 안전).
 *  · 문자열 → `redactSecrets`
 *  · 객체 키가 자격증명 이름이면 값이 문자열/숫자여도 통째로 `***REDACTED***`
 *  · **키는 배열·Set 안쪽까지 상속된다** — `{"tokens":["원문"]}` 의 원소는 값 패턴이 없어도 가린다.
 *  · Map/Set/Date 도 형을 잃지 않고 옮긴다. 함수·Symbol 은 그대로 둔다(직렬화 대상이 아니다).
 * @param {unknown} value
 * @param {WeakSet} [seen] 순환 감지용
 * @param {string} [key] 상속되는 키 이름(배열 원소 판정용)
 * @returns {unknown} 마스킹된 새 값
 */
export function deepRedact(value, seen = new WeakSet(), key = '') {
  if (typeof value === 'string') return isSecretFieldName(key) ? REDACTED : redactSecrets(value)
  if (typeof value === 'number') return isSecretFieldName(key) ? REDACTED : value
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, seen, key))
  if (value instanceof Date) return value
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, isSecretFieldName(k) ? REDACTED : deepRedact(v, seen, k)]))
  if (value instanceof Set) return new Set([...value].map((v) => deepRedact(v, seen, key)))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (isSecretFieldName(k) && (typeof v === 'string' || typeof v === 'number')) { out[k] = REDACTED; continue }
    out[k] = deepRedact(v, seen, k)
  }
  return out
}
