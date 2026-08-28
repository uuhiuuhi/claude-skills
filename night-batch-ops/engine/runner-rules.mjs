// 러너 순수 규칙 — 판정부만 분리(테스트 가능). 원 출처: 2026-08 야간 운영 실사고·개선 원탁 실측.
//
// 왜 별도 파일인가: run-night.mjs 는 import 하는 순간 본문이 실행되는 스크립트라 테스트가
// 물 수 없다. 판정 규칙만 여기로 빼서 vitest 가 실물을 검증한다.

/** 슬롯 모드 한도 대기(분) — lock 을 쥔 장시간 대기가 밤 전체를 인질로 잡는다.
 *  슬롯은 짧게 기다렸다 exit 5 로 빠지고, 이어하기(state.json)는 다음 슬롯/라운드 몫이다. */
export const SLOT_WAIT_AUTH_MIN = 30

export function waitAuthMin(autoPlan, batchVal, defaultVal) {
  if (autoPlan) return SLOT_WAIT_AUTH_MIN
  return batchVal ?? defaultVal ?? 480
}

/** 연속 중단 차단기 갱신 — 한도(exit 5)는 고장이 아니라 날씨다.
 *  5 를 stops 에 세면 한도 두 번에 밤 전체가 「고장」으로 분류된다. */
export function nextStops(prevStops, worstCode) {
  if (worstCode == null) return 0
  if (worstCode === 5) return prevStops
  return prevStops + 1
}

/** 연속 실행 루프 계속 판정 — 루프는 슬롯의 연장이지 새 스케줄러가 아니다.
 *  날짜가 바뀌면(자정) 루프를 끝내고 다음 슬롯의 새 프로세스에 넘긴다 — 자정 롤오버
 *  중복 실행 사고(2026-08-27 실사례)의 재발 방지 로직을 재사용하기 위해서다. */
export function shouldContinueLoop({ autoPlan, dryRun, worstCode, ranCount, startDate, nowDate }) {
  if (!autoPlan || dryRun) return false
  if (worstCode != null) return false // STOP 은 원인 확인이 먼저 — 헛도는 재시도 금지
  if (ranCount === 0) return false // 편성 0 = 오늘 몫 소진
  return startDate === nowDate
}

/** 알림 채널 선택 — 텔레그램(비공개)이 구성돼 있으면 정본, 없으면 공개 ntfy 폴백,
 *  둘 다 없으면 무음. 공개 ntfy 주제는 주제 이름만 알면 누구나 읽는다. */
export function notifyChannel({ telegramReady, ntfyReady }) {
  if (telegramReady) return 'telegram'
  if (ntfyReady) return 'ntfy'
  return 'silent'
}

/** 가드 정지 시 하루 상한 원장 환불 — 실사고(2026-08-27): 편성기가 picked 전체를 원장에
 *  선기록한 뒤 라운드가 STOP 으로 조기 종료되면, 미실행분이 기록만 남아 같은 날 이후
 *  슬롯의 remaining 이 0 이 된다(밤 전체 공전). 환불 대상은 **실행을 시작도 못 한 배치의
 *  스토리만** — 멈춘 배치는 일부 실행됐으므로 비수렴 상한(규칙 9) 집계에 남긴다.
 *  키당 1회만 제거(앞 라운드의 정당한 기록 보존). 원본 배열 불변. */
export function refundUnrun(planned, refundKeys) {
  const next = [...planned]
  for (const key of refundKeys) {
    const i = next.indexOf(key)
    if (i >= 0) next.splice(i, 1)
  }
  return next
}

/** 차단기 창(window) 식별 — 낮 사고가 밤 편성을 죽이지 않게 stops 를 달력 날짜가 아니라
 *  「낮 창 / 밤 창」 단위로 센다(실사고: 낮 가드 정지 1회 + 밤 실패 1회가 달력일 합산 2회로
 *  읽혀 밤 전체가 중단됐다). 낮 창 = 06:00~17:59(`<날짜>-day`), 밤 창 = 18:00~다음날
 *  05:59(시작 날짜 앵커 `<날짜>-night`). 상한 2회는 창 안에서 유지된다. */
export function stopWindowId(d) {
  const p = (n) => String(n).padStart(2, '0')
  const ymd = (x) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
  const h = d.getHours()
  if (h >= 6 && h < 18) return `${ymd(d)}-day`
  const anchor = h >= 18 ? d : new Date(d.getTime() - 24 * 60 * 60 * 1000)
  return `${ymd(anchor)}-night`
}

/** 병렬 실행 판정 — dev 단계 전용 · 스토리 2개+ · 큐가 parallel 을 켠 배치만.
 *  상한 3 하드캡(동시 세션은 사용량 한도를 배로 태운다 — 기본 권장 2).
 *  그 외 전부 1(= 현행 순차 경로 그대로). */
export const PARALLEL_MAX = 3
export function parallelPlan({ storyCount, stages, parallel }) {
  if (!Number.isInteger(parallel) || parallel < 2) return 1
  // dev 전용뿐 아니라 dev+review(신규 스토리) 배치도 병렬 대상 — 각 워크트리 안에서
  // dev→qa→review 까지 돌고 커밋 1개로 landing 한다. create 는 스토리 파일 실재 시 skip 되고
  // File List 실측 대조(호출부)가 그 실재를 전제한다. dev 없는 배치(재검수 등)는 순차.
  if (!Array.isArray(stages) || !stages.includes('dev')) return 1
  if (stages.some((s) => !['create', 'dev', 'review'].includes(s))) return 1
  if (!Number.isInteger(storyCount) || storyCount < 2) return 1
  return Math.min(parallel, PARALLEL_MAX, storyCount)
}

/** 공유 장부 파일 — 거의 모든 dev 가 함께 고치는 문서. File List 겹침 판정에서 제외한다
 *  (landing 의 cherry-pick 3-way 가 줄 단위로 합치고, 충돌 나면 그 스토리만 landing 실패 폴백). */
export const SHARED_BOOKKEEPING = Object.freeze([
  '_bmad-output/implementation-artifacts/sprint-status.yaml',
  '_bmad-output/implementation-artifacts/deferred-work.md',
  '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md',
])

/** 스토리 md 의 File List 절 파싱 — `## File List`/`### File List` 아래 불릿의 경로(백틱 우선).
 *  절이 없으면 null(호출부는 순차 폴백 — 모르는 채 병렬로 돌리지 않는다). */
export function parseFileList(md) {
  const text = String(md ?? '')
  const at = text.search(/^#{2,3} File List\s*$/m)
  if (at < 0) return null
  const files = []
  for (const line of text.slice(at).split('\n').slice(1)) {
    if (/^#{1,6} /.test(line)) break
    const b = /^\s*[-*]\s+(.+)$/.exec(line)
    if (!b) continue
    const code = /`([^`]+)`/.exec(b[1])
    const raw = (code ? code[1] : b[1].split(/[\s(]/)[0]).trim().replace(/\\/g, '/')
    if (raw) files.push(raw)
  }
  return files
}

/** File List 겹침 — 공유 장부 제외 후 서로 다른 스토리가 같은 파일을 만지면 true(병렬 불가). */
export function fileListConflicts(lists) {
  const owner = new Map()
  for (let i = 0; i < (lists ?? []).length; i++) {
    for (const f of lists[i] ?? []) {
      if (SHARED_BOOKKEEPING.includes(f)) continue
      if (owner.has(f) && owner.get(f) !== i) return true
      owner.set(f, i)
    }
  }
  return false
}
