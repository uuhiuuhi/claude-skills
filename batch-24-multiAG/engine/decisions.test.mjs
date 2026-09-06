// decisions.test.mjs — 질문 최소화·질문 렌더·인박스 연동(설계 §9-1 `decisions` 항목) 테스트.
//
// 실행: node --test night-batch-ops/engine/decisions.test.mjs
//
// 마지막 블록은 **실제 jng-os 인박스**(2,845줄)를 읽기 전용으로 파싱한다 — 픽스처만으로는
// 「✅ 해소 절 안에 남아 있는 🟠 하위 항목」 같은 실물 함정을 만들어 낼 수 없기 때문이다.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createFakeProject, FIXTURE_STORY_KEYS, FIXTURE_PATHS } from './fixtures/fake-bmad-project.mjs'
import { readProject } from './diagnose.mjs'
import {
  QUESTION_CATEGORIES, CATEGORY_META, TECHNICAL_KINDS, INBOX_HEADER,
  alreadyAsked, autoDefault, blockedMap, buildInboxBlock, buildQuestion, findConfirmed,
  inboxWritePlan, needsHuman, pendingKeys, plainKo, questionFingerprint, renderNewInbox, renderQuestion,
} from './decisions.mjs'

const K = FIXTURE_STORY_KEYS
const JNG_INBOX = 'C:/Projects/jng-os/_bmad-output/implementation-artifacts/DECISIONS-INBOX.md'

/** 8범주 각 1건 — 실제로 배치가 만나는 문장으로 만든다. */
const SUBJECTS = {
  'product-intent': { kind: 'unmappable', title: '어느 에픽에도 매핑할 수 없는 일이 있다', why: '계획 문서에 자리가 없다' },
  'ux-business': { kind: 'new-user-copy', title: '저장 실패 안내에 새 문구를 만든다', why: '지금은 아무 말도 안 나온다' },
  'irreversible-data': { kind: 'destructive-migration', title: '옛 표를 정리한다', sql: 'DROP TABLE legacy_tickets;' },
  'paid-cost': { title: '유료 번역 서비스를 붙인다', why: '월 요금이 발생한다' },
  'account-auth-secret': { kind: 'secret-value', title: '열쇠가 코드 안에 들어 있다', why: '저장소를 받은 사람이 그대로 쓸 수 있다' },
  'legal-policy': { title: '개인정보 보관 기간을 정한다', why: '약관에 적을 값이다' },
  'public-egress': { title: '고객에게 발송하는 새 경로를 연다', why: '지금까지 나가던 적이 없다' },
  'vcs-approval': { action: 'push', title: '이번 라운드 결과를 푸시할까요', why: '푸시 승인 여부' },
}

// ═══════════════════════════════════════════════════════════════════════════
// A. needsHuman — 8범주와 「묻지 않는다」
// ═══════════════════════════════════════════════════════════════════════════

test('QUESTION_CATEGORIES 는 8범주이고 전부 메타가 있다', () => {
  assert.equal(QUESTION_CATEGORIES.length, 8)
  assert.equal(new Set(QUESTION_CATEGORIES).size, 8)
  for (const c of QUESTION_CATEGORIES) {
    assert.ok(CATEGORY_META[c], `메타 누락: ${c}`)
    assert.ok(CATEGORY_META[c].label && CATEGORY_META[c].why)
    assert.ok(['🟠', '🔴'].includes(CATEGORY_META[c].marker))
  }
})

test('8범주 각 1건이 전부 ask=true 로, 맞는 범주로 잡힌다', () => {
  for (const [expected, subject] of Object.entries(SUBJECTS)) {
    const v = needsHuman(subject)
    assert.equal(v.ask, true, `${expected} 이 질문으로 안 잡힌다: ${JSON.stringify(v)}`)
    assert.equal(v.category, expected)
    assert.ok(v.why.length > 5)
  }
})

test('기술 판단은 묻지 않는다 — 문장에 「배포」가 스쳐도 질문이 되지 않는다', () => {
  const technical = [
    { kind: 'open-patch', title: '리뷰 지적 회수', why: '검토자가 찾은 문제를 고친다' },
    { kind: 'gate-red', title: '검사 빨간불 고치기', why: '지금 상태로는 배포할 수 없다' },
    { kind: 'untested-files', title: '테스트 없는 파일에 테스트 추가', why: '조용히 깨지는 것을 막는다' },
    { kind: 'file-list-missing', title: '무엇을 만졌는지 기록 채우기', why: '되돌릴 지점을 남긴다' },
    { kind: 'test-skip', title: '꺼진 검사 되살리기', why: '통과가 통과가 아니다' },
    { kind: 'status-drift', title: '상태 표기 맞추기', why: '현황판이 실제와 다르다' },
  ]
  for (const s of technical) {
    const v = needsHuman(s)
    assert.equal(v.ask, false, `${s.kind} 을 물으면 질문이 홍수가 된다: ${JSON.stringify(v)}`)
    assert.match(v.why, /묻지 않고/)
  }
  for (const k of TECHNICAL_KINDS) assert.equal(needsHuman({ kind: k, title: k }).ask, false, k)
})

test('되돌릴 수 없는 범주는 기술 kind 라도 이긴다(비밀·삭제·발송)', () => {
  const v1 = needsHuman({ kind: 'temp-code', title: '임시 표시 정리', why: '환경 변수를 새로 만든다' })
  assert.equal(v1.ask, true)
  assert.equal(v1.category, 'account-auth-secret')
  const v2 = needsHuman({ kind: 'open-patch', title: '정리', sql: 'DELETE FROM tickets WHERE 1=1' })
  assert.equal(v2.category, 'irreversible-data')
})

test('인박스에 이미 확정된 결정이 있으면 다시 묻지 않고 근거를 인용한다', () => {
  const fx = createFakeProject()
  try {
    const inboxText = fx.read(`${FIXTURE_PATHS.IMPL}/DECISIONS-INBOX.md`)
    assert.match(inboxText, /## ✅ 확정 — 1-1 목록 정렬 기준/)
    const subject = { kind: 'new-user-copy', story: K.ok, title: '목록 정렬 기준을 새 문구로 안내한다', why: '정렬 기준을 사용자가 모른다' }
    assert.equal(needsHuman(subject).ask, true, '인박스를 안 주면 질문이다')
    const v = needsHuman(subject, { inboxText })
    assert.equal(v.ask, false, '확정된 결정이 있는데 또 물으면 정체가 반복된다')
    assert.match(v.why, /이미 확정된 결정/)
    assert.match(v.why, /이름 오름차순/, '근거를 인용해야 한다')
    assert.equal(v.evidence.length, 1)

    // 아직 안 정해진 것(🟠 절)은 확정으로 읽으면 안 된다
    const open = needsHuman({ kind: 'new-user-copy', story: K.openDecision, title: '완전히 다른 새 화면 문구' }, { inboxText })
    assert.equal(open.ask, true)
  } finally { fx.cleanup() }
})

test('findConfirmed 는 ✅ 절만 본다', () => {
  const text = ['# 결정 인박스 (상시)', '', '## 🟠 결정 대기 — 2.5 문구', '', '아직 안 정했다 정렬 기준', '', '## ✅ 확정 — 2.6 정렬', '', '오름차순으로 한다', ''].join('\n')
  assert.equal(findConfirmed(text, { story: '2-5-문구', title: '정렬 기준' }), null, '대기 절을 확정으로 읽으면 안 된다')
  const hit = findConfirmed(text, { story: '2-6-정렬', title: '정렬 방향' })
  assert.ok(hit)
  assert.match(hit.quote, /오름차순/)
})

// ═══════════════════════════════════════════════════════════════════════════
// B. 질문 렌더 — 비개발자 언어
// ═══════════════════════════════════════════════════════════════════════════

test('plainKo 는 경로·함수 표기·확장자·코드 인용을 지운다', () => {
  const out = plainKo('`src/lib/config.ts` 의 loadKey() 가 열쇠를 읽는다 — auto.config.json 참고')
  assert.ok(!out.includes('`'))
  assert.ok(!/\//.test(out))
  assert.ok(!/loadKey/.test(out) || !/loadKey\(/.test(out))
  assert.ok(!/\.(ts|json|mjs)\b/.test(out))
  assert.match(out, /열쇠를 읽는다/, '뜻은 남아야 한다')
})

test('renderQuestion 본문에는 파일 경로·함수명·확장자·빈 괄호가 없다(비개발자 언어 단언)', () => {
  const subject = {
    kind: 'new-user-copy', story: K.openDecision,
    title: '`src/feature/d.ts` 의 labelD() 문구를 무엇으로 할까',
    why: 'saveC() 가 실패해도 `tests/feature/c.test.ts` 가 잡지 못한다',
    situation: '저장이 실패해도 화면이 아무 말을 안 한다',
  }
  const q = buildQuestion(subject, null, { index: 1 })
  const md = renderQuestion(q)

  assert.ok(!md.includes('`'), '코드 인용 금지')
  assert.ok(!/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(md), `경로가 남았다: ${md}`)
  assert.ok(!/\.(mjs|cjs|js|jsx|ts|tsx|json|sql|ya?ml|md|html|css)\b/.test(md), `확장자가 남았다: ${md}`)
  assert.ok(!/[A-Za-z_$][A-Za-z0-9_$]*\(/.test(md), `함수 표기가 남았다: ${md}`)
  assert.ok(!md.includes('()'))

  // 형식 6요소(설계 §5-2)
  assert.match(md, /^### ① 🟠 /m)
  assert.match(md, /\[medium\]/)
  assert.match(md, /\*\*지금 무슨 일\*\* —/)
  assert.match(md, /\*\*왜 물어보나\*\* —/)
  assert.match(md, /\*\*선택지\*\*/)
  assert.match(md, /^- ⓐ .*\*\*\(추천\)\*\*/m)
  assert.match(md, /^- ⓑ /m)
  assert.match(md, /^- ⓒ /m)
  assert.match(md, /\*\*안전 기본값\*\* —/)
  assert.match(md, /\*\*기다리는 동안 계속 도는 것\*\* —/)
  assert.match(md, /지문 [0-9a-f]{10}/)
})

test('같은 subject 는 같은 지문 · 다른 subject 는 다른 지문', () => {
  const a = { kind: 'new-user-copy', story: '2-2-x', title: '문구를 무엇으로 할까' }
  assert.equal(questionFingerprint(a), questionFingerprint({ ...a }))
  assert.notEqual(questionFingerprint(a), questionFingerprint({ ...a, title: '다른 질문' }))
  assert.equal(questionFingerprint(a).length, 10)
})

// ═══════════════════════════════════════════════════════════════════════════
// C. 인박스 연동
// ═══════════════════════════════════════════════════════════════════════════

test('buildInboxBlock 은 공용 관례(절 제목·목록)를 그대로 쓰고 본문을 붙인다', () => {
  const qs = [buildQuestion({ ...SUBJECTS['ux-business'], story: K.openDecision }, null, { index: 1 })]
  const block = buildInboxBlock(qs, { date: '2026-09-03', storyKey: K.openDecision })
  assert.match(block, /^## 🟠 결정 대기 — Story 2\.2 /m, 'jng-os 인박스 절 제목 형식')
  assert.match(block, /등재 2026-09-03/)
  assert.match(block, /^### ① 🟠 /m)
  assert.match(block, /지문 [0-9a-f]{10}/)

  const noStory = buildInboxBlock(qs, { date: '2026-09-03' })
  assert.match(noStory, /^## 🟠 결정 대기 — 프로젝트 전체/m)
  assert.equal(buildInboxBlock([], {}), '')
})

test('같은 지문은 두 번 등재하지 않는다', () => {
  const q = buildQuestion({ ...SUBJECTS['ux-business'], story: K.openDecision }, null, { index: 1 })
  const block = buildInboxBlock([q], { date: '2026-09-03', storyKey: K.openDecision })
  const text = `${INBOX_HEADER}\n\n${block}`
  assert.equal(alreadyAsked(text, q.fingerprint), true)
  const again = inboxWritePlan({ path: 'p/DECISIONS-INBOX.md', exists: true, text, questions: [q] })
  assert.equal(again.op, 'skip')
  assert.equal(again.questions.length, 0)

  const other = buildQuestion({ ...SUBJECTS['paid-cost'] }, null, { index: 1 })
  const next = inboxWritePlan({ path: 'p/DECISIONS-INBOX.md', exists: true, text, questions: [q, other] })
  assert.equal(next.op, 'insert-after-heading')
  assert.equal(next.questions.length, 1, '새 질문만 올린다')
  assert.equal(next.anchor, INBOX_HEADER)
})

test('인박스가 없으면 안전한 기본 형식으로 만든다(BRIEF 정책 15) · 만들 수 없으면 실패로 판정한다', () => {
  const q = buildQuestion(SUBJECTS['product-intent'], null, { index: 1 })
  const plan = inboxWritePlan({ path: '_bmad-output/implementation-artifacts/DECISIONS-INBOX.md', exists: false, text: '', questions: [q], date: '2026-09-03' })
  assert.equal(plan.ok, true)
  assert.equal(plan.op, 'create-file')
  assert.ok(plan.body.startsWith(`${INBOX_HEADER}\n`), '첫 줄이 표준 제목이어야 이후 라운드가 끼워 넣을 수 있다')
  assert.match(plan.body, /### ① 🟠 /)

  // 경로를 모르면 Decision 적용 실패
  const dead = inboxWritePlan({ path: null, questions: [q] })
  assert.equal(dead.ok, false)
  assert.match(dead.why, /적용할 수 없다/)

  // 첫 줄이 예상 제목이 아니면 손대지 않는다
  const weird = inboxWritePlan({ path: 'x/INBOX.md', exists: true, text: '아무 제목도 없는 파일\n', questions: [q] })
  assert.equal(weird.ok, false)
  assert.match(weird.why, /함부로 고치지 않는다/)
})

test('renderNewInbox 로 만든 파일은 다음 라운드의 pendingKeys 가 그대로 읽는다(왕복)', () => {
  const q = buildQuestion({ ...SUBJECTS['ux-business'], story: '2-2-결정-열림' }, null, { index: 1 })
  const body = renderNewInbox(buildInboxBlock([q], { date: '2026-09-03', storyKey: '2-2-결정-열림' }), { now: new Date('2026-09-03') })
  const pend = pendingKeys(body, { storyKeys: ['2-2-결정-열림'] })
  assert.ok(pend.length >= 1)
  assert.equal(pend[0].key, '2-2-결정-열림')
  assert.deepEqual(Object.keys(blockedMap(pend)), ['2-2-결정-열림'])
})

// ═══════════════════════════════════════════════════════════════════════════
// D. pendingKeys — 실물 형식
// ═══════════════════════════════════════════════════════════════════════════

test('pendingKeys — ✅ 해소 절 **안의** 🟠 하위 항목은 세지 않고, 표지 문구가 있는 하위 절은 센다', () => {
  const text = [
    '# 결정 인박스 (상시)',
    '',
    '## ✅ 해소 — 11.3 계약 등록 폼 (확정 2026-09-02)',
    '',
    '### ① 🟠 시작일보다 한참 뒤를 골라도 아무 말이 없습니다 (medium)',
    '',
    '이미 답이 나온 기록이다.',
    '',
    '## ✅ 확정 — 11.5 렌탈 이관 이연',
    '',
    '### 🟠 남은 사람 판단 1건 — 미적용 파일을 어떻게 할까요',
    '',
    '## 🔴 결정 대기 — 2.10 AI 구조화, Decision 3건',
    '',
    '### ① 🔴 권한이 내려간 화면의 안내가 거짓입니다 (high)',
    '',
    '## 🟢 사후 확인 — 4.7 상주 매트릭스',
    '',
    '지금 하실 일 없음.',
    '',
  ].join('\n')
  const p = pendingKeys(text)
  const keys = p.map((x) => x.key)
  assert.ok(!keys.includes('11-3'), '✅ 해소 절 안의 하위 항목을 세면 영원히 안 풀린다')
  assert.ok(keys.includes('11-5'), '표지 문구를 가진 하위 절은 부모가 확정이어도 열린 것이다')
  assert.equal(keys.filter((k) => k === '2-10').length, 2, '열린 절 + 그 하위 항목')
  assert.ok(!keys.includes('4-7'), '🟢 사후 확인은 결정 대기가 아니다')
  assert.equal(p.find((x) => x.id === '2-10' && x.severity === 'high') !== undefined, true)
})

test('pendingKeys 는 sprint 키를 주면 전체 키로 풀어 준다(validatePlan blocked 형식)', () => {
  const text = '# 결정 인박스 (상시)\n\n## 🟠 결정 대기 — 2.2 문구 판단\n\n'
  const p = pendingKeys(text, { storyKeys: ['2-2-결정-열림', '2-1-패치-열림'] })
  assert.deepEqual(p.map((x) => x.key), ['2-2-결정-열림'])
  const map = blockedMap(p)
  assert.equal(typeof map['2-2-결정-열림'], 'string')
  assert.equal(Object.keys(blockedMap(pendingKeys('# 결정 인박스 (상시)\n\n## 🟠 사람 게이트 — 전체 점검\n'))).length, 0, '스토리 번호가 없으면 특정 스토리를 막지 않는다')
})

test('실제 jng-os 결정 인박스를 읽기 전용으로 파싱한다(실물 형식 회귀)', (t) => {
  if (!existsSync(JNG_INBOX)) return t.skip('jng-os 인박스가 없는 환경')
  const text = readFileSync(JNG_INBOX, 'utf8')
  const before = readFileSync(JNG_INBOX, 'utf8')
  const p = pendingKeys(text)
  const keys = [...new Set(p.map((x) => x.key))]
  // 실측(2026-09-03): 열린 절 17건 / 고유 스토리 12건. 형식이 바뀌면 이 수가 흔들린다 —
  // 정확한 수보다 「0 이 아니고, 전부 스토리 키로 풀린다」가 회귀 신호다.
  assert.ok(p.length >= 10, `열린 결정이 ${p.length}건 — 파서가 실물 형식을 놓쳤을 수 있다`)
  assert.ok(keys.length >= 8)
  assert.ok(keys.every((k) => /^\d+-\d+$/.test(k) || k === '(프로젝트 전체)'), keys.join(', '))
  assert.ok(keys.includes('2-10') && keys.includes('4-6'), `실측 알려진 봉쇄가 빠졌다: ${keys.join(', ')}`)
  assert.ok(p.every((x) => x.severity === 'high' || x.severity === 'medium' || x.severity === 'low'))
  assert.equal(readFileSync(JNG_INBOX, 'utf8'), before, '읽기만 한다 — 1바이트도 쓰지 않는다')
  t.diagnostic(`jng-os 인박스 실측: 열린 절 ${p.length}건 · 고유 키 ${keys.length}건 (${keys.join(', ')})`)
})

// ═══════════════════════════════════════════════════════════════════════════
// E. 무인 기본값
// ═══════════════════════════════════════════════════════════════════════════

test('autoDefault — 기술 판단은 추천안으로 진행, 정책·비가역·비용·보안·법률·발송은 기본값을 만들지 않는다', () => {
  const tech = autoDefault({ kind: 'open-patch', title: '리뷰 지적 회수' })
  assert.ok(tech && /무인 기본값/.test(tech.value))
  for (const c of ['ux-business', 'irreversible-data', 'paid-cost', 'account-auth-secret', 'legal-policy', 'public-egress']) {
    assert.equal(autoDefault(SUBJECTS[c]), null, `${c} 는 무인 기본값을 만들면 안 된다(무인 규칙 ③)`)
  }
  assert.match(autoDefault(SUBJECTS['vcs-approval']).value, /하지 않고/)
  assert.match(autoDefault(SUBJECTS['product-intent']).value, /대기 목록/)
})

test('실제 픽스처 스냅숏에서 뽑은 지적들은 대부분 질문이 되지 않는다(질문 최소화)', () => {
  const fx = createFakeProject()
  try {
    const snapshot = readProject(fx.root)
    const inboxText = fx.read(`${FIXTURE_PATHS.IMPL}/DECISIONS-INBOX.md`)
    const subjects = [
      ...snapshot.code.tempCode.map((f) => ({ kind: f.kind, title: f.why, why: f.why })),
      ...snapshot.code.disabledTests.map((f) => ({ kind: f.kind, title: f.why, why: f.why })),
      ...snapshot.code.onlyHits.map((f) => ({ kind: f.kind, title: f.why, why: f.why })),
    ]
    assert.ok(subjects.length >= 3, '픽스처가 지적을 만들지 못했다')
    const asked = subjects.filter((s) => needsHuman(s, { inboxText }).ask)
    assert.equal(asked.length, 0, `기술 지적이 질문이 됐다: ${JSON.stringify(asked)}`)
  } finally { fx.cleanup() }
})
