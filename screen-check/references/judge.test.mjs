// 실행: node --test references/judge.test.mjs
// 고정하는 것 = 「거절 판정이 긍정 어미로 쓴 거절을 잡고, 평범한 긍정 문장은 잡지 않는다」.
// 재료는 2026-09-17 릴리스 열차 T3 실측 결과(results-A-t3-r2.json)의 실제 화면 문구다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DENY, NOT_FOUND, EMPTY_DEST, GUIDED, JARGON, isDenied } from './judge.mjs'

const HOME = ' 홈으로 이동'

/** 거절 화면 문구(전부 매칭돼야 한다) — ①②는 옛 규칙이 놓쳐 오탐 6건을 낸 실제 문구 */
const DENIED = [
  '만족도 발송 큐는 발송 승인 권한이 있는 분만 볼 수 있습니다. 고객에게 나가는 메일이라 승인 권한을 좁게 둡니다. 필요하면 관리자에게 권한을 요청해 주세요.' + HOME,
  '이 화면은 팀장·경영진·관리자만 볼 수 있습니다 발송 기록 열람 권한이 필요합니다. 필요하면 관리자에게 역할 확인을 요청해 주세요.' + HOME,
  '접속 정보 금고의 열람·수정 기록은 관리자에게만 열립니다. 확인이 필요하면 관리자에게 요청해 주세요.' + HOME,
  '이 화면을 볼 권한이 없습니다. 필요하면 관리자에게 요청해 주세요.' + HOME,
  '접수와 동시에 배정하는 화면이라 팀장·헬프데스크 전담자에게만 열려 있습니다. 접수가 필요하면 관리자에게 권한을 요청해 주세요.' + HOME,
  '임시 고객 승격은 관리자만 처리할 수 있습니다. 승격이 필요하면 관리자에게 요청해 주세요.' + HOME,
]

/** 평범한 화면 문구(하나도 매칭되면 안 된다) — 「있습니다」·「열립니다」가 들어간 정상 안내 */
const NOT_DENIED = [
  '티켓 목록은 이 기본 필터로 열립니다. 오늘 완료한 티켓은 24시까지 함께 보입니다.' + HOME,
  '지난 날짜의 빈 칸을 누르면 그 날짜로 사후 등록이 열립니다.' + HOME,
  '기록은 남고 화면에서만 숨겨집니다. 나중에 [내려진 담당자]에서 되살릴 수 있습니다.' + HOME,
  '내 티켓 3건을 볼 수 있습니다. 상세를 누르면 처리 이력이 열립니다.' + HOME,
  '배정 참조 중에는 기간을 넓혀도 상세 격자 범위(2주)까지만 열립니다.' + HOME,
]

test('거절 문구는 부정형·제한형 모두 매칭된다', () => {
  for (const t of DENIED) assert.ok(DENY.test(t), `거절인데 안 잡힘: ${t.slice(0, 40)}`)
})

test('평범한 긍정 문장은 거절로 잡지 않는다', () => {
  for (const t of NOT_DENIED) assert.ok(!DENY.test(t), `오탐: ${t.slice(0, 40)}`)
})

test('「홈으로 이동」이 없으면 거절 화면이 아니다', () => {
  assert.ok(!DENY.test('만족도 발송 큐는 발송 승인 권한이 있는 분만 볼 수 있습니다.'))
})

test('isDenied — 조작 버튼이 그대로 있는 화면은 거절로 세지 않는다(D-2)', () => {
  // /attendance/weekly: 관리 화면(주 이동·내려받기 버튼)이 그려진 채로 안내만 덧붙은 실제 사례
  const weekly = '근태 주간 관리 마지막 조회 05:24 ◀ 지난주 이번 주 다음주 ▶ 파일로 내려받기 근태 주간 관리는 관리 권한이 있는 분만 볼 수 있습니다.' + HOME
  assert.equal(isDenied(weekly, 6), false)
  assert.equal(isDenied(DENIED[0], 1), true)
})

test('없는 화면·준비 중·선택 안내는 각자 규칙으로 갈린다', () => {
  assert.ok(NOT_FOUND.test('주소에 해당하는 화면이 없습니다'))
  assert.ok(EMPTY_DEST.test('근태 · 아직 준비 중인 화면으로, 근태 기능이 열리면 채워집니다'))
  assert.ok(GUIDED.test('목록에서 다시 선택해 주세요'))
  assert.ok(!GUIDED.test('만족도 발송 큐는 발송 승인 권한이 있는 분만 볼 수 있습니다.'))
})

test('개발 용어 노출 판정은 그대로', () => {
  assert.ok(JARGON.test('TypeError: x is undefined'))
  assert.ok(!JARGON.test('티켓 3건이 있습니다'))
})
