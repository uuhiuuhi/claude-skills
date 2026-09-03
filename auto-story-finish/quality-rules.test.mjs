// 품질 규칙 테스트 — 실측 로그 형태(tsc · eslint · vitest)를 픽스처로 쓴다. LLM 호출 0.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  REPAIR_DEFAULTS, buildVerificationManifest, classifyQaFailure, deletedTestJustified, detectGates, escalateRepairIntroduced,
  escalationReport, parseQaChain, performanceTriggers, qaSubchecks, repairDecision, securityTriggers, splitDiffByFile, testIntegrityFindings,
} from './quality-rules.mjs'

const SCRIPTS = { dev: 'vite', build: 'tsc -b && vite build', typecheck: 'tsc -b --noEmit', lint: 'eslint . --max-warnings=0', test: 'vitest run', qa: 'npm run typecheck && npm run lint && npm run test' }

describe('[quality] 게이트 탐지 — package.json 에 실제로 있는 명령만', () => {
  it('있는 것은 available+cmd · 없는 것은 available=false(임의 가정 금지)', () => {
    const g = detectGates(SCRIPTS)
    assert.deepEqual(g.qa, { available: true, cmd: 'npm run qa', script: 'qa' })
    assert.equal(g.lint.cmd, 'npm run lint')
    assert.equal(g.typecheck.cmd, 'npm run typecheck')
    assert.equal(g.test.cmd, 'npm run test')
    assert.equal(g.build.available, true)
    for (const k of ['coverage', 'e2e', 'security', 'performance']) assert.equal(g[k].available, false, k)
    assert.equal(detectGates({}).qa.available, false)
    assert.equal(detectGates(undefined).qa.available, false)
  })
  it('qa 사슬 파싱', () => {
    assert.deepEqual(parseQaChain(SCRIPTS.qa), ['typecheck', 'lint', 'test'])
    assert.deepEqual(parseQaChain('npm test'), ['test'])
    assert.deepEqual(parseQaChain(''), [])
  })
})

describe('[quality] qa 실패 분류 — 종류 + 안정적 서명(줄 번호 제외) + 발췌', () => {
  it('tsc: path(line,col): error TSxxxx → typecheck · 서명 = 파일:코드', () => {
    const r = classifyQaFailure('> company-os@0.0.0 typecheck\n> tsc -b --noEmit\n\nsrc/features/a.ts(41,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\nsrc/features/a.ts(52,3): error TS2304: Cannot find name \'x\'.\n')
    assert.equal(r.kind, 'typecheck')
    assert.equal(r.signature, 'typecheck:src/features/a.ts:TS2322')
    assert.ok(r.excerpt.includes('TS2322'))
    // 줄 번호가 바뀌어도 같은 원인 서명
    assert.equal(classifyQaFailure('src/features/a.ts(99,1): error TS2322: x').signature, r.signature)
  })
  it('eslint(실측 2026-08-28 로그 형태): 파일 + 규칙 id', () => {
    const log = '\n> company-os@0.0.0 lint\n> eslint . --max-warnings=0\n\n\nC:\\Projects\\x\\tools\\auto\\run-night.mjs\n  324:17  error  The value assigned to \'merged\' is not used in subsequent statements  no-useless-assignment\n\n✖ 1 problem (1 error, 0 warnings)\n'
    const r = classifyQaFailure(log)
    assert.equal(r.kind, 'lint')
    assert.equal(r.signature, 'lint:C:\\Projects\\x\\tools\\auto\\run-night.mjs:no-useless-assignment')
  })
  it('vitest: FAIL 줄 → test · 서명 = 파일 > 케이스', () => {
    const log = ' ❯ tests/a.test.ts (3)\n   × suite > case 1\n\n FAIL  tests/a.test.ts > suite > case 1\nAssertionError: expected 1 to be 2\n\n Test Files  1 failed | 156 passed (157)\n      Tests  1 failed | 4314 passed (4315)\n'
    const r = classifyQaFailure(log)
    assert.equal(r.kind, 'test')
    assert.equal(r.signature, 'test:tests/a.test.ts > suite > case 1')
  })
  it('vite build 실패 → build · 정체불명 → unknown(마지막 오류 줄)', () => {
    assert.equal(classifyQaFailure('vite v6 building for production...\nerror during build:\nRollupError: x').kind, 'build')
    const u = classifyQaFailure('npm ERR! something odd')
    assert.equal(u.kind, 'unknown')
    assert.ok(u.signature.startsWith('unknown:'))
  })
  it('테스트 이름 안의 "error TS" 문구는 typecheck 로 오분류하지 않는다(실측 로그 함정)', () => {
    const log = ' ✓ tests/db/guard.test.ts > 소스에 error TS2322 문구가 없다\n FAIL  tests/b.test.ts > k\nAssertionError: x'
    assert.equal(classifyQaFailure(log).kind, 'test')
  })
  it('ANSI 색 코드·CR 은 제거하고 판정한다', () => {
    assert.equal(classifyQaFailure('\u001b[31msrc/a.ts(1,1): error TS1005: x\u001b[0m\r\n').signature, 'typecheck:src/a.ts:TS1005')
  })
})

describe('[quality] 수리 예산 — 같은 원인 N회 · 총 M회 · 꺼짐 · 무한루프 없음', () => {
  it('기본값 = 같은 원인 3 · 총 5', () => {
    assert.deepEqual(REPAIR_DEFAULTS, { totalRepairAttempts: 5, sameRootCauseMaxRetries: 3 })
  })
  it('첫 실패 → 수리 · 같은 원인 3회 수리 후 4번째 관측 → 중단 · 총 5회 소진 → 중단', () => {
    assert.equal(repairDecision({ attempts: 0, signatures: ['a'] }).repair, true)
    assert.equal(repairDecision({ attempts: 2, signatures: ['a', 'a', 'a'] }).repair, true) // 3번째 관측 = 2회 수리했음 → 한 번 더
    const stop = repairDecision({ attempts: 3, signatures: ['a', 'a', 'a', 'a'] })
    assert.equal(stop.repair, false)
    assert.match(stop.why, /같은 원인/)
    assert.equal(repairDecision({ attempts: 4, signatures: ['a', 'b', 'c', 'd', 'e'] }).repair, true)
    const budget = repairDecision({ attempts: 5, signatures: ['a', 'b', 'c', 'd', 'e', 'f'] })
    assert.equal(budget.repair, false)
    assert.match(budget.why, /총 수리 시도 5회/)
  })
  it('autoRepair 0(종전 동작) → 절대 수리하지 않는다 · 설정으로 조정', () => {
    assert.equal(repairDecision({ attempts: 0, signatures: ['a'], cfg: { totalRepairAttempts: 0 } }).repair, false)
    assert.equal(repairDecision({ attempts: 1, signatures: ['a', 'a'], cfg: { sameRootCauseMaxRetries: 1 } }).repair, false)
    assert.equal(repairDecision({ attempts: 1, signatures: ['a', 'b'], cfg: { totalRepairAttempts: 2 } }).repair, true)
    assert.equal(repairDecision({ attempts: 2, signatures: ['a', 'b', 'c'], cfg: { totalRepairAttempts: 2 } }).repair, false)
  })
  it('종결성 — 어떤 서명 열이 와도 총 상한 안에서 반드시 false 에 닿는다', () => {
    for (const sigs of [['a', 'a', 'a', 'a', 'a', 'a'], ['a', 'b', 'a', 'b', 'a', 'b'], ['a', 'b', 'c', 'd', 'e', 'f']]) {
      let attempts = 0, stopped = false
      for (let i = 1; i <= 10; i++) { const d = repairDecision({ attempts, signatures: sigs.slice(0, i) }); if (!d.repair) { stopped = true; break } attempts++ }
      assert.ok(stopped && attempts <= 5, `무한루프: ${sigs}`)
    }
  })
})

describe('[quality] 테스트 무결성 — 꼼수 탐지 · 정당한 삭제는 사유로 통과', () => {
  const diff = [
    'diff --git a/tests/y.test.ts b/tests/y.test.ts',
    '--- a/tests/y.test.ts', '+++ b/tests/y.test.ts',
    '@@ -1,6 +1,5 @@',
    ' import x',
    '+it.only("x", () => {})',
    '+// @ts-ignore',
    '+describe.skip("s", () => {})',
    '-expect(a).toBe(1)', '-expect(b).toBe(2)', '-expect(c).toBe(3)',
    '+expect(true).toBe(true)',
    'diff --git a/src/z.ts b/src/z.ts',
    '--- a/src/z.ts', '+++ b/src/z.ts',
    '@@ -10,2 +10,3 @@',
    '+// eslint-disable-next-line no-console',
    '+console.log(1)',
    'diff --git a/vite.config.ts b/vite.config.ts',
    '--- a/vite.config.ts', '+++ b/vite.config.ts',
    '@@ -1,1 +1,2 @@',
    '+  exclude: ["tests/hard.test.ts"],',
  ].join('\n')
  it('block: .only · 사유 없는 테스트 삭제 / warn: skip · ts-ignore · eslint-disable · 항상 참 단언 · 단언 약화 · exclude', () => {
    const f = testIntegrityFindings({ changes: [{ status: 'D', path: 'tests/x.test.ts' }, { status: 'M', path: 'src/z.ts' }], diff, storyText: '' })
    const rules = f.map((x) => `${x.level}:${x.rule}`)
    assert.ok(rules.includes('block:deleted-test'))
    assert.ok(rules.includes('block:test-only'))
    assert.ok(rules.includes('warn:test-skip'))
    assert.ok(rules.includes('warn:ts-ignore'))
    assert.ok(rules.includes('warn:eslint-disable'))
    assert.ok(rules.includes('warn:trivial-assertion'))
    assert.ok(rules.includes('warn:assertion-weakened'))
    assert.ok(rules.includes('warn:coverage-exclude'))
    const only = f.find((x) => x.rule === 'test-only')
    assert.equal(only.file, 'tests/y.test.ts')
    assert.equal(only.line, 2) // hunk +1 시작 · 문맥 1줄 뒤
  })
  it('스토리에 삭제 사유가 있으면 warn 으로 내려간다', () => {
    assert.ok(deletedTestJustified('- `tests/x.test.ts` 삭제 — 기능이 사라져 무의미', 'tests/x.test.ts'))
    assert.ok(!deletedTestJustified('tests/x.test.ts 를 고쳤다', 'tests/x.test.ts'))
    const f = testIntegrityFindings({ changes: [{ status: 'D', path: 'tests/x.test.ts' }], diff: '', storyText: 'x.test.ts 삭제: 대체됨' })
    assert.deepEqual(f.map((x) => x.level + ':' + x.rule), ['warn:deleted-test-justified'])
  })
  it('비테스트 파일 삭제·평범한 변경은 무소음 · 빈 입력 안전', () => {
    assert.deepEqual(testIntegrityFindings({ changes: [{ status: 'D', path: 'src/old.ts' }], diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,2 @@\n+const y = 1\n' }), [])
    assert.deepEqual(testIntegrityFindings({}), [])
  })
  it('게이트 설정 변조(package.json qa/lint/typecheck/test 스크립트 · tsconfig · eslint/vite 설정)는 경고 · 무관한 package.json 줄은 무소음(F32)', () => {
    const d1 = 'diff --git a/package.json b/package.json\n@@ -1,3 +1,3 @@\n-    "qa": "npm run typecheck && npm run lint && npm run test",\n+    "qa": "npm run typecheck",\n'
    assert.deepEqual(testIntegrityFindings({ diff: d1 }).map((f) => `${f.level}:${f.rule}`), ['warn:gate-config-changed'])
    const d2 = 'diff --git a/package.json b/package.json\n@@ -1,2 +1,3 @@\n+    "lodash": "^4",\n'
    assert.deepEqual(testIntegrityFindings({ diff: d2 }), [])
    const d3 = 'diff --git a/tsconfig.app.json b/tsconfig.app.json\n@@ -1,2 +1,3 @@\n+    "strict": false,\n'
    assert.equal(testIntegrityFindings({ diff: d3 })[0].rule, 'gate-config-changed')
  })
  it('수리 라운드가 새로 만든 warn 은 block 으로 승격 · 기준선에 있던 것은 그대로(F5)', () => {
    const base = [{ level: 'warn', rule: 'ts-ignore', file: 'src/old.ts', line: 3, detail: 'd' }]
    const cur = [
      { level: 'warn', rule: 'ts-ignore', file: 'src/old.ts', line: 9, detail: 'd' },
      { level: 'warn', rule: 'test-skip', file: 'tests/a.test.ts', line: 1, detail: 'd' },
      { level: 'block', rule: 'test-only', file: 'tests/a.test.ts', line: 2, detail: 'd' },
    ]
    const out = escalateRepairIntroduced(base, cur)
    assert.deepEqual(out.map((f) => `${f.level}:${f.rule}`), ['warn:ts-ignore', 'block:test-skip(repair-introduced)', 'block:test-only'])
    assert.deepEqual(escalateRepairIntroduced([], []), [])
  })
  it('같은 파일·같은 rule 이어도 **새 줄**이면 신규다 — 줄 내용 지문까지 비교(리뷰 #8)', () => {
    const base = [{ level: 'warn', rule: 'test-skip', file: 'tests/a.test.ts', line: 3, detail: 'd', fp: "it.skip('오래된 것', () => {})" }]
    // 같은 지문(줄 번호만 밀림) = 선재 흔적 → 그대로 warn
    const same = escalateRepairIntroduced(base, [{ ...base[0], line: 40 }])
    assert.deepEqual(same.map((f) => f.level), ['warn'])
    // 같은 파일에 같은 종류의 **다른** skip 을 새로 넣었다 → 기존 warning 에 가려지지 않는다
    const added = escalateRepairIntroduced(base, [base[0], { ...base[0], line: 9, fp: "it.skip('방금 막은 것', () => {})" }])
    assert.deepEqual(added.map((f) => `${f.level}:${f.rule}`), ['warn:test-skip', 'block:test-skip(repair-introduced)'])
  })
  it('무결성 findings 는 지문(fp)을 담는다 — 공백만 다른 줄은 같은 지문', () => {
    const d = (line) => `diff --git a/tests/a.test.ts b/tests/a.test.ts\n@@ -1,1 +1,2 @@\n+${line}\n`
    const a = testIntegrityFindings({ diff: d("it.skip('x', () => {})") })[0]
    const b = testIntegrityFindings({ diff: d("it.skip('x',   () => {})   ") })[0]
    assert.equal(a.rule, 'test-skip')
    assert.equal(a.fp, "it.skip('x', () => {})")
    assert.equal(a.fp, b.fp, '공백 차이는 같은 지문이어야 한다')
  })
  it('빈 테스트 본문·node:assert 류 항상-참 단언도 잡는다', () => {
    const f = (line) => testIntegrityFindings({ diff: `diff --git a/tests/a.test.ts b/tests/a.test.ts\n@@ -1,1 +1,2 @@\n+${line}\n` }).map((x) => x.rule)
    assert.deepEqual(f("it('언젠가 쓴다', () => {})"), ['empty-test'])
    assert.deepEqual(f('  assert.ok(1)'), ['trivial-assertion'])
    assert.deepEqual(f("it('진짜 테스트', () => { assert.equal(sum(1,2), 3) })"), [])
  })
  it('splitDiffByFile 줄 번호 — hunk 헤더 기준', () => {
    const d = splitDiffByFile('diff --git a/f.ts b/f.ts\n@@ -5,2 +7,3 @@\n ctx\n+A\n-R\n+B\n')
    assert.deepEqual(d['f.ts'].added, [{ line: 8, text: 'A' }, { line: 9, text: 'B' }])
    assert.deepEqual(d['f.ts'].removed, [{ text: 'R' }])
  })
})

describe('[quality] 조건부 게이트 트리거 — 변경 내용 기반', () => {
  it('security: 경로(auth/rls/migrations/upload…) 또는 diff 키워드', () => {
    assert.equal(securityTriggers({ files: ['src/features/tickets/list.tsx'] }).required, false)
    assert.equal(securityTriggers({ files: ['supabase/migrations/20260901_x.sql'] }).required, true)
    const r = securityTriggers({ files: ['src/a.ts'], diff: '+  el.innerHTML = html' })
    assert.equal(r.required, true)
    assert.ok(r.reasons[0].startsWith('diff:'))
    assert.equal(securityTriggers({ files: ['src/a.ts'], diff: '-  el.innerHTML = html' }).required, false) // 삭제 줄은 트리거 아님
  })
  it('performance: 페이지네이션·캐시·배치·이미지 처리', () => {
    assert.equal(performanceTriggers({ files: ['src/lib/pagination.ts'] }).required, true)
    assert.equal(performanceTriggers({ diff: '+ await Promise.all(items.map(f))' }).required, true)
    assert.equal(performanceTriggers({ files: ['src/ui/Button.tsx'], diff: '+ const a = 1' }).required, false)
  })
})

describe('[quality] 매니페스트 — qa 사슬에서 정직하게 채울 수 있는 것만', () => {
  const gates = detectGates(SCRIPTS)
  it('qa 통과 → 사슬 전부 pass · coverage/e2e 는 n/a(사유) · integration 은 unknown', () => {
    const m = buildVerificationManifest({ story: 's', generatedAt: 't', gates, qa: { chain: ['typecheck', 'lint', 'test'], exit: 0 } })
    assert.equal(m.schema, 'auto-story-finish/verification/1')
    assert.equal(m.checks.qa, 'pass')
    assert.equal(m.checks.typecheck, 'pass')
    assert.equal(m.checks.lint, 'pass')
    assert.equal(m.checks.unit, 'pass')
    assert.match(m.checks.coverage, /^n\/a/)
    assert.match(m.checks.e2e, /^n\/a/)
    assert.match(m.checks.integration, /^unknown/)
    assert.equal(m.checks.security, 'not-required')
  })
  it('lint 실패 → typecheck pass · lint fail · test not-run', () => {
    assert.deepEqual(qaSubchecks({ chain: ['typecheck', 'lint', 'test'], qaExit: 1, failureKind: 'lint' }), { typecheck: 'pass', lint: 'fail', test: 'not-run' })
    assert.deepEqual(qaSubchecks({ chain: ['typecheck', 'lint', 'test'], qaExit: 1, failureKind: 'unknown' }), { typecheck: 'unknown', lint: 'unknown', test: 'unknown' })
    assert.deepEqual(qaSubchecks({ chain: ['typecheck'], qaExit: null }), { typecheck: 'not-run' })
  })
  it('보안 트리거 + 보안 스크립트 없음 → required-missing(거짓 통과 없음) · 있으면 not-run/결과', () => {
    const m = buildVerificationManifest({ story: 's', generatedAt: 't', gates, qa: { chain: [], exit: 0 }, security: { required: true, reasons: ['경로: auth'] } })
    assert.match(m.checks.security, /^required-missing/)
    assert.deepEqual(m.triggers.security, ['경로: auth'])
    const g2 = detectGates({ ...SCRIPTS, 'test:security': 'vitest run tests/security' })
    assert.equal(buildVerificationManifest({ story: 's', generatedAt: 't', gates: g2, qa: { chain: [], exit: 0 }, security: { required: true, reasons: [] } }).checks.security, 'not-run')
  })
  it('조건부 게이트를 실제로 돌렸으면 그 결과(pass/fail)와 실행 기록이 실린다(#10)', () => {
    const g2 = detectGates({ ...SCRIPTS, 'test:security': 'vitest run tests/security' })
    const m = buildVerificationManifest({
      story: 's', generatedAt: 't', gates: g2, qa: { chain: [], exit: 0 },
      security: { required: true, reasons: ['경로: src/auth/session.ts'], script: 'test:security', exit: 1, result: 'fail' },
    })
    assert.equal(m.checks.security, 'fail')
    assert.deepEqual(m.conditionalGates.security, { script: 'test:security', exit: 1, result: 'fail' })
    assert.deepEqual(m.conditionalGates.performance, { script: null, exit: null, result: 'not-required' })
    // 트리거됐는데 아직 안 돌렸으면 not-run(통과로 세지 않는다)
    const nr = buildVerificationManifest({ story: 's', generatedAt: 't', gates: g2, qa: { chain: [], exit: 0 }, security: { required: true, reasons: [] } })
    assert.equal(nr.conditionalGates.security.result, 'not-run')
  })
  it('보안 게이트 스크립트 이름은 흔한 것들을 본다(audit 포함) · 성능은 perf 계열', () => {
    assert.equal(detectGates({ audit: 'npm audit --audit-level=high' }).security.cmd, 'npm run audit')
    assert.equal(detectGates({ 'test:perf': 'x' }).performance.script, 'test:perf')
    assert.equal(detectGates({}).security.available, false)
  })
  it('수리·무결성·리뷰·에스컬레이션 필드가 실린다', () => {
    const m = buildVerificationManifest({ story: 's', generatedAt: 't', gates, qa: { chain: [], exit: 1, failureKind: 'test' }, repair: { attempts: 2, signatures: ['a', 'a'], exhausted: true }, integrity: [{ level: 'warn' }], review: { provider: 'codex', result: 'findings' }, escalation: 'REPORT' })
    assert.equal(m.checks.qa, 'fail')
    assert.deepEqual(m.repair, { attempts: 2, signatures: ['a', 'a'], exhausted: true })
    assert.equal(m.integrity.length, 1)
    assert.equal(m.review.provider, 'codex')
    assert.equal(m.escalation, 'REPORT')
  })
})

describe('[quality] 에스컬레이션 보고 — 6절 고정(「어떻게 할까요」 금지)', () => {
  it('상황·원인·시도·선택지·추천·위험 순서', () => {
    const r = escalationReport({ story: '2-3', stage: 'qa', situation: 'S', cause: 'C', tried: ['t1', 't2'], options: ['o1'], recommendation: 'R', risk: '중' })
    const idx = ['1) 상황: S', '2) 원인: C', '3) 이미 시도한 것:', '  1. t1', '  2. t2', '4) 선택지:', '  1. o1', '5) 추천: R', '6) 위험도: 중'].map((s) => r.indexOf(s))
    assert.ok(idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]), r)
    assert.ok(r.startsWith('🆘 사람 판단 필요 — [2-3] qa'))
    assert.ok(!/어떻게 할까요/.test(r))
  })
})
