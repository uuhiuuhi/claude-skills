// screen-check 판정 규칙(v0.2.1) — 화면 문구를 상태로 가르는 정규식·순수 함수만 둔다.
// playwright 를 import 하지 않는다 → `node --test judge.test.mjs` 로 규칙만 단위 검증할 수 있다.
// lib.mjs 가 그대로 재수출하므로 기존 `import { DENY, JARGON } from './lib.mjs'` 는 계속 동작한다.

/** 사용자 화면에 노출되면 안 되는 개발 용어·원시 에러 */
export const JARGON = /에픽|스토리 \d|RPC|RLS|스프린트|PGRST|\bundefined\b|\bnull\b|\[object Object\]|TypeError|Error:/
export const RAW_ERROR = /Error|undefined|network|fetch|status code|exception/i

/** 거절 안내 ① 부정형 — 「…없습니다 / …할 수 없 / 권한이 필요」 계열 */
export const DENY_NEGATIVE = /권한이 없습니다|볼 수 없습니다|열 수 없습니다|들어갈 수 없습니다|접근할 수 없|이용할 수 없|사용할 수 없|처리할 수 없|허용되지 않|권한이 필요|권한을 요청|(?:열람|사용|접근|관리) 권한/

/** 거절 안내 ② 제한형 — 「<역할>에게만 열립니다 / <권한>이 있는 분만 볼 수 있습니다」처럼
 *  긍정 어미로 쓴 거절. 2026-09-17 T3 에서 `/surveys`·`/reports/survey-counters` 거절 6건이
 *  「…분만 볼 수 있습니다」로 쓰여 있어 부정형만 보던 옛 규칙이 전부 놓쳤다(오탐 9건의 주원인).
 *  평범한 긍정 문장(「티켓을 볼 수 있습니다」·「필터로 열립니다」)은 역할 어휘 + 「만」이 없어 걸리지 않는다. */
export const DENY_RESTRICT = /(?:권한|역할|관리자|관리팀|경영진|팀장|담당자|담당|전담자|직원|사용자|(?<![0-9])분)[^.\n]{0,40}(?:에게만|한테만|만)\s*(?:열립니다|열려 있습니다|(?:볼|열|이용할|사용할|쓸|처리할|수정할|확인할|승인할)\s*수\s*있습니다)/

/** AccessDenied(3요소 + 홈으로 이동) 판정 — 권한 안내·없는 화면 둘 다 이 형태다 */
export const DENY = new RegExp(`(?:${DENY_NEGATIVE.source}|${DENY_RESTRICT.source})[\\s\\S]{0,400}홈으로 이동`)
export const NOT_FOUND = /주소에 해당하는 화면이 없습니다/
export const EMPTY_DEST = /아직 준비 중인 화면으로/
/** id·쿼리 없이 상세/수정 경로에 들어갔을 때의 정상 안내(오류 화면이 아니라 「고르라」는 안내) — 「화면 열림」 통과 근거로 쓰지 않는다(Astra 대조 지적 2026-09-09) */
export const GUIDED = /찾을 수 없습니다|불러오지 못했습니다|주소가 잘못|목록에서 (다시 )?(선택|골라)|먼저 (선택|골라)|선택해 주세요/

/** 거절 화면인가 — 문구(DENY) + 「상호작용 요소가 거의 없다」(안내 화면은 [홈으로 이동] 하나뿐).
 *  화면이 데이터·조작 버튼을 그대로 그리면서 안내만 덧붙인 경우는 거절로 세지 않는다(2026-09-17 D-2). */
export function isDenied(text, interactive = 0) {
  return DENY.test(text) && interactive <= 2
}
