// 텔레그램 원격 명령 판정 규칙 — 「머지 + 재개」 조각
//
// 왜 별도 파일인가: 폴러(telegram-commands.mjs)는 네트워크·git 을 만진다. 판정부(명령 파서·
// 발신자 검증·확인 코드 상태기·ff 판정)만 순수 함수로 빼서 테스트가 실물을 문다 —
// runner-rules.mjs 와 같은 관례.
//
// 명령 등급(운영 승인 체계): 허용 = 재개·머지·상한 연장(읽기 /status 포함) / 불가 = 운영 DB 변경·
// 외부 발송·삭제·시크릿. 이 파일의 파서에는 허용 4개(/status /merge /resume /extend)만 존재한다 —
// 「불가」 명령은 파서에 없음 = 입구 거부. 인자를 받는 명령은 /extend 하나뿐이며, 그 인자도
// 「1~30 정수」로 잠근다(임의 ref 머지·임의 문자열 주입 차단).

/** 인식하는 명령 전부. 여기 없는 텍스트는 무시(회신 없음). */
export const COMMANDS = Object.freeze(['/status', '/merge', '/resume', '/extend'])

/** /extend 인자 파서(무정지 개편 — 하루 상한 연장) — 「/extend N」(N=1~30 정수)만 허용.
 *  유일하게 인자를 받는 명령이며, 인자는 숫자 상한으로 잠근다(임의 문자열 차단 — 인자 거부 정신 유지). */
export const EXTEND_MAX = 30
export function parseExtend(text) {
  if (typeof text !== 'string') return null
  const m = /^\/extend(?:@[\w]+)?\s+(\d{1,2})$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= EXTEND_MAX ? n : null
}

/** 확인 코드 유효 시간(ms) — 30분. 폴링 주기(10분)와 같으면 정상 답장이 경계에서 상시
 *  만료된다(실측 지적). 폴링 주기의 3배 — 코드는 1회용 + chat 잠금이라 안전도 차이는 미미. */
export const CONFIRM_TTL_MS = 30 * 60 * 1000

/** 되묻기가 필요한 명령(실행형). /status 는 읽기 전용이라 즉시.
 *  /extend 는 「/extend N」 전체가 pending.command 로 저장돼 코드 확인 후 그 N 이 실행된다. */
export const NEEDS_CONFIRM = Object.freeze(['/merge', '/resume', '/extend'])

/** 명령 파서 — 정확히 명령 하나만(`/merge@botname` 접미사 허용).
 *  인자가 붙으면 null — 임의 인자 주입(브랜치·ref 지정) 차단 규율. */
export function parseCommand(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (!t.startsWith('/')) return null
  const [head, ...rest] = t.split(/\s+/)
  if (rest.length > 0) return null // 인자 = 임의 브랜치·ref 시도 → 거부
  const cmd = head.replace(/@[\w]+$/, '')
  return COMMANDS.includes(cmd) ? cmd : null
}

/** 발신자 검증 — telegram-chat.json 의 chat_id 와 일치해야 한다(문자열 비교 · 숫자/문자 혼재 대비). */
export function isAuthorizedSender(message, chatId) {
  if (!message || message.chat == null || chatId == null) return false
  return String(message.chat.id) === String(chatId)
}

/** 4자리 확인 코드 형태 */
export function looksLikeCode(text) {
  return typeof text === 'string' && /^\d{4}$/.test(text.trim())
}

/** 확인 대기 생성 — 명령·코드·만료(CONFIRM_TTL_MS = 30분) */
export function newPending(command, code, nowMs) {
  return { command, code: String(code).padStart(4, '0'), expiresAt: nowMs + CONFIRM_TTL_MS }
}

/** 확인 코드 상태기 — 대기(pending)와 들어온 텍스트를 맞춰 본다.
 *  반환: 'match'(실행) · 'expired'(만료 — 재요청 안내) · 'mismatch'(코드 형태지만 불일치) · null(코드 아님) */
export function matchConfirmation(pending, text, nowMs) {
  if (!looksLikeCode(text)) return null
  if (!pending) return 'mismatch'
  if (nowMs > pending.expiresAt) return 'expired'
  return text.trim() === pending.code ? 'match' : 'mismatch'
}

/** 한 메시지의 처분을 결정한다(순수). 실행 자체는 폴러 몫.
 *  kind: 'blocked'(외부 발신 — 무응답 · 원장만) · 'ignore'(관계없는 텍스트 — 무응답) ·
 *        'status' · 'challenge'(코드 회신 + pending 저장) · 'execute'(pending 의 명령 실행) ·
 *        'expired'(재요청 안내) · 'mismatch'(무응답 — 코드 추측 시도에 힌트 주지 않음) */
export function judgeMessage({ message, chatId, pending, nowMs }) {
  if (!isAuthorizedSender(message, chatId)) return { kind: 'blocked' }
  const text = message.text ?? ''
  const conf = matchConfirmation(pending, text, nowMs)
  if (conf === 'match') return { kind: 'execute', command: pending.command }
  if (conf === 'expired') return { kind: 'expired', command: pending.command }
  if (conf === 'mismatch') return { kind: 'mismatch' }
  const extendN = parseExtend(text)
  if (extendN != null) return { kind: 'challenge', command: `/extend ${extendN}` }
  const cmd = parseCommand(text)
  if (!cmd) return { kind: 'ignore' }
  if (cmd === '/status') return { kind: 'status' }
  if (cmd === '/extend') return { kind: 'ignore' } // 인자 없는 /extend — 형식 미달(N 필수)
  return NEEDS_CONFIRM.includes(cmd) ? { kind: 'challenge', command: cmd } : { kind: 'ignore' }
}

/** 미머지 ref 분류 — 입력은 러너와 같은 재료(`for-each-ref refs/heads/auto refs/remotes/origin/auto`
 *  의 short 이름 중 rev-list 로 미머지 판정된 것 · 원격만 보면 로컬 미푸시를 못 본다 — 러너의
 *  휴면 판정과 동일 재료를 쓴다).
 *  반환: remote = `/merge` 가능(원격 ff) · localOnly = 원격에 없는 로컬 — 폰에서 못 푼다(사람 필요). */
export function partitionUnmerged(names) {
  const uniq = [...new Set((names ?? []).map((n) => String(n).trim()).filter(Boolean))]
  const remote = uniq.filter((n) => /^origin\/auto\/[^\s]+$/.test(n)).map((n) => n.slice('origin/'.length))
  const localOnly = uniq.filter((n) => /^auto\/[^\s]+$/.test(n)).filter((n) => !remote.includes(n))
  return { remote, localOnly }
}

/** 머지 대상 refspec — 원격 ff 전용. 로컬 체크아웃·작업 트리 접촉 0 이 규율이다
 *  (원격 ref 만으로 밀어 올린다 — 동시에 돌고 있는 배치의 작업 트리를 흔들지 않기 위해).
 *  `auto/` 접두사가 아니면 예외 — 파서가 인자를 안 받으므로 여기 도달하는 건 코드 결함뿐이다. */
export function mergeRefspec(branch) {
  if (!/^auto\/[^\s:]+$/.test(branch)) throw new Error(`머지 대상은 auto/* 만이다: ${branch}`)
  return `origin/${branch}:main`
}

/** push 결과 판정 — 'ok' · 'non-ff'(갈라짐 — 강제하지 않고 사람 머지 안내) · 'error'(그 외) */
export function classifyPush({ status, stderr }) {
  if (status === 0) return 'ok'
  const s = String(stderr ?? '')
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(s)) return 'non-ff'
  return 'error'
}

/** 슬롯 재개 상태 수술(순수) — 이 창의 차단기 전체(stops·원인 서명·창 누적)를 0 으로.
 *  다른 창·날짜 원장은 불변. 차단기 v2(원인 서명 누적)와 호환 — stops 만 지우면 sigs 가 남아
 *  재개가 헛돈다(서명 하나가 이미 2 면 다음 라운드에서 즉시 재차단). */
export function resetWindowStops(state, windowId) {
  const s = structuredClone(state ?? {})
  s.windows ??= {}
  s.windows[windowId] = { ...(s.windows[windowId] ?? {}), stops: 0, sigs: {}, total: 0 }
  return s
}
