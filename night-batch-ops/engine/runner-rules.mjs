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
