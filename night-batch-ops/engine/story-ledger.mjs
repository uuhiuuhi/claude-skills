// 스토리 원장 해석기 — **단일 소스** (2026-09-01 👤 승인 · 운영 체계 정비 P0-a)
//
// 왜 하나로 모으는가: 편성기·현황판·가드·아침 브리핑이 각자 Markdown 문장을 해석하다
// 표기 차이(👤 인용 · 「새 화면 0」 부정문 · 굵은 표기)로 오판이 반복됐다 — 2026-08-30
// 굵게 16건이 0으로 읽혀 11.2 가 열린 결함 8건인 채 closeout 편성 · 2026-08-31 하루에
// 미완 Task 줄의 👤 인용이 사람 게이트로 오판돼 3회(4-3·4-6·2-10) 편성 제외.
// 한쪽을 고치면 다른 쪽에서 다시 사고가 났으므로, 해석 규칙은 이 파일 하나만 고친다.
//
// ⚠️ 이 파일은 **프로젝트 중립**이다 — 목업 게이트의 표기·경로는 auto.config.json 의
// mockupGate 가 소유한다(MOCKUP_GATE_DEFAULT 는 기본값일 뿐 하드코딩이 아니다).
//
// 소비자 배선(단계적): ① plan-queue(2026-09-01 완료) ② story-ledger-guard ③ dev-status
// ④ morning-brief — ②~④ 는 P1 에서 이 모듈로 갈아탄다.
//
// P1 예고(구조화 필드): 신규 기록은 자유문장 해석 대신 `status/type/severity/human_gate/
// defer_allowed` 필드를 함께 적고, 이 파서가 「필드가 있으면 필드 우선 · 없으면 종전
// 문장 해석 폴백」으로 읽는다 — 기존 963건 일괄 변환은 하지 않는다(래칫).

/**
 * 열린 findings 를 센다 — ⚠️ **표기 흔들림을 흡수해야 한다**.
 *
 * 2026-08-30 실사고: 판정 정규식이 `- [ ] [Review][Patch]` 만 셌는데 원장 2건이
 * `- [ ] **[Review][Patch][high] …` (굵게)로 적혀 있어 **16건이 0건으로 읽혔다**.
 * 그래서 굵게/기울임 표시와 들여쓰기를 허용한다. `- [x]`(해소분)는 그대로 제외된다.
 */
export const openFindings = (text, tag) =>
  (text.match(new RegExp('^[ \\t]*- \\[ \\] [*_]{0,2}\\[Review\\]\\[' + tag + '\\]', 'gm')) ?? []).length

/**
 * 사람 게이트 줄 판정 — 미완 Task 가 「사람만 풀 수 있는 항목」인가.
 *
 * ⚠️ 휴리스틱의 알려진 함정(2026-08-31 3회 실사고): 확정 **근거 인용**(「👤 08-31 「…」 확정」)까지
 * 사람 대기로 읽는다. 새로 적을 때는 「2026-08-31 확정 「…」」 형태로 이모지·호칭을 빼고,
 * 심은 뒤 `plan-queue --dry` 로 실측한다. 근본 해결은 P1 구조화 필드(human_gate).
 */
export const isHumanGateLine = (line) => /사람 게이트|박사장|👤/.test(line)

/** 스토리 파일 판정 재료 */
export function readStorySignals(text) {
  const openDecisions = openFindings(text, 'Decision')
  const openDecision = openDecisions > 0
  const openPatches = openFindings(text, 'Patch')
  const banPresent = /재투입 금지|마지막 구현 라운드/.test(text)
  // Tasks/Subtasks 절 안의 미완 체크박스만 센다 — Review Findings 의 [ ] 는 dev 엔진 Step 1 이
  // 세지 않는다(feedback_dev_reentry_preconditions). 절 경계 = '## Tasks' ~ 다음 '^## '.
  // 엔진(Step 1)은 h2 Tasks 영역 안의 [ ] 를 전부 센다 — h3 Review Findings 가 그 안에 있으면
  // 그것도 일감이다(2-9·2-24 실측). 밖(h2 형제 절)에 있으면 안 센다(3-1 no-op 실사례).
  // 다만 사람 게이트 항목은 dev 가 코드로 못 푸므로 기계 일감에서 뺀다 — 그것만 남은 스토리를
  // 편성하면 no-op STOP 이 예약된다.
  const tasksSection = /## Tasks[^\n]*\n([\s\S]*?)(?=\n## )/.exec(text)?.[1] ?? ''
  const openTaskLines = tasksSection.match(/^\s*- \[ \] [^\n]*/gm) ?? []
  const unfinishedTasks = openTaskLines.filter((l) => !isHumanGateLine(l)).length
  // 자율운전(full · 2026-09-03) 재료 — 사람 게이트 줄 수/원문과, replan 이 남기는 「사람 질문 대기」 표식.
  // 표식은 'BLOCKED-ON-HUMAN: <질문>' 한 줄이고, 취소선(~~)으로 감싸면 해소된 것으로 본다.
  const humanGateTasks = openTaskLines.length - unfinishedTasks
  const humanGateLines = openTaskLines.filter((l) => isHumanGateLine(l)).map((l) => l.trim())
  const blockedLine = /^[ \t>*_-]*BLOCKED-ON-HUMAN:[^\n]*/m.exec(text)?.[0] ?? null
  const blockedOnHuman = blockedLine ? blockedLine.replace(/^[ \t>*_-]*/, '').trim() : null
  // File List 절의 백틱 경로(규칙 5 재료) — 경로형(슬래시 포함)만
  const fileSection = /### File List\n([\s\S]*?)(?=\n#{2,3} )/.exec(text)?.[1] ?? ''
  const files = [...fileSection.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((p) => p.includes('/'))
  return { openDecision, openDecisions, openPatches, banPresent, unfinishedTasks, files, humanGateTasks, humanGateLines, blockedOnHuman }
}

/** sprint-status.yaml → [{key, status, epic}] (스토리 키 행만 — 주석·벌크 무시) */
export function parseSprint(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const m = /^ {2}(\d+-\d+[^:]*): *(backlog|ready-for-dev|in-progress|review|done)\b/.exec(line)
    if (m) rows.push({ key: m[1], status: m[2], epic: Number(m[1].split('-')[0]) })
  }
  return rows
}

/** epics.md 에서 해당 스토리 절 추출 — 키 4-1-... → 헤더 '### Story 4.1:' */
export function epicSection(epicsText, key) {
  const [a, b] = key.split('-')
  const re = new RegExp('^### Story ' + a + '\\.' + b + ':[^\\n]*\\n([\\s\\S]*?)(?=\\n### Story |\\n## )', 'm')
  return re.exec(epicsText)?.[1] ?? ''
}

/** 목업 게이트(규칙 6) 기본값 — 프로젝트가  의  로 덮어쓴다.
 *  marker 가 비면 게이트를 적용하지 않는다(미구성 프로젝트에서 규칙 6 이 전건을 막지 않도록). */
export const MOCKUP_GATE_DEFAULT = Object.freeze({
  marker: '새 화면',
  ruleId: null,
  mockupsDir: 'mockups',
  verdictsPath: 'tools/dev-status/mockup-verdicts.json',
})

/**
 * 목업 게이트(규칙 6): 새 화면 스토리는 approved 목업이 실재해야 후보.
 * ⚠️ 부분 문자열 함정(2026-08-31 실사고): 「새 화면 0」 같은 **부정문**도 트리거를 밟는다 —
 * epics 절에는 「신설 화면 0」으로 표기한다. 근본 해결은 P1 구조화 필드.
 */
export function mockupGateOk(section, key, verdicts, gate = MOCKUP_GATE_DEFAULT) {
  const marker = gate?.marker
  if (!marker) return { ok: true, unconfigured: true }
  if (!section.includes(marker)) return { ok: true }
  // ruleId 는 선택 — 지정하면 marker 와 **함께** 있을 때만 게이트가 걸린다(오탐 축소용).
  if (gate.ruleId && !section.includes(gate.ruleId)) return { ok: true }
  const dir = String(gate.mockupsDir ?? MOCKUP_GATE_DEFAULT.mockupsDir).replace(/[/\\]+$/, '')
  const prefix = dir + '/story-' + key.split('-').slice(0, 2).join('-') + '-'
  const mine = Object.entries(verdicts?.items ?? {}).filter(([k]) => k.startsWith(prefix))
  const tag = gate.ruleId ? ' — ' + gate.ruleId : ''
  if (mine.length === 0) return { ok: false, why: marker + ' 인데 목업 부재(pending 취급' + tag + ')' }
  const bad = mine.filter(([, v]) => v.verdict !== 'approved')
  if (bad.length > 0) return { ok: false, why: '목업 미승인: ' + bad.map(([k]) => k.split('/').pop()).join(', ') }
  return { ok: true }
}

/** 목업 항목 실측(자율운전 재료) — 이 스토리 접두('<dir>/story-<에픽>-<번호>-')의 verdict 목록.
 *  applies=false 면 게이트 대상 스토리가 아니다(marker/ruleId 판정은 mockupGateOk 와 같다). */
export function mockupEntries(section, key, verdicts, gate = MOCKUP_GATE_DEFAULT) {
  const marker = gate?.marker
  if (!marker || !section.includes(marker) || (gate.ruleId && !section.includes(gate.ruleId))) return { applies: false, entries: [] }
  const dir = String(gate.mockupsDir ?? MOCKUP_GATE_DEFAULT.mockupsDir).replace(/[/\\]+$/, '')
  const prefix = dir + '/story-' + key.split('-').slice(0, 2).join('-') + '-'
  const entries = Object.entries(verdicts?.items ?? {}).filter(([k]) => k.startsWith(prefix))
    .map(([file, v]) => ({ file, verdict: String(v?.verdict ?? 'pending') }))
  return { applies: true, entries }
}
