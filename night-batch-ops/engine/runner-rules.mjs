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

/** 실작업 판정 — 라운드가 만든 새 커밋들의 변경 파일 목록(커밋당 배열)을 받아, 로그 폴더
 *  **밖** 파일이 하나라도 있으면 true. 새 커밋 0건이거나 전부 자기 로그면 false.
 *  (경계 상수 LOG_PREFIX 는 이 파일 아래쪽에서 선언한다 — 호출 시점엔 이미 초기화돼 있다.)
 *
 *  왜(실사고): 사람 게이트에 막혀 상태가 안 바뀌는 스토리를 연속 루프가 밤새 십수 회 재편성했다 —
 *  엔진은 전 단계를 state.json skip 으로 건너뛰고 **자기 로그 2파일만 커밋**한 뒤 exit 0 을 냈고,
 *  러너는 그걸 「완주」로 세어 다음 라운드를 열었다. 커밋 오염 + 알림 폭주가 반복된다.
 *  편성기의 비수렴 상한이 1차 방어선이고, 이건 러너 쪽 심층 방어다. */
export function roundDidRealWork(commitFileLists) {
  for (const files of commitFileLists ?? []) {
    for (const f of files ?? []) {
      const p = String(f).trim().replace(/\\/g, '/')
      if (!p) continue
      if (!p.startsWith(LOG_PREFIX)) return true
    }
  }
  return false
}

/** 연속 실행 루프 계속 판정 — 루프는 슬롯의 연장이지 새 스케줄러가 아니다.
 *  날짜가 바뀌면(자정) 루프를 끝내고 다음 슬롯의 새 프로세스에 넘긴다 — 자정 롤오버
 *  중복 실행 사고(2026-08-27 실사례)의 재발 방지 로직을 재사용하기 위해서다.
 *
 *  공회전 가드: `roundDidRealWork` 가 true 가 **아니면**(false·미전달 포함) 종료한다. 모르는 채로
 *  계속 도는 쪽이 손해가 크다 — 헛돌면 커밋 오염·알림 폭주가 밤새 쌓이지만, 잘못 멈춰도
 *  다음 정시 슬롯이 새 프로세스로 이어받는다. */
export function shouldContinueLoop({ autoPlan, dryRun, worstCode, ranCount, startDate, nowDate, roundDidRealWork: didRealWork }) {
  if (!autoPlan || dryRun) return false
  if (worstCode != null) return false // STOP 은 원인 확인이 먼저 — 헛도는 재시도 금지
  if (ranCount === 0) return false // 편성 0 = 오늘 몫 소진
  if (didRealWork !== true) return false // 공회전 = 종결
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

/** 엔진·러너가 자기 부기를 남기는 폴더 — 여기 안의 변경만으로는 「일했다」고 하지 않는다.
 *  (실작업 판정·진전 판정·landing 자동 해소가 모두 이 경계 하나를 공유한다.) */
export const LOG_PREFIX = '_bmad-output/implementation-artifacts/auto-pipeline-logs/'

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

/** 병렬 landing 충돌 자동 해소 판정 — 실사고: 병렬 첫 신규 짝의 landing 전건 실패 원인이 File List 코드가 아니라 **엔진이 스토리 커밋에 싣는 자기 로그**(run-summary.log append ·
 *  state.json)와 공유 장부 append 행(DECISIONS-INBOX)이었다. 그 클래스만 자동 해소를 허용한다 —
 *  로그·장부 = union(양쪽 순서대로 보존 · append 전용이라 안전) · 엔진 state.json = ours(런타임 부기 ·
 *  완료 스토리는 커밋으로 남아 유실 0). 목록에 그 외 파일이 하나라도 있으면 null(= 종전 보존 폴백 —
 *  코드 충돌을 자동으로 뭉개지 않는다). */
export function landingResolution(files) {
  const out = {}
  for (const f of files ?? []) {
    const p = String(f).trim().replace(/\\/g, '/')
    if (!p) continue
    if (p.startsWith(LOG_PREFIX)) {
      out[p] = p.endsWith('.json') ? 'ours' : 'union'
    } else if (SHARED_BOOKKEEPING.includes(p)) {
      out[p] = 'union'
    } else {
      return null
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 충돌 마커를 벗겨 양쪽을 순서대로 모두 보존(union). diff3 스타일의 base 구간(||||||| ~ =======)은
 *  버린다. 처리 후에도 마커가 남으면(중첩 등 비정형) null — 호출부는 보존 폴백으로 간다. */
export function stripConflictMarkers(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let inBase = false
  for (const line of lines) {
    const bare = line.replace(/\r$/, '')
    if (/^<{7}(\s|$)/.test(bare)) continue
    if (/^\|{7}(\s|$)/.test(bare)) { inBase = true; continue }
    if (/^={7}$/.test(bare)) { inBase = false; continue }
    if (/^>{7}(\s|$)/.test(bare)) continue
    if (inBase) continue
    out.push(line)
  }
  const s = out.join('\n')
  // 잔존 검사 — <·>·| 마커는 뒤에 라벨이 붙고, = 마커는 단독 줄만 마커다(스트리퍼와 같은 정의).
  return /^(?:<{7}(\s|$)|>{7}(\s|$)|\|{7}(\s|$)|={7}\r?$)/m.test(s) ? null : s
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

// ═══════════════════════════════════════════════════════════════════════════
// 무정지 밤(Non-Stop Night) 판정부 — 적대 리뷰 확정본의 판정 규칙.
// 목표: 「아침 브리핑 → 다음 아침까지 24h 무정지 · 완성도 무손실 · 정본 머지는 사람」.
// 구판은 밤을 멈추는 장치가 여럿이었다(미머지 브랜치면 휴면 · 창 통짜 차단 · lock 오판).
// 아래 함수들은 그 정지 조건을 **계속 도는 조건**으로 바꾸되, 자동으로 뭉개면 안 되는 것
// (코드 충돌 · 검토 없는 신규 축조)은 그대로 세운다. 각 함수 주석에 「왜」를 남긴다.
// ═══════════════════════════════════════════════════════════════════════════

/** lock 심박 보조 판정 기한(ms) — pid 판정 **불능**(EPERM·JSON 손상)일 때만 쓴다.
 *  6시간 = 최장 스토리 라운드(스테이지 타임아웃 × 단계 수 + qa)보다 길다 — 정상 라운드를
 *  절대 stale 로 오판하지 않는다(짧은 기한 + OR 탈취 초안은 리뷰에서 폐기됐다). */
export const LOCK_HB_STALE_MS = 6 * 60 * 60 * 1000

/** lock 처분 판정 — pid 재사용·권한 오류(EPERM)로 인한 양방향 오판 봉합(이중 기동 실사고 실측).
 *  입력: exists(파일 유무) · parseOk(JSON 읽힘) · pidAlive(true=생존 · false=ESRCH 사망 ·
 *  'unknown'=EPERM 등 판정 불능) · hbAgeMs(심박 경과 — 없으면 Infinity).
 *  반환: 'acquire'(빈 자리) · 'skip-alive'(정상 실행 중) · 'takeover'(죽은 lock 교체) ·
 *        'skip-unknown'(판정 불능 + 심박 신선 — 보수적으로 물러나되 **알림은 창당 1회 의무**). */
export function lockAction({ exists, parseOk, pidAlive, hbAgeMs }) {
  if (!exists) return 'acquire'
  if (!parseOk) return (hbAgeMs ?? Infinity) > LOCK_HB_STALE_MS ? 'takeover' : 'skip-unknown'
  if (pidAlive === true) return 'skip-alive'
  if (pidAlive === false) return 'takeover'
  return (hbAgeMs ?? Infinity) > LOCK_HB_STALE_MS ? 'takeover' : 'skip-unknown'
}

/** STOP 차단기 v2 — 구판은 창(12시간) 단위 통짜 차단이라 초저녁 실패 2회가 밤 전체(최장 11시간)를
 *  휴면시켰다. 차단 단위를 「원인 서명」(exit 코드 + 멈춘 배치 라벨)으로 좁힌다: 같은 서명 2회만
 *  차단하고 다른 원인은 계속 돈다. 창 누적 4회는 폭주 백스톱으로 남긴다.
 *  exit 5(한도)는 종전대로 세지 않는다(고장이 아니라 날씨).
 *  성공 라운드는 서명 스트릭을 지운다(총 누적은 유지 — 백스톱 보존). 원본 불변. */
export function stopRecord(win, worstCode, label) {
  const w = { sigs: { ...(win?.sigs ?? {}) }, total: win?.total ?? 0, stops: win?.stops ?? 0 }
  if (worstCode == null) return { ...w, sigs: {}, stops: 0 } // 성공 — 스트릭 소거
  if (worstCode === 5) return w // 한도는 날씨
  const sig = `${worstCode}|${label ?? ''}`
  w.sigs[sig] = (w.sigs[sig] ?? 0) + 1
  w.total += 1
  w.stops = Math.max(...Object.values(w.sigs), 0) // 원격 명령 폴러(/status·/resume) 호환(stops = 최대 스트릭)
  return w
}
export function stopBlocked(win) {
  if (!win) return false
  if ((win.total ?? 0) >= 4) return true // 창 백스톱
  return Object.values(win.sigs ?? {}).some((n) => n >= 2)
}

/** 하향 동기 충돌 처분 — 정본(main)→작업 브랜치 merge 의 충돌 파일 목록을 받아:
 *  'resolve' = 전부 로그·공유 장부 클래스 → landingResolution 계획으로 자동 해소(검증된 부품 재사용)
 *  'halt'    = 코드 파일 충돌 → merge 중단 + 이 라운드 휴면(자동으로 뭉개지 않는다).
 *
 *  2026-09-02 개정: **문서 전용 충돌도 'resolve' 로 푼다**(종전 'defer'). 스토리 md 는 'ours'
 *  (러너 산출 유지 — 그 스토리만 낡은 채 가고 사람의 정식 3-way 머지가 아침에 합친다), 공유
 *  장부는 'union'. 종전 'defer' 는 아래 반복 백스톱과 결합해 **19시간 38분 미동기 실사고**를
 *  만들었다: 문서 2파일 충돌이 2회 나자 d2halt 가 섰고, 새 날 브랜치가 정본이 아니라 전날
 *  작업 tip 을 승계해 정본의 확정·코드가 밤새 러너에 닿지 않았다(편성기가 낡은 원장으로 오보). */
export function downSyncDecision(files) {
  const list = (files ?? []).map((f) => String(f).trim().replace(/\\/g, '/')).filter(Boolean)
  if (list.length === 0) return { mode: 'resolve', plan: {} }
  const plan = landingResolution(list)
  if (plan) return { mode: 'resolve', plan }
  const docOnly = list.every((p) => p.startsWith('_bmad-output/') && p.endsWith('.md'))
  if (docOnly) {
    const docPlan = {}
    for (const p of list) docPlan[p] = SHARED_BOOKKEEPING.includes(p) ? 'union' : 'ours'
    return { mode: 'resolve', plan: docPlan }
  }
  return { mode: 'halt' }
}

/** 충돌 지문 — 같은 충돌을 라운드마다 재생산하는 것을 막는 반복 백스톱의 재료(순서 무관 동일). */
export function conflictFingerprint(files) {
  return (files ?? []).map((f) => String(f).trim().replace(/\\/g, '/')).filter(Boolean).sort().join('|')
}

/** 선형 승계 — 미머지 `auto/<날짜>` 목록에서 승계 기준을 고른다. 구판은 미머지 브랜치가 남아 있으면
 *  슬롯을 통째로 휴면시켰다(사람이 머지할 때까지 밤이 죽는다). 대신 최신 날짜 브랜치를 베이스로
 *  이어받아 한 줄로 쌓는다 — 같은 날짜면 원격(origin/) 이름 우선(push 된 것이 공유 사실이다).
 *  체인 나이 = 가장 오래된 미머지 날짜 → 오늘. 반환 { ref, chainAgeDays, branches } · 목록 비면 null. */
export function inheritPlan(unmergedNames, todayYmd) {
  const uniq = [...new Set((unmergedNames ?? []).map((n) => String(n).trim()).filter(Boolean))]
  const dated = uniq
    .map((n) => ({ n, m: /auto\/(\d{4}-\d{2}-\d{2})/.exec(n) }))
    .filter((x) => x.m).map((x) => ({ name: x.n, date: x.m[1] }))
  if (dated.length === 0) return null
  const newest = dated.reduce((a, b) => (b.date > a.date ? b : a))
  const oldest = dated.reduce((a, b) => (b.date < a.date ? b : a))
  // 같은 날짜면 원격(origin/) 이름 우선 — 로컬 미푸시보다 공유 사실이 안전 기준이다
  const sameDay = dated.filter((d) => d.date === newest.date)
  const pick = sameDay.find((d) => d.name.startsWith('origin/')) ?? sameDay[0]
  const days = (ymd) => Math.floor(Date.parse(ymd + 'T00:00:00') / 86400000)
  return {
    ref: pick.name,
    chainAgeDays: Math.max(0, days(todayYmd) - days(oldest.date)),
    branches: dated.map((d) => d.name),
  }
}

/** 체인 게이트 — 사람 검토 없는 축조의 총량 상한. 미머지 체인이 이 나이(일) 이상이면
 *  **신규(kind=new) 착수만** 중단한다(회수·마감 재검수는 계속 — 시작된 일의 마무리는 검토를
 *  더 쌓는 게 아니라 검토를 준비하는 일이다). 판정 자체는 plan-queue 가 chain-info 파일로 읽는다. */
export const CHAIN_MAX_AGE_DAYS = 2
export function allowNewUnderChain(chainAgeDays) {
  return (chainAgeDays ?? 0) < CHAIN_MAX_AGE_DAYS
}

/** exit 5 환불 판정 — 한도(exit 5)가 하루 상한 원장과 비수렴 상한을 공짜로 소모하는 것을 막는다.
 *  멈춘 배치의 스토리 중 **라운드 커밋이 그 스토리 md 를 한 번도 만지지 않은 키**를 돌려준다
 *  (= 실작업 0 · 환불 대상). 한 줄이라도 만졌으면 그 스토리는 실제로 진행됐으므로 환불하지 않는다. */
export function limitRefundKeys(batchStories, commitFileLists) {
  const touched = new Set()
  for (const files of commitFileLists ?? []) for (const f of files ?? []) {
    const p = String(f).trim().replace(/\\/g, '/')
    const m = /implementation-artifacts\/(\d+-\d+[^/]*)\.md$/.exec(p)
    if (m) touched.add(m[1])
  }
  return (batchStories ?? []).filter((k) => !touched.has(k))
}

/** 라운드 진전 스토리 추출 — 비수렴 상한(규칙 9)을 「편성 횟수」가 아니라 「무진전 편성의 연속
 *  횟수」로 재정의하기 위한 재료. 라운드 커밋들이 만진 스토리 md 의 키 목록을 돌려준다.
 *  로그 폴더 안 경로는 명시적으로 제외한다 — 엔진이 자기 로그만 커밋하고 exit 0 을 내는
 *  공회전을 「진전」으로 세면, 사람 게이트에 막힌 스토리가 밤새 재편성된다(실사고 실측). */
export function progressedStoryKeys(commitFileLists) {
  const keys = new Set()
  for (const files of commitFileLists ?? []) for (const f of files ?? []) {
    const p = String(f).trim().replace(/\\/g, '/')
    if (p.startsWith(LOG_PREFIX)) continue
    const m = /implementation-artifacts\/(\d+-\d+[^/]*)\.md$/.exec(p)
    if (m) keys.add(m[1])
  }
  return [...keys]
}

/** 무인 실행이 **계정 지출 한도**로 막혔을 때의 알림 판정 (2026-08-30 실사고 회수).
 *
 *  왜 필요한가: 러너는 exit 5(한도)를 「날씨」로 보고 차단기에서 제외한 뒤 원장을 환불하고
 *  다음 슬롯에 재시도한다 — 짧은 한도에는 맞는 설계다. 그런데 **오래 막히면 아무도 깨우지
 *  않았다**: 9시간 동안 30분마다 같은 알림이 20회 나갔고, 그 본문은 원인을 「결정 대기가
 *  스토리 N개를 막는 중」이라고 **엉뚱하게** 말했다. 사람은 그 문장에서 지출 한도를 떠올릴
 *  수 없다. 알림 피로로 실제로 무시됐다.
 *
 *  세 가지를 고친다:
 *   ① 원인을 이름으로 말한다 — 「계정 지출 한도」 + 확인처 + **사람만 풀 수 있다**는 사실
 *   ② 매 라운드 같은 말을 하지 않는다 — 첫 회 + 이후 4라운드마다(30분 슬롯이면 2시간)
 *   ③ 경과를 말한다 — 「N시간째 0건」이 있어야 사람이 심각도를 안다
 *
 *  `streak` = 지출 한도로 **한 건도 못 한** 연속 라운드 수(성공 라운드가 나오면 0으로 리셋).
 *  반환 `speak=false` 면 조용히 넘어간다(러너는 요약 로그만 남긴다). */
export function spendBlockNotice({ streak, firstIso, nowIso }) {
  if (!Number.isInteger(streak) || streak < 1) return { speak: false }
  const speak = streak === 1 || streak % 4 === 0
  if (!speak) return { speak: false }
  const first = Date.parse(firstIso ?? '')
  const now = Date.parse(nowIso ?? '')
  const mins = Number.isFinite(first) && Number.isFinite(now) && now > first ? Math.round((now - first) / 60000) : 0
  const elapsed = mins >= 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60}분째` : `${mins}분째`
  return {
    speak: true,
    title: streak === 1 ? '무인 실행 차단 — 계정 지출 한도' : `무인 실행 ${elapsed} 차단 (연속 ${streak}회)`,
    body:
      '헤드리스(무인) 실행이 계정 **지출 한도**로 거부되고 있다. 모델·인증·환경 문제가 아니다 — ' +
      '전 모델이 같은 메시지로 거부되고 `claude auth status` 는 정상이다.\n' +
      '요금제 사용량 설정에서 한도를 확인해야 풀린다 — **사람만 할 수 있다**.\n' +
      `슬롯은 계속 재시도하고 있고(${elapsed} · 연속 ${streak}회 무작업), 풀리는 즉시 자동으로 이어받는다. ` +
      '하루 상한 원장은 환불되므로 손해는 없다.',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 다중 프로바이더 워커 풀 (2026-09-02 · 설계 references/multi-provider-design.md · 적대 검토 40건 반영)
// 원칙: 설정이 없으면 종전 동작(Claude 전용 · 2폭 · 하드캡 3). 새 판정은 전부 순수 함수 — 테스트가 문다.
// ═══════════════════════════════════════════════════════════════════════════

/** 총 워커 절대 상한 — `workers.max` 를 설정으로 올려도 이 위로는 못 간다(같은 머신 qa 자원 경합 · 한도 배수 소모). */
export const WORKERS_ABS_MAX = 6
/** 프로바이더 기본값 — codex 는 **꺼짐**이 기본이고, 켜도 동시 1(같은 auth.json 동시 사용 금지 · OpenAI 문서) */
export const PROVIDER_DEFAULTS = Object.freeze({
  claude: Object.freeze({ enabled: true, max: PARALLEL_MAX }),
  codex: Object.freeze({ enabled: false, max: 1, roles: Object.freeze(['review']), reviewKinds: Object.freeze(['new', 'closeout']), split: false, network: false, fallback: true }),
})
export const QUALITY_DEFAULTS = Object.freeze({ autoRepair: 0, sameRootCauseMaxRetries: 3, totalRepairAttempts: 5, integrity: 'auto' })

/** auto.config.json → 정규화된 프로바이더·워커·품질·통합 게이트 설정(전부 선택 · 없으면 종전 동작 = configured:false). */
export function providerConfig(cfg = {}) {
  const c = cfg ?? {}
  const p = c.providers ?? {}
  const codex = { ...PROVIDER_DEFAULTS.codex, ...(p.codex ?? {}) }
  const claude = { ...PROVIDER_DEFAULTS.claude, ...(p.claude ?? {}) }
  const warnings = []
  codex.max = Math.max(1, Number(codex.max) || 1)
  if (codex.max > 1) warnings.push(`providers.codex.max=${codex.max} — 같은 auth.json 동시 사용은 OpenAI 가 지원하지 않는다(갱신 경합). 실측 없이 올리지 말 것`)
  codex.roles = Array.isArray(codex.roles) ? codex.roles.filter((r) => ['review', 'dev'].includes(r)) : ['review']
  codex.reviewKinds = Array.isArray(codex.reviewKinds) ? codex.reviewKinds : ['new', 'closeout']
  claude.max = Math.max(1, Math.min(WORKERS_ABS_MAX, Number(claude.max) || PARALLEL_MAX))
  const w = c.workers ?? {}
  const workers = {
    max: Math.max(1, Math.min(WORKERS_ABS_MAX, Number(w.max) || PARALLEL_MAX)),
    batchSize: Math.max(1, Math.min(WORKERS_ABS_MAX, Number(w.batchSize) || 2)),
  }
  const q = c.quality ?? {}
  // autoRepair: true → 기본 총 5회 · 숫자 → 그 횟수 · false/미지정 → 0(종전: qa RED 즉시 STOP)
  const autoRepair = q.autoRepair === true ? QUALITY_DEFAULTS.totalRepairAttempts
    : q.autoRepair === false || q.autoRepair === undefined ? Math.max(0, Number(q.totalRepairAttempts) || 0)
      : Math.max(0, Number(q.autoRepair) || 0)
  const quality = {
    autoRepair: q.totalRepairAttempts !== undefined && q.autoRepair === true ? Math.max(0, Number(q.totalRepairAttempts) || 0) : autoRepair,
    sameRootCauseMaxRetries: Math.max(1, Number(q.sameRootCauseMaxRetries) || QUALITY_DEFAULTS.sameRootCauseMaxRetries),
    integrity: ['auto', 'on', 'off'].includes(q.integrity) ? q.integrity : 'auto',
  }
  const g = c.integrationGate ?? {}
  // pushOnFail 은 폐지(2026-09-02 hardening #5) — 「RED 인데 push」 를 설정 한 줄로 되살릴 수 있으면
  // 통합 게이트는 안전장치가 아니라 권고가 된다. 남아 있는 키는 **무시하고 경고**한다(조용히 먹지 않는다).
  const integrationGate = { enabled: c.integrationGate !== undefined && g.enabled !== false }
  if (g.pushOnFail !== undefined) warnings.push('[INTEGRATION] pushOnFail 은 폐지됨 — RED 는 항상 rollback')
  const configured = c.providers !== undefined || c.workers !== undefined || c.quality !== undefined || c.integrationGate !== undefined
  return { configured, workers, providers: { claude, codex }, quality, integrationGate, warnings }
}

/** 병렬 폭 — `maxWorkers` 는 설정이 준 총 상한(기본 = 종전 하드캡 3 → parallelPlan 과 바이트 단위로 같은 결과). 절대 상한 6. */
export function parallelPlanWithWorkers({ storyCount, stages, parallel, maxWorkers = PARALLEL_MAX }) {
  const base = parallelPlan({ storyCount, stages, parallel })
  if (base <= 1) return base
  const cap = Math.max(1, Math.min(WORKERS_ABS_MAX, Number(maxWorkers) || PARALLEL_MAX))
  return Math.min(parallel, cap, storyCount)
}

/** 병렬 위험 — File List 겹침(fileListConflicts)에 더해, **어느 한쪽이라도** package.json/lock 을 만지면 병렬 금지:
 *  워크트리들이 node_modules 를 junction 으로 **공유**하므로 한쪽의 의존성 변경이 다른 쪽의 qa 를 흔든다(F35). */
export const SHARED_TOOLCHAIN_FILES = Object.freeze(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
/** @param {string[][]} lists 스토리별 File List
 *  @param {{judges?: Array<(lists: string[][]) => ({ok: boolean, why?: string}|null|undefined)>}} [options]
 *    judges = **외부 판정기 주입점**(migration/schema/API contract 충돌 등). 각 판정기는 `{ok:false, why}` 를
 *    돌려주면 그 자리에서 병렬을 막고, `null`·`{ok:true}` 면 다음 판정기로 넘어간다. 던지는 판정기는
 *    「모르는 것」으로 보고 병렬을 막는다(조용한 통과 금지). 내장 toolchain 검사가 항상 먼저 돈다. */
export function parallelHazards(lists, { judges = [] } = {}) {
  for (let i = 0; i < (lists ?? []).length; i++) {
    for (const f of lists[i] ?? []) {
      const p = String(f).trim().replace(/\\/g, '/')
      if (SHARED_TOOLCHAIN_FILES.includes(p)) return { ok: false, why: `스토리 ${i + 1} 이 ${p} 를 만진다 — node_modules 공유(junction)라 병렬 불가` }
    }
  }
  for (const judge of judges ?? []) {
    if (typeof judge !== 'function') continue
    let v
    try { v = judge(lists ?? []) } catch (e) { return { ok: false, why: `외부 병렬 판정기 오류 — ${e?.message ?? e}` } }
    if (v && v.ok === false) return { ok: false, why: String(v.why ?? '외부 병렬 판정기가 막음') }
  }
  return { ok: true, why: '' }
}

/** 모델 스펙의 프로바이더 — "codex" · "codex:<model>" 만 codex, 나머지(빈 값 포함)는 claude(엔진 parseModelSpec 과 같은 규칙) */
export const specProvider = (s) => (/^codex(:|$)/i.test(String(s ?? '').trim()) ? 'codex' : 'claude')

/** 스토리별 프로바이더 배정(순수) — 배치 models 를 기본으로 한다. codex 가 켜져 있고 가용하며 roles 에 dev 가 있고 split 이면
 *  홀수 번째 스토리를 codex dev(리뷰는 claude 로 교차)로 나눈다. blocked 에 든 프로바이더는 피한다(한도·인증 레인 전환).
 *  반환 [{ story, dev, review, devProvider }]. 설정이 없으면 입력 models 그대로 — 종전과 같은 플래그. */
export function assignProviders({ stories = [], batchModels = {}, codex = PROVIDER_DEFAULTS.codex, codexAvailable = false, blocked = [] } = {}) {
  const base = { dev: batchModels.dev ?? '', review: batchModels.review ?? '' }
  const codexDevOk = Boolean(codex?.enabled) && codexAvailable && (codex.roles ?? []).includes('dev') && !blocked.includes('codex')
  const claudeAlt = specProvider(base.dev) === 'claude' && base.dev ? base.dev : (specProvider(base.review) === 'claude' ? base.review : '')
  return stories.map((story, i) => {
    let dev = base.dev, review = base.review
    if (codexDevOk && Boolean(codex.split) && i % 2 === 1) { dev = 'codex'; review = claudeAlt } // 교차: codex 가 만들면 claude 가 본다
    if (blocked.includes('codex')) { if (specProvider(dev) === 'codex') dev = claudeAlt; if (specProvider(review) === 'codex') review = '' }
    if (blocked.includes('claude') && codexDevOk && specProvider(dev) === 'claude') { dev = 'codex'; review = claudeAlt }
    return { story, dev, review, devProvider: specProvider(dev) }
  })
}

/** 워커 풀 스케줄(순수) — running 의 프로바이더별 수와 총 수를 세어 지금 시작할 수 있는 pending 을 **순서대로** 고른다.
 *  caps = { total, claude, codex }. 같은 프로바이더 상한이 차면 그 항목은 건너뛰고 다음 후보를 본다. */
export function pickRunnable(pending = [], running = [], caps = {}) {
  const total = Math.max(1, Number(caps.total) || 1)
  const per = { claude: Math.max(1, Number(caps.claude) || PARALLEL_MAX), codex: Math.max(1, Number(caps.codex) || 1) }
  const count = { claude: 0, codex: 0 }
  for (const r of running) count[r.devProvider === 'codex' ? 'codex' : 'claude']++
  let slots = total - running.length
  const out = []
  for (const p of pending) {
    if (slots <= 0) break
    const k = p.devProvider === 'codex' ? 'codex' : 'claude'
    if (count[k] >= per[k]) continue
    count[k]++
    slots--
    out.push(p)
  }
  return out
}

/** landing 뒤 통합 게이트 판정(순수) — 병렬 landing 이 1건 이상일 때만 돈다.
 *  **RED 는 설정으로 우회되지 않는다**(2026-09-02 hardening #5): 어떤 인자를 더 주어도 `rollback` 하나다.
 *  옛 `pushOnFail`/`push-anyway` 는 제거됐다 — 되살리려면 사람이 별도 승인 명령으로 하는 것이지 무인 설정이 아니다. */
export function integrationGateDecision({ enabled = false, landedCount = 0, qaExit = null } = {}) {
  if (!enabled || landedCount <= 0) return { run: false, action: 'push', why: enabled ? '통합 게이트 대상 없음(landing 0)' : '통합 게이트 꺼짐' }
  if (qaExit === null) return { run: true, action: 'pending', why: '통합 게이트 실행 필요' }
  if (qaExit === 0) return { run: true, action: 'push', why: '통합 게이트 GREEN' }
  return { run: true, action: 'rollback', why: `통합 게이트 RED(exit ${qaExit}) — landing 되돌림 · push 금지 · 산출물은 archive 태그 보존` }
}

// ── 통합 게이트 실행 계획 (BRIEF 정책 8 · codex-review-r3 M5) ────────────────
// 종전에는 `spawnSync(QA_CMD, { shell: true })` 였다. `QA_CMD` 는 **저장소 안** `auto.config.json` 의
// `qa` 값이라, `npm run qa && git push …` 같은 문자열이 그대로 cmd.exe 에 넘어갔다.
// 이제 자유 형식 명령을 **허용 실행파일 + argv** 로 정규화하고, 그 틀을 벗어나면 실행 전에 거부한다.
//
// 왜 `providers/spawn-safe.mjs` 를 import 하지 않나: 러너는 대상 저장소의 `tools/auto/` 로 **복사돼**
// 돌기 때문에 `../../auto-story-finish/…` 가 그 자리에 없다(e2e 픽스처도 같은 배치다). 규칙은 같게 둔다.

/** 게이트로 부를 수 있는 실행파일 — 이 목록 밖은 거부한다(임의 실행 방지). */
export const GATE_EXECUTABLES = Object.freeze(['npm', 'pnpm', 'yarn', 'npx', 'node'])
/** 토큰 하나의 안전 문자집합 — `spawn-safe.mjs:SAFE_ARG_RE` 와 같은 규칙(공백은 토큰 분리에 쓰므로 뺐다).
 *  `& | ; < > ^ % $ \` " ' * ? [ ] { } #` 과 줄바꿈은 전부 여기서 걸린다. */
export const GATE_TOKEN_RE = /^[A-Za-z0-9._:/\\()~@+=,-]+$/
const GATE_CMD_SHIM = new Set(['npm', 'pnpm', 'yarn', 'npx'])

/** cmd.exe `/s /c` 용 인용 — MS C 런타임 규칙(`spawn-safe.mjs:quoteWindowsArg` 와 동일). */
function quoteWindowsArg(arg) {
  const s = String(arg)
  let out = '"'
  let slashes = 0
  for (const ch of s) {
    if (ch === '\\') { slashes++; out += ch; continue }
    if (ch === '"') { out += '\\'.repeat(slashes + 1) + '"'; slashes = 0; continue }
    slashes = 0
    out += ch
  }
  return out + '\\'.repeat(slashes) + '"'
}

/**
 * 통합 게이트 명령 → 실행 계획. **셸 문자열 결합 없음**(`shell:false` 로만 돈다).
 * 받는 형태: `npm run qa` · `pnpm run qa` · `node tools/qa.mjs` 처럼 「허용 실행파일 + 안전 토큰」.
 * Windows 의 `npm` 은 `.cmd` 심이라 CreateProcess 가 직접 못 돈다 → `cmd.exe /d /s /c "…"` 전용 경로.
 * @returns {{file:string, argv:string[], verbatim:boolean, display:string}}
 * @throws {Error} code='UNSAFE_GATE' — 빈 값 · 셸 메타문자 · 허용 밖 실행파일
 */
export function integrationGateInvocation(cmd, { platform = process.platform, comspec = process.env.ComSpec || 'cmd.exe' } = {}) {
  const raw = String(cmd ?? '').trim()
  const bad = (why) => { throw Object.assign(new Error(`[INTEGRATION] 게이트 명령을 거부한다 — ${why}: ${JSON.stringify(raw.slice(0, 80))}`), { code: 'UNSAFE_GATE' }) }
  if (!raw) bad('비어 있다')
  const toks = raw.split(/ +/)
  for (const t of toks) if (!GATE_TOKEN_RE.test(t)) bad(`셸 메타문자 또는 허용되지 않은 문자가 있다(${t})`)
  const exe = toks[0].replace(/\.(cmd|bat|exe)$/i, '').toLowerCase()
  if (!GATE_EXECUTABLES.includes(exe)) bad(`허용 실행파일(${GATE_EXECUTABLES.join(', ')}) 밖이다`)
  const args = toks.slice(1)
  const display = [exe, ...args].join(' ')
  if (platform === 'win32' && GATE_CMD_SHIM.has(exe)) {
    // 실행파일 토큰은 **인용하지 않는다**. `cmd /s /c ""npm.cmd" …"` 처럼 따옴표를 씌우면 npm.cmd 안의
    // `%~dp0` 가 PATH 로 찾은 폴더가 아니라 **현재 폴더**로 잡혀 `node_modules/npm/bin/npm-prefix.js` 를
    // 찾다 죽는다(2026-09-02 실측: 통합 게이트가 MODULE_NOT_FOUND 로 RED). 인용을 빼도 안전한 이유는
    // 이 자리에 올 수 있는 값이 화이트리스트(`npm|pnpm|yarn|npx`)+`.cmd` 뿐이라 셸 메타문자가 없기 때문이다.
    // 인자는 경로·괄호가 들어올 수 있으므로 종전대로 인용한다.
    const line = `"${[`${exe}.cmd`, ...args.map(quoteWindowsArg)].join(' ')}"`
    return { file: comspec, argv: ['/d', '/s', '/c', line], verbatim: true, display }
  }
  return { file: exe, argv: args, verbatim: false, display }
}

/** 통합 게이트 결과를 검증 매니페스트에 병합(순수) — 원본은 건드리지 않고 새 객체를 돌려준다.
 *  result = { result: 'pass'|'fail'|'rollback', qaExit, landingBase, at, batchId? }
 *    pass     = 통합 qa GREEN(그대로 push 대상)
 *    rollback = 통합 qa RED · landing 되돌림 **확인됨**(HEAD == landingBase)
 *    fail     = 통합 qa RED 인데 되돌림을 확인하지 못함(사람이 봐야 하는 상태)
 *  `batchId` 는 **준 경우에만** 실린다(N6/정책 16): rollback 증거·sidecar 가 「어느 라운드의 판정인가」를
 *  말해야 이전 라운드 기록을 덮어쓰지 않는다. 안 주면 종전 4필드 그대로다(하위 호환). */
export const INTEGRATION_RESULTS = Object.freeze(['pass', 'fail', 'rollback'])
export function applyIntegrationToManifest(manifestJson, result) {
  const base = manifestJson && typeof manifestJson === 'object' && !Array.isArray(manifestJson) ? manifestJson : {}
  const r = result && typeof result === 'object' ? result : {}
  const qa = Number(r.qaExit)
  const batchId = r.batchId == null || r.batchId === '' ? null : String(r.batchId)
  return {
    ...base,
    integration: {
      result: INTEGRATION_RESULTS.includes(r.result) ? r.result : 'fail',
      qaExit: Number.isFinite(qa) ? qa : null,
      landingBase: String(r.landingBase ?? ''),
      at: String(r.at ?? new Date().toISOString()),
      ...(batchId ? { batchId } : {}),
    },
  }
}

/** 정규화 설정 → 엔진 추가 플래그(순수). 설정이 하나도 없으면 [] — 종전 명령줄과 바이트 단위로 같다(하위 호환). */
export function engineFlagsFromConfig(pc) {
  if (!pc?.configured) return []
  const a = []
  if (pc.quality.autoRepair > 0) a.push('--auto-repair', String(pc.quality.autoRepair), '--repair-same-cause', String(pc.quality.sameRootCauseMaxRetries))
  // (2026-09-02) `--integrity` 는 **항상 명시**한다 — 엔진 기본값이 `on` 으로 바뀌어, 생략하면 설정의
  // `auto`(= autoRepair>0 일 때만)가 조용히 `on` 으로 승격된다. 설정이 곧 실행이어야 한다.
  a.push('--integrity', pc.quality.integrity)
  if (pc.providers.codex.enabled) {
    a.push('--providers', 'claude,codex', '--codex-roles', pc.providers.codex.roles.join(',') || 'review', '--codex-max', String(pc.providers.codex.max))
    if (pc.providers.codex.network) a.push('--codex-network', 'on')
  } else {
    a.push('--no-codex')
  }
  return a
}

/** 엔진의 exit-info.json 해석(순수) — 한도·인증·지출로 멈춘 프로바이더(F36: exit 5 만으로는 레인을 모른다). 그 외 null. */
export function blockedProviderFromExit(info) {
  if (!info || typeof info !== 'object') return null
  if (!['limit', 'auth', 'spend'].includes(info.kind)) return null
  return info.provider === 'codex' ? 'codex' : info.provider === 'claude' ? 'claude' : null
}
