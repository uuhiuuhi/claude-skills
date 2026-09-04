// OPS-2 — 러너 판정 규칙(2026-08-27 배치 개선 원탁 #1·#2·#3·#6 + 알림 채널). 러너 본문
// (run-night.mjs)은 import 즉시 실행되는 스크립트라 물 수 없어, 판정부(runner-rules.mjs)를 문다.
// node --test 이식본 — 원본: jng-os tests/auto/runner-rules.test.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CHAIN_MAX_AGE_DAYS, GATE_EXECUTABLES, LOCK_HB_STALE_MS, PARALLEL_MAX, SLOT_WAIT_AUTH_MIN, allowNewUnderChain, conflictFingerprint, downSyncDecision, fileListConflicts, inheritPlan, integrationGateInvocation, landingResolution, limitRefundKeys, lockAction, nextStops, notifyChannel, parallelPlan, parseFileList, progressedStoryKeys, refundUnrun, roundDidRealWork, shouldContinueLoop, spendBlockNotice, stopBlocked, stopRecord, stopWindowId, stripConflictMarkers, waitAuthMin } from './runner-rules.mjs'

const RUN_NIGHT_URL = new URL('./run-night.mjs', import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const tmpRoots = []
const mkTmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmpRoots.push(d); return d }
after(() => { for (const d of tmpRoots) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 잠긴 파일은 OS 가 정리 */ } } })

describe('[OPS-2] 러너 판정 규칙', () => {
  it('한도 대기 — 슬롯 모드는 30분 고정(lock 인질 방지) · 수동은 배치값>기본값>480', () => {
    assert.equal(waitAuthMin(true, 480, 480), SLOT_WAIT_AUTH_MIN)
    assert.equal(waitAuthMin(false, 60, 480), 60)
    assert.equal(waitAuthMin(false, undefined, 240), 240)
    assert.equal(waitAuthMin(false, undefined, undefined), 480)
  })

  it('차단기 — exit 5(한도)는 stops 에 세지 않는다 · 성공은 0 리셋 · 실패는 +1', () => {
    assert.equal(nextStops(1, 5), 1) // 한도는 고장이 아니라 날씨
    assert.equal(nextStops(0, 5), 0)
    assert.equal(nextStops(1, null), 0)
    assert.equal(nextStops(1, 1), 2)
    assert.equal(nextStops(0, 4), 1)
  })

  it('연속 루프 — 완주+같은 날짜만 계속 · 자정 경과/STOP/편성 0/dry-run 은 종료', () => {
    // roundDidRealWork 는 OPS-7 신설 입력 — 「실작업 있었다」가 기존 판정의 전제다(아래 OPS-7 케이스 참조)
    const base = { autoPlan: true, dryRun: false, worstCode: null, ranCount: 2, startDate: '2026-08-27', nowDate: '2026-08-27', roundDidRealWork: true }
    assert.equal(shouldContinueLoop(base), true)
    assert.equal(shouldContinueLoop({ ...base, nowDate: '2026-08-28' }), false) // 자정 가드(02:49 사고 재발 방지)
    assert.equal(shouldContinueLoop({ ...base, worstCode: 5 }), false) // STOP 은 원인 확인 먼저 — 즉시 재시도 금지
    assert.equal(shouldContinueLoop({ ...base, worstCode: 1 }), false)
    assert.equal(shouldContinueLoop({ ...base, ranCount: 0 }), false)
    assert.equal(shouldContinueLoop({ ...base, dryRun: true }), false)
    assert.equal(shouldContinueLoop({ ...base, autoPlan: false }), false)
  })

  it('차단기 창 — 낮(06~18)과 밤(18~익일 06)을 가르고, 새벽은 전날 밤 창에 앵커된다', () => {
    // 2026-08-27 실사고: 낮 14:00 exit 6 이 밤 stops 에 합산돼 밤 전체가 중단됐다 — 창을 가른다
    assert.equal(stopWindowId(new Date(2026, 7, 27, 14, 0)), '2026-08-27-day')
    assert.equal(stopWindowId(new Date(2026, 7, 27, 6, 0)), '2026-08-27-day')
    assert.equal(stopWindowId(new Date(2026, 7, 27, 17, 59)), '2026-08-27-day')
    assert.equal(stopWindowId(new Date(2026, 7, 27, 18, 0)), '2026-08-27-night')
    assert.equal(stopWindowId(new Date(2026, 7, 27, 22, 0)), '2026-08-27-night')
    assert.equal(stopWindowId(new Date(2026, 7, 28, 2, 0)), '2026-08-27-night') // 새벽 = 전날 밤 창
    assert.equal(stopWindowId(new Date(2026, 7, 28, 5, 59)), '2026-08-27-night')
    assert.equal(stopWindowId(new Date(2026, 8, 1, 0, 30)), '2026-08-31-night') // 월 경계
  })

  it('알림 채널 — 텔레그램 구성 시 정본 · 아니면 ntfy 폴백 · 둘 다 없으면 무음', () => {
    assert.equal(notifyChannel({ telegramReady: true, ntfyReady: true }), 'telegram')
    assert.equal(notifyChannel({ telegramReady: false, ntfyReady: true }), 'ntfy')
    assert.equal(notifyChannel({ telegramReady: false, ntfyReady: false }), 'silent')
  })

  it('[OPS-4] 병렬 계획 — dev 포함 배치·2스토리+·parallel 옵트인 · 상한 3 하드캡 (👤 08-28 확장: dev+review 신규도 병렬)', () => {
    assert.equal(parallelPlan({ storyCount: 2, stages: ['dev'], parallel: 2 }), 2)
    assert.equal(parallelPlan({ storyCount: 5, stages: ['dev'], parallel: 8 }), PARALLEL_MAX) // 상한 제거 뮤테이션 → RED
    assert.equal(parallelPlan({ storyCount: 2, stages: ['dev'], parallel: undefined }), 1) // 옵트인 없으면 현행 순차
    assert.equal(parallelPlan({ storyCount: 1, stages: ['dev'], parallel: 2 }), 1)
    assert.equal(parallelPlan({ storyCount: 3, stages: ['dev', 'review'], parallel: 2 }), 2) // 신규(dev+review) 병렬 — 08-28 확장
    assert.equal(parallelPlan({ storyCount: 2, stages: ['create', 'dev', 'review'], parallel: 2 }), 2) // create 는 스펙 실재 시 skip
    assert.equal(parallelPlan({ storyCount: 2, stages: ['review'], parallel: 2 }), 2) // review 전용(재검수)도 병렬 — 👤 2026-09-04 「리뷰 병렬 만들어」
    assert.equal(parallelPlan({ storyCount: 2, stages: ['create'], parallel: 2 }), 1) // create·mockup 만 있는 배치는 순차
    assert.equal(parallelPlan({ storyCount: 2, stages: ['mockup', 'review'], parallel: 2 }), 1) // mockup 은 공유 장부 — 순차
    assert.equal(parallelPlan({ storyCount: 3, stages: ['dev'], parallel: 3 }), 3)
  })

  it('[OPS-4] File List 파싱·겹침 — 공유 장부(sprint-status 등)는 제외, 실파일 겹침만 병렬 불가', () => {
    const md = '# S\n## Dev Notes\n\n## File List\n\n- `src/a.ts` (신규)\n- tests/a.test.ts\n- _bmad-output/implementation-artifacts/sprint-status.yaml\n\n## Change Log\n- x'
    assert.deepEqual(parseFileList(md), ['src/a.ts', 'tests/a.test.ts', '_bmad-output/implementation-artifacts/sprint-status.yaml'])
    assert.equal(parseFileList('# 절 없음'), null) // 모르는 채 병렬 금지 — 호출부 순차 폴백
    const A = ['src/a.ts', '_bmad-output/implementation-artifacts/sprint-status.yaml']
    const B = ['src/b.ts', '_bmad-output/implementation-artifacts/sprint-status.yaml']
    assert.equal(fileListConflicts([A, B]), false) // 공유 장부만 겹침 = 병렬 가능(landing 3-way 몫)
    assert.equal(fileListConflicts([A, ['src/a.ts']]), true) // 실파일 겹침 — 겹침 허용 뮤테이션 → RED
    assert.equal(fileListConflicts([A]), false)
    assert.equal(fileListConflicts([]), false)
  })

  it('원장 환불 — 미실행 키만 1회씩 제거 · 없는 키 무시 · 원본 불변 (2026-08-27 14:00 exit 6 실사고)', () => {
    const planned = ['2-1', '2-2', '2-3', '2-9', '2-10']
    // 12 편성·2 실행 후 STOP 시나리오 축소판: 미실행 3건 환불 → 실행분 2건만 남는다
    assert.deepEqual(refundUnrun(planned, ['2-3', '2-9', '2-10']), ['2-1', '2-2'])
    // 같은 키가 앞 라운드에서 정당하게 2회 기록됐으면 1회만 환불(규칙 9 집계 보존)
    assert.deepEqual(refundUnrun(['2-1', '2-3', '2-3'], ['2-3']), ['2-1', '2-3'])
    // 원장에 없는 키(수동 큐 스토리 등)는 무시 — 오염 없음
    assert.deepEqual(refundUnrun(['2-1'], ['9-9']), ['2-1'])
    // 원본 배열 불변
    assert.equal(planned.length, 5)
  })

  it('landing 자동 해소 판정 — 로그 union·state ours·공유 장부 union, 그 외 1건이라도 섞이면 null (2026-08-28 11-4∥11-7 실사고)', () => {
    const LOGS = '_bmad-output/implementation-artifacts/auto-pipeline-logs'
    assert.deepEqual(landingResolution([`${LOGS}/run-summary.log`]), { [`${LOGS}/run-summary.log`]: 'union' })
    assert.deepEqual(landingResolution([`${LOGS}/state.json`]), { [`${LOGS}/state.json`]: 'ours' })
    assert.deepEqual(landingResolution(['_bmad-output/implementation-artifacts/DECISIONS-INBOX.md']),
      { '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md': 'union' })
    // 실사고 재현 — 세 파일 혼합은 전부 해소 가능
    assert.deepEqual(landingResolution([`${LOGS}/run-summary.log`, `${LOGS}/state.json`, '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md']),
      {
        [`${LOGS}/run-summary.log`]: 'union',
        [`${LOGS}/state.json`]: 'ours',
        '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md': 'union',
      })
    // 코드 파일이 하나라도 섞이면 전체 null — 자동으로 뭉개지 않는다(보존 폴백)
    assert.equal(landingResolution([`${LOGS}/run-summary.log`, 'src/features/billing/billingLogic.ts']), null)
    assert.equal(landingResolution(['tools/auto/run-night.mjs']), null)
    // 빈 목록·공백뿐 = null(해소할 것이 없다 ≠ 성공) · Windows 역슬래시 정규화
    assert.equal(landingResolution([]), null)
    assert.deepEqual(landingResolution([`${LOGS.replaceAll('/', '\\')}\\run-summary.log`]), { [`${LOGS}/run-summary.log`]: 'union' })
  })

  it('[OPS-7] 공회전 — 라운드 실작업 0 이면 루프 종료 · 기존 판정은 불변 (2026-08-29 새벽 13회 재편성 실사고)', () => {
    const base = { autoPlan: true, dryRun: false, worstCode: null, ranCount: 2, startDate: '2026-08-29', nowDate: '2026-08-29' }
    // ① 실작업 true → 기존 판정 그대로
    assert.equal(shouldContinueLoop({ ...base, roundDidRealWork: true }), true)
    // ② 실작업 false → 종료 (판정을 항상 true 로 바꾸는 뮤테이션 → 여기가 RED)
    assert.equal(shouldContinueLoop({ ...base, roundDidRealWork: false }), false)
    // 모르면 멈춘다 — 헛돌면 밤새 커밋 오염·알림 폭주, 잘못 멈춰도 다음 슬롯이 이어받는다
    assert.equal(shouldContinueLoop({ ...base, roundDidRealWork: undefined }), false)
    // 기존 종료 조건은 실작업 true 여도 그대로 (STOP · 자정 · 편성 0 · dry-run)
    assert.equal(shouldContinueLoop({ ...base, roundDidRealWork: true, worstCode: 1 }), false)
    assert.equal(shouldContinueLoop({ ...base, roundDidRealWork: true, nowDate: '2026-08-30' }), false)
    assert.equal(shouldContinueLoop({ ...base, roundDidRealWork: true, ranCount: 0 }), false)
    assert.equal(shouldContinueLoop({ ...base, roundDidRealWork: true, dryRun: true }), false)
  })

  it('[OPS-7] 실작업 판정 — 로그 폴더 밖 파일 1건이라도 있으면 true · 로그뿐/커밋 0 은 false', () => {
    const LOGS = '_bmad-output/implementation-artifacts/auto-pipeline-logs'
    // 실사고 재현: 엔진이 전 단계를 skip 하고 자기 로그 2파일만 커밋한 채 exit 0
    assert.equal(roundDidRealWork([[`${LOGS}/run-summary.log`, `${LOGS}/state.json`]]), false)
    assert.equal(roundDidRealWork([]), false) // 새 커밋 0건
    assert.equal(roundDidRealWork([[]]), false) // 빈 커밋
    assert.equal(roundDidRealWork(undefined), false)
    // 로그 + 소스 혼합 = 실작업 (라운드가 뭐라도 전진시켰다)
    assert.equal(roundDidRealWork([[`${LOGS}/run-summary.log`], ['src/features/billing/billingLogic.ts']]), true)
    assert.equal(roundDidRealWork([[`${LOGS}/run-summary.log`, 'tests/auto/runner-rules.test.ts']]), true)
    // 스토리 md·상태 장부 전진도 실작업이다 — 로그 폴더 밖이면 전부 true
    assert.equal(roundDidRealWork([['_bmad-output/implementation-artifacts/sprint-status.yaml']]), true)
    // Windows 역슬래시 정규화 · 공백 항목 무시
    assert.equal(roundDidRealWork([[`${LOGS.replaceAll('/', '\\')}\\run-summary.log`, '  ']]), false)
    // 폴더 이름만 같고 접두사가 다른 경로는 로그가 아니다(경계)
    assert.equal(roundDidRealWork([['tools/auto-pipeline-logs/x.log']]), true)
  })

  it('충돌 마커 union — 양쪽 순서대로 보존 · diff3 base 폐기 · 비정형 잔존은 null', () => {
    assert.equal(stripConflictMarkers('<<<<<<< HEAD\nA줄\n=======\nB줄\n>>>>>>> pick\n'), 'A줄\nB줄\n')
    // diff3 스타일: base 구간은 버리고 양쪽만
    assert.equal(stripConflictMarkers('<<<<<<< HEAD\nA\n||||||| base\n원본\n=======\nB\n>>>>>>> x\n'), 'A\nB\n')
    // 마커 없는 원문은 그대로
    assert.equal(stripConflictMarkers('그냥 줄\n'), '그냥 줄\n')
    // 처리 후에도 7연속 마커가 남는 비정형은 null — 호출부 보존 폴백
    assert.notEqual(stripConflictMarkers('<<<<<<< a\n<<<<<<<< 여덟개는 내용\n=======\nB\n>>>>>>> x\n'), null)
    assert.equal(stripConflictMarkers('내용\n======= 뒤에 말 붙은 줄은 마커 아님\n'), '내용\n======= 뒤에 말 붙은 줄은 마커 아님\n')
  })
})

describe('[무정지] Non-Stop 판정부 (2026-08-30 적대 리뷰 wf_b8f76633 확정 20건 반영)', () => {
  it('lock v2 — pid 생존만 양보 · ESRCH 사망은 탈취 · 판정 불능(EPERM)은 심박 6h 로 가른다 (발견 2·5)', () => {
    assert.equal(lockAction({ exists: false, parseOk: false, pidAlive: 'unknown', hbAgeMs: 0 }), 'acquire')
    assert.equal(lockAction({ exists: true, parseOk: true, pidAlive: true, hbAgeMs: 0 }), 'skip-alive')
    assert.equal(lockAction({ exists: true, parseOk: true, pidAlive: false, hbAgeMs: 0 }), 'takeover') // 08-29 18:00 이중 기동의 반대면 — 죽은 lock 이 밤을 잠그지 않는다
    // EPERM 등 판정 불능: 심박 신선 → 보수적 양보(skip-unknown · 알림 의무는 호출부), 심박 6h+ → 탈취
    assert.equal(lockAction({ exists: true, parseOk: true, pidAlive: 'unknown', hbAgeMs: LOCK_HB_STALE_MS - 1 }), 'skip-unknown')
    assert.equal(lockAction({ exists: true, parseOk: true, pidAlive: 'unknown', hbAgeMs: LOCK_HB_STALE_MS + 1 }), 'takeover')
    assert.equal(lockAction({ exists: true, parseOk: true, pidAlive: 'unknown', hbAgeMs: undefined }), 'takeover') // 심박 없음 = Infinity
    // JSON 손상(구버전 lock 포함)도 심박으로 가른다 — 즉시 탈취하면 실행 중 러너를 밟는다
    assert.equal(lockAction({ exists: true, parseOk: false, pidAlive: 'unknown', hbAgeMs: 1000 }), 'skip-unknown')
    assert.equal(lockAction({ exists: true, parseOk: false, pidAlive: 'unknown', hbAgeMs: LOCK_HB_STALE_MS + 1 }), 'takeover')
  })

  it('STOP 차단기 v2 — 같은 원인 서명 2회만 차단 · 다른 원인은 계속 · 창 누적 4회 백스톱 (발견 17)', () => {
    let w = stopRecord(undefined, 1, 'A')
    assert.equal(stopBlocked(w), false) // 첫 실패 1회로는 안 막는다
    w = stopRecord(w, 1, 'A')
    assert.equal(stopBlocked(w), true) // 같은 서명 2회 — 같은 원인 재시도만 차단
    // 다른 원인들이 흩어져 있으면 계속 — 통짜 차단(구 stops>=2)이 만들던 11시간 휴면의 반대면
    let v = stopRecord(undefined, 1, 'A')
    v = stopRecord(v, 6, 'B')
    v = stopRecord(v, 2, 'C')
    assert.equal(stopBlocked(v), false) // 서명 3종 각 1회 · total 3
    v = stopRecord(v, 4, 'D')
    assert.equal(stopBlocked(v), true) // 창 누적 4회 = 폭주 백스톱
    // 성공은 서명 스트릭 소거(total 은 백스톱용으로 유지) · exit 5 는 날씨(무변)
    const s = stopRecord(undefined, 1, 'A')
    const afterOk = stopRecord(s, null)
    assert.deepEqual(afterOk.sigs, {})
    assert.equal(afterOk.stops, 0)
    assert.equal(afterOk.total, 1)
    assert.deepEqual(stopRecord(s, 5, 'A'), s)
    assert.equal(s.sigs['1|A'], 1) // 원본 불변
    assert.equal(stopBlocked(undefined), false)
  })

  it('하향 동기 처분 — 로그·장부 충돌은 자동 해소 · 문서만 남으면 동기 보류(밤 계속) · 코드는 휴면 (발견 1·12·19)', () => {
    const LOGS = '_bmad-output/implementation-artifacts/auto-pipeline-logs'
    assert.deepEqual(downSyncDecision([]), { mode: 'resolve', plan: {} })
    assert.equal(downSyncDecision([`${LOGS}/run-summary.log`, `${LOGS}/state.json`]).mode, 'resolve')
    assert.deepEqual(downSyncDecision([`${LOGS}/run-summary.log`]).plan, { [`${LOGS}/run-summary.log`]: 'union' })
    // 2026-09-02 개정 — 스토리 문서 충돌은 ours(러너 산출 유지)로 해소하고 머지를 성사시킨다.
    // 종전 defer 는 백스톱과 결합해 19시간 38분 미동기를 만들었다(같은 날 실사고 — 아침 정식 머지 충돌 0 실측).
    assert.deepEqual(downSyncDecision(['_bmad-output/implementation-artifacts/4-5-x.md']), {
      mode: 'resolve', plan: { '_bmad-output/implementation-artifacts/4-5-x.md': 'ours' },
    })
    // 스토리 md + 공유 장부 혼재(실사고 재료 그대로) — md 는 ours · 장부는 union 으로 갈려 함께 풀린다
    assert.deepEqual(downSyncDecision([
      '_bmad-output/implementation-artifacts/11-5-x.md',
      '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md',
    ]), {
      mode: 'resolve', plan: {
        '_bmad-output/implementation-artifacts/11-5-x.md': 'ours',
        '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md': 'union',
      },
    })
    // 코드 파일이 섞이면 이 라운드 휴면 — ③류 오염(검토 없는 자동 해소)의 재발 방지선
    assert.equal(downSyncDecision(['src/features/billing/billingLogic.ts']).mode, 'halt')
    assert.equal(downSyncDecision([`${LOGS}/run-summary.log`, 'tools/auto/run-night.mjs']).mode, 'halt')
    assert.equal(downSyncDecision([`${LOGS.replaceAll('/', '\\')}\\state.json`]).mode, 'resolve') // 역슬래시 정규화
    // 반복 백스톱 재료 — 지문은 순서 무관 동일
    assert.equal(conflictFingerprint(['b.md', 'a.md']), conflictFingerprint(['a.md', 'b.md']))
    assert.equal(conflictFingerprint([]), '')
  })

  it('선형 승계 — 최신 날짜 브랜치 기준(원격 우선) · 체인 나이 = 최고령 미머지→오늘 (발견 6·16)', () => {
    assert.equal(inheritPlan([], '2026-08-30'), null)
    assert.equal(inheritPlan(['feature/x', 'origin/main'], '2026-08-30'), null) // 날짜 auto 만 승계 대상
    const p = inheritPlan(['origin/auto/2026-08-30', 'auto/2026-08-30', 'origin/auto/2026-08-29'], '2026-08-30')
    assert.equal(p?.ref, 'origin/auto/2026-08-30') // 같은 날짜면 원격 우선 — push 된 것이 공유 사실
    assert.equal(p?.chainAgeDays, 1) // 최고령 08-29 → 오늘 08-30
    assert.equal(p?.branches.length, 3)
    assert.equal(inheritPlan(['auto/2026-08-30'], '2026-08-30')?.chainAgeDays, 0) // 오늘 것뿐 = 나이 0
    // 체인 게이트: 2일 미만만 신규 허용 — 사람 검토 없는 축조의 총량 상한
    assert.equal(CHAIN_MAX_AGE_DAYS, 2)
    assert.equal(allowNewUnderChain(0), true)
    assert.equal(allowNewUnderChain(1), true)
    assert.equal(allowNewUnderChain(2), false)
    assert.equal(allowNewUnderChain(undefined), true)
  })

  it('exit 5 환불 — 라운드 커밋이 스토리 md 를 안 만진 키만 환불 · 진전 키 추출은 로그 제외 (발견 3·4)', () => {
    const commits = [['_bmad-output/implementation-artifacts/2-1-a.md', 'src/a.ts']]
    assert.deepEqual(limitRefundKeys(['2-1-a', '2-2-b'], commits), ['2-2-b']) // 만진 키는 정당 소모 — 환불 없음
    assert.deepEqual(limitRefundKeys(['2-1-a'], []), ['2-1-a']) // 커밋 0 = 전액 환불
    assert.deepEqual(limitRefundKeys([], commits), [])
    assert.deepEqual(limitRefundKeys(['2-1-a'], [['_bmad-output\\implementation-artifacts\\2-1-a.md']]), []) // 역슬래시
    // 규칙 9 v2 의 진전 재료 — 스토리 md 키만, 로그 폴더·비스토리 파일은 제외, 중복 1회
    assert.deepEqual(progressedStoryKeys(commits), ['2-1-a'])
    assert.deepEqual(progressedStoryKeys([['_bmad-output/implementation-artifacts/sprint-status.yaml', 'src/a.ts']]), [])
    assert.deepEqual(progressedStoryKeys([['_bmad-output/implementation-artifacts/2-1-a.md'], ['_bmad-output/implementation-artifacts/2-1-a.md']]), ['2-1-a'])
    assert.deepEqual(progressedStoryKeys(undefined), [])
  })

  // 2026-08-30 실사고 — 편성 0건 교착의 뿌리. git 은 core.quotepath 기본값에서 비ASCII 경로를
  // 큰따옴표 + 8진 이스케이프로 내보낸다("…/4-6-\352\270\260….md"). 이 저장소의 스토리 md 는
  // **전부 한글명**이라, 파일 목록을 읽는 git 호출에 이 플래그가 빠지면 progressedStoryKeys 가
  // 언제나 [] 를 돌려주고 → 규칙 9 v2 의 「진전 시 리셋」이 영구 미발동 → 스트릭이 무한 누적돼
  // 전 스토리가 잠긴다(실제로 55건 전건 제외 · 슬롯 3회 연속 0건). downSyncDecision 도 같은
  // 입력을 받아 docOnly 판정이 뒤집혀 defer 대신 halt 로 빠진다.
  // 기존 테스트가 ASCII 키(2-1-a)만 물어서 이 갈래가 통째로 비어 있었다.
  it('진전 추출 — git 인용 경로(비ASCII 8진 이스케이프)는 매칭되지 않는다 · 그래서 파일 목록 git 호출은 core.quotepath=false 필수', () => {
    const 한글키 = '4-6-기간형-업무-보고서-주간-월간'
    const 원문 = `_bmad-output/implementation-artifacts/${한글키}.md`
    const 인용본 = '"_bmad-output/implementation-artifacts/4-6-\\352\\270\\260\\352\\260\\204\\355\\230\\225.md"'

    assert.deepEqual(progressedStoryKeys([[원문]]), [한글키]) // 원문 UTF-8 이면 잡힌다
    assert.deepEqual(progressedStoryKeys([[인용본]]), []) // 인용본이면 조용히 0건 — 이것이 교착의 실체다
    assert.deepEqual(limitRefundKeys([한글키], [[인용본]]), [한글키]) // 환불도 같이 오작동한다
    assert.equal(downSyncDecision([인용본]).mode, 'halt') // 문서 전용인데 defer 가 아니라 halt 로 빠진다

    // 러너 본문은 import 즉시 실행이라 물 수 없다 → 소스를 읽어 **파일 목록을 내는 git 호출 전건**이
    // 플래그를 달았는지 정적으로 판정한다(호출이 늘어도 이 단언이 함께 늘어난다).
    // 이식 주석: 이식본 러너는 `core.quotePath` 표기(대문자 P)를 쓴다 — git 설정 키는 대소문자를
    // 구분하지 않으므로 의미는 동일하다. 키 표기만 대소문자 무관으로 맞춘다.
    const src = readFileSync(RUN_NIGHT_URL, 'utf8')
    const 파일목록호출 = [...src.matchAll(/spawnSync\('git',\s*\[([^\]]*)\]/g)]
      .map((m) => m[1])
      .filter((args) => /'--name-only'|'--name-status'/.test(args))
    assert.ok(파일목록호출.length > 0) // 앵커가 사라지면 이 가드가 조용히 통과하지 않게
    for (const args of 파일목록호출) assert.match(args, /'core\.quotepath=false'/i)
  })

  // 위 테스트는 「소스에 플래그가 있다」까지만 문다(anchor-only · codex-review-r2 §4).
  // 여기서는 **실제 git 저장소에 한글 파일명을 커밋해** 플래그가 있고 없고가 무엇을 바꾸는지 실행으로 본다 —
  // 플래그가 없으면 러너가 받는 문자열이 8진 인용본이 되고, 그 입력에서 progressedStoryKeys 가 0건이 된다.
  it('[실동작] 한글 스토리 md 를 실제로 커밋해 본다 — quotePath 기본값이면 진전 0건, false 면 잡힌다', () => {
    const repo = mkTmp('nbo-quotepath-')
    const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    assert.equal(git('init', '-q', '-b', 'main').status, 0)
    git('config', 'user.email', 'q@test'); git('config', 'user.name', 'q'); git('config', 'core.quotepath', 'true')
    const key = '4-6-기간형-업무-보고서-주간-월간'
    const rel = `_bmad-output/implementation-artifacts/${key}.md`
    mkdirSync(join(repo, '_bmad-output', 'implementation-artifacts'), { recursive: true })
    writeFileSync(join(repo, rel), '# 한글 스토리\n', 'utf8')
    assert.equal(git('add', '-A').status, 0)
    assert.equal(git('commit', '-qm', 'korean story').status, 0)

    const names = (extra) => (spawnSync('git', ['-C', repo, ...extra, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).stdout ?? '')
      .split('\n').map((l) => l.trim()).filter(Boolean)
    const 기본 = names([]) // 러너가 플래그를 빠뜨렸을 때 실제로 받는 문자열
    const 플래그 = names(['-c', 'core.quotePath=false'])

    assert.ok(기본[0].startsWith('"') && /\\3\d\d/.test(기본[0]), `git 이 8진 인용본을 내야 이 테스트가 의미 있다: ${기본[0]}`)
    assert.deepEqual(플래그, [rel])
    assert.deepEqual(progressedStoryKeys([기본]), [], '플래그 없이는 진전이 0건으로 보인다(= 규칙 9 영구 잠금)')
    assert.deepEqual(progressedStoryKeys([플래그]), [key], '플래그가 있으면 실제로 잡힌다')
    assert.deepEqual(limitRefundKeys([key], [플래그]), [], '만진 키는 환불되지 않는다')
    assert.deepEqual(limitRefundKeys([key], [기본]), [key], '플래그 없이는 실작업분까지 환불된다')
  })
})

// ── 무인 실행 지출 한도 차단 알림 (2026-08-30 실사고 회수) ──
//
// 실사고: 14:11 부터 9시간 동안 30분마다 같은 알림이 **20회** 나갔고, 그 본문은 원인을
// 「결정 대기가 스토리 N개를 막는 중」이라고 엉뚱하게 말했다. 사장은 그 문장에서 지출 한도를
// 떠올릴 수 없다 — 알림 피로로 실제로 무시됐고, 사람이 물어볼 때까지 아무도 몰랐다.
describe('[OPS] 지출 한도 차단 알림 — 원인을 말하고, 반복하지 않고, 경과를 알린다', () => {
  const iso = (min) => new Date(Date.UTC(2026, 7, 30, 5, 0) + min * 60000).toISOString()

  it('첫 회는 반드시 말한다 — 그리고 원인·조치처·「사람만 풀 수 있다」가 본문에 있다', () => {
    const n = spendBlockNotice({ streak: 1, firstIso: iso(0), nowIso: iso(0) })
    assert.equal(n.speak, true)
    assert.ok(n.title.includes('계정 지출 한도'))
    // 이식판은 프로젝트 중립 문구(「요금제 사용량 설정」)를 쓴다 — 조치처가 본문에 있으면 된다(원본은 claude.ai URL 을 박았다)
    assert.match(n.body, /settings\/usage|사용량 설정/)
    assert.ok(n.body.includes('사람만 할 수 있다'))
    // 원인 오인 방지 — 모델·인증 문제가 아니라는 사실이 본문에 있어야 한다
    assert.match(n.body, /모델·인증·환경 문제가 아니다/)
  })

  it('30분마다 같은 말을 하지 않는다 — 첫 회 뒤에는 2시간마다(슬롯 4회마다)만', () => {
    const speaks = [1, 2, 3, 4, 5, 6, 7, 8].map(
      (streak) => spendBlockNotice({ streak, firstIso: iso(0), nowIso: iso(streak * 30) }).speak === true,
    )
    assert.deepEqual(speaks, [
      true, false, false, true, false, false, false, true,
    ], '알림 억제가 없다 — 20회 반복이 재발한다')
  })

  it('경과 시간을 말한다 — 「N시간째」가 있어야 사람이 심각도를 안다', () => {
    const n = spendBlockNotice({ streak: 8, firstIso: iso(0), nowIso: iso(245) })
    assert.equal(n.speak, true)
    assert.ok(n.title.includes('4시간 5분째'))
    assert.ok(n.title.includes('연속 8회'))
  })

  it('차단이 아니면 조용하다 — streak 0·음수·비정수는 speak=false', () => {
    for (const streak of [0, -1, 1.5, Number.NaN]) {
      assert.equal(spendBlockNotice({ streak, firstIso: iso(0), nowIso: iso(30) }).speak, false)
    }
  })

  it('러너가 이 판정을 실제로 쓴다 — 배선이 죽으면 알림이 종전 문구로 돌아간다 (앵커 · 실동작은 e2e-parallel.test.mjs 의 [OPS] 지출 한도 차단 describe)', () => {
    const runner = readFileSync(RUN_NIGHT_URL, 'utf8')
    assert.ok(runner.includes('spendBlockNotice({'), '러너가 spendBlockNotice 를 부르지 않는다')
    // 한 건도 못 한 exit 5 라운드만 지출 차단으로 센다(부분 성공은 종전 요약 그대로)
    assert.ok(runner.includes("worst?.code === 5 && done === 0"), '지출 차단 판정이 「exit 5 + 실행 0」이 아니다')
    // 성공 라운드가 나오면 연속 카운트가 **0 으로** 돌아가야 한다 — 안 그러면 억제가 영구화돼
    // 다음 차단 때 첫 알림조차 안 나간다. 삼항의 else 가지가 그 자리임을 콜론까지 물어 고정한다
    // (러너 본문은 import 즉시 실행이라 함수로 못 문다 — 이 파일 머리의 관례와 같다).
    assert.ok(runner.replace(/\s+/g, ' ').includes(
      ': { streak: 0, firstIso: null }',
    ), '연속 카운트가 0 으로 리셋되지 않는다')
  })
})

// ── 정책 8 / codex-review-r2 — 설치기의 Codex 검사도 셸 문자열 결합을 쓰지 않는다 ──────────────
//
// 종전: `spawnSync('codex --version', { shell: true })`. ① `C:\Program Files\…\codex.cmd` 처럼 공백이
// 든 경로는 실행조차 못 하고 ② 그 값에 `&`·`|` 가 있으면 cmd.exe 가 두 번째 명령을 돌린다.
// 여기서는 **공백이 든 실제 폴더에 가짜 codex 심을 만들어** 설치기를 진짜로 돌린다(예약 등록은 안 한다).
describe('[install] Codex 검사 — 공백 경로 실행 · 셸 메타문자 거부', { timeout: 180_000 }, () => {
  const INSTALLER = join(HERE, '..', 'install.mjs')
  /** 공백이 든 폴더에 가짜 codex 를 만들고, 임시 프로젝트에서 설치기를 돌린다. */
  const runInstaller = ({ codexBin = null, onPath = true, withStub = true } = {}) => {
    const T = mkTmp('nbo-install-')
    const binDir = join(T, 'fake bin dir') // ← 공백 필수. 종전 구현은 여기서 죽었다.
    const proj = join(T, 'proj')
    const home = join(T, 'home')
    for (const d of [binDir, proj, home]) mkdirSync(d, { recursive: true })
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'ins', type: 'module', scripts: { qa: 'node -e 0' } }, null, 2))
    const stub = join(binDir, IS_WIN ? 'codex.cmd' : 'codex')
    if (withStub) {
      writeFileSync(join(binDir, 'codex-stub.mjs'),
        "const a=process.argv.slice(2)\nif(a[0]==='--version'){console.log('codex-cli 9.9.9-space');process.exit(0)}\nif(a[0]==='login'&&a[1]==='status'){console.log('Logged in using ChatGPT');process.exit(0)}\nprocess.exit(1)\n")
      if (IS_WIN) writeFileSync(stub, '@echo off\r\nnode "%~dp0codex-stub.mjs" %*\r\n')
      else writeFileSync(stub, `#!/bin/sh\nexec node "${join(binDir, 'codex-stub.mjs')}" "$@"\n`, { mode: 0o755 })
    }
    const env = {
      ...process.env, USERPROFILE: home, HOME: home, AUTO_BATCH_STATE_DIR: join(T, 'state'),
      // PATH 에서 진짜 codex 를 지운다 — 이 시험이 보는 것은 픽스처 심 하나뿐이어야 한다
      PATH: onPath ? `${binDir}${IS_WIN ? ';' : ':'}${process.env.PATH}` : process.env.PATH,
    }
    if (codexBin !== null) env.CODEX_BIN = codexBin === 'OWN' ? stub : codexBin
    const r = spawnSync(process.execPath, [INSTALLER], { cwd: proj, encoding: 'utf8', timeout: 150_000, maxBuffer: 32 * 1024 * 1024, env })
    return { ...r, out: `${r.stdout}\n${r.stderr}`, T, binDir, stub, proj }
  }

  it('PATH 의 공백 폴더에 있는 codex 심을 실제로 실행한다(버전·로그인 상태를 읽어 낸다)', () => {
    const r = runInstaller()
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.out, /· Codex CLI codex-cli 9\.9\.9-space — 로그인됨/, r.out.slice(-2000))
  })

  it('CODEX_BIN 이 공백 든 절대경로여도 실행된다(PATH 에 없어도)', () => {
    const r = runInstaller({ codexBin: 'OWN', onPath: false })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.out, /· Codex CLI codex-cli 9\.9\.9-space — 로그인됨/, r.out.slice(-2000))
    assert.match(r.stub, / /, '경로에 공백이 없으면 이 시험은 아무것도 증명하지 않는다')
  })

  it('셸 메타문자가 든 CODEX_BIN 은 실행 자체를 거부한다 — 두 번째 명령이 돌지 않는다', () => {
    const T = mkTmp('nbo-install-meta-')
    const marker = join(T, 'PWNED.txt')
    const r = runInstaller({
      onPath: false,
      codexBin: `codex & node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'1')"`,
    })
    assert.equal(r.status, 0, r.out.slice(-2000))
    assert.match(r.out, /· Codex CLI 없음/, '메타문자 값은 「없음」으로 닫혀야 한다')
    assert.ok(!existsSync(marker), '두 번째 명령이 실행됐다 — 셸 결합이 살아 있다')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M5(codex-review-r3 · BRIEF 정책 8) — 통합 게이트도 셸 문자열이 아니라 argv 다.
// `auto.config.json` 의 `qa` 값은 **저장소 안 파일**이라, 종전 `shell:true` 는 그 값을 cmd.exe 구문으로
// 재해석했다. 여기서는 정규화 결과와 **거부**를 함께 문다(실제 실행 경로는 e2e-parallel 이 문다).
describe('[M5] 통합 게이트 명령 정규화 — 셸 문자열 결합 제거', () => {
  it('`npm run qa` 는 argv 로 쪼개지고, Windows 는 `.cmd` 심 전용 경로로 간다', () => {
    const nix = integrationGateInvocation('npm run qa', { platform: 'linux' })
    assert.equal(nix.file, 'npm')
    assert.deepEqual(nix.argv, ['run', 'qa'])
    assert.equal(nix.verbatim, false)

    const win = integrationGateInvocation('npm run qa', { platform: 'win32', comspec: 'cmd.exe' })
    assert.equal(win.file, 'cmd.exe')
    assert.equal(win.argv[0], '/d')
    assert.equal(win.argv[2], '/c')
    assert.match(win.argv[3], /npm\.cmd/)
    assert.equal(win.verbatim, true, '.cmd 심은 재인용을 막아야 한다')
    // 실행파일 토큰에 따옴표를 씌우면 npm.cmd 안의 `%~dp0` 가 현재 폴더로 잡혀 죽는다(2026-09-02 실측).
    assert.ok(!win.argv[3].includes('"npm.cmd"'), `실행파일을 인용하면 %~dp0 가 깨진다: ${win.argv[3]}`)
    assert.equal(win.argv[3], '"npm.cmd "run" "qa""')
  })

  it('`npm run qa` 가 Windows 에서 **실제로 실행된다**(계획이 종이 위에서만 맞는 것이 아니다)', function () {
    if (process.platform !== 'win32') return // 이 회귀는 Windows `.cmd` 심 전용이다
    const T = mkTmp('nbo-gate-npm-')
    writeFileSync(join(T, 'package.json'), JSON.stringify({ name: 'gate-fx', private: true, scripts: { qa: 'node -e 0' } }))
    const inv = integrationGateInvocation('npm run qa')
    const r = spawnSync(inv.file, inv.argv, { cwd: T, encoding: 'utf8', shell: false, windowsVerbatimArguments: inv.verbatim, windowsHide: true })
    assert.equal(r.status, 0, `${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  })

  it('`node tools/qa.mjs` 같은 자유 형식도 실행파일+argv 로 정규화된다(과잉 차단이 아님)', () => {
    const r = integrationGateInvocation('node tools/qa.mjs', { platform: 'win32' })
    assert.equal(r.file, 'node')
    assert.deepEqual(r.argv, ['tools/qa.mjs'])
    assert.equal(r.verbatim, false)
  })

  it('셸 메타문자가 든 게이트 이름·명령은 실행 계획을 만들지 못하고 거부된다', () => {
    for (const bad of [
      'npm run qa && git push origin main',
      'npm run qa; rm -rf /',
      'npm run qa | tee out.txt',
      'npm run $(evil)',
      'npm run `evil`',
      'npm run qa%PATH%',
      'npm run qa > out.txt',
      'npm run qa\nnpm run evil',
      '',
      '   ',
    ]) {
      assert.throws(() => integrationGateInvocation(bad, { platform: 'win32' }), (e) => e.code === 'UNSAFE_GATE', `거부하지 않았다: ${JSON.stringify(bad)}`)
    }
  })

  it('허용 실행파일 밖(curl·wget·sh)은 거부한다 — 게이트가 임의 실행 통로가 되지 않는다', () => {
    assert.deepEqual([...GATE_EXECUTABLES], ['npm', 'pnpm', 'yarn', 'npx', 'node'])
    for (const bad of ['curl http://x', 'wget http://x', 'sh tools/qa.sh', 'git push origin main', 'qa']) {
      assert.throws(() => integrationGateInvocation(bad, { platform: 'linux' }), (e) => e.code === 'UNSAFE_GATE', `거부하지 않았다: ${bad}`)
    }
  })
})
