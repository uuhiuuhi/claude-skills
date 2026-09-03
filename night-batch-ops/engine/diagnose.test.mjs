// diagnose.test.mjs — 진단기 테스트(설계 §9-1 `diagnose` 항목).
//
// 원칙: **실물로 문다.** 스텁 객체가 아니라 실제 임시 폴더 + 실제 `git init/commit` 픽스처를 만들고
// `readProject → diagnose` 를 왕복시킨다. 표기 실사고(굵은 findings · 👤 인용 · 문자열 안 `.only`)는
// 실물에서만 재현되기 때문이다.
//
// 실행: node --test night-batch-ops/engine/diagnose.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createFakeProject, FIXTURE_STORY_KEYS, FIXTURE_SECRETS, FIXTURE_INJECTED_SECRETS } from './fixtures/fake-bmad-project.mjs'
import { buildReport, renderReportJson, renderReportMd } from './report.mjs'
import {
  SNAPSHOT_SCHEMA, DIAGNOSIS_SCHEMA,
  readProject, diagnose, evidenceRank, classifyStoryCompletion,
  detectTempCode, detectDisabledTests, detectDeployBlockers, detectDocMismatch, detectSecurityRisks,
  runGateProbe, GATE_EXIT_OVERFLOW, npmInvocation, assertNoShellMeta, maskSecrets, deepRedact, lineContextAt, hasTestFor, sectionOfStory,
} from './diagnose.mjs'
import { deepRedact as sharedDeepRedact, redactSecrets as sharedRedactSecrets } from '../../auto-story-finish/providers/redact.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const K = FIXTURE_STORY_KEYS
const verdictOf = (d, key) => d.stories.find((s) => s.key === key)?.verdict

// 실제 `git init/commit` 은 Windows 에서 건당 0.7~2초라 파일 전체가 1분을 넘긴다.
// **기본 함정 조합**은 읽기만 하므로 하나를 돌려 쓰고, 함정을 바꾸거나 파일을 **고쳐 쓰는**
// 테스트만 새 픽스처를 만든다(공유본을 고치면 뒤 테스트가 오염된다 — 그래서 write 금지).
let SHARED = null
const shared = () => (SHARED ??= createFakeProject())
process.on('exit', () => { try { SHARED?.cleanup() } catch { /* 임시 폴더 — 실패해도 테스트 결과에 영향 없음 */ } })

/** 함정을 바꾸거나 픽스처를 고쳐 쓸 때만 쓴다(그 외에는 `shared()`). */
const withFx = (opts, fn) => {
  if (!opts || Object.keys(opts).length === 0) return fn(shared())
  const fx = createFakeProject(opts)
  try { return fn(fx) } finally { fx.cleanup() }
}
const withFreshFx = (opts, fn) => { const fx = createFakeProject(opts ?? {}); try { return fn(fx) } finally { fx.cleanup() } }

// ═══════════════════════════════════════════════════════════════════════════
// A. 읽기 전용 보증
// ═══════════════════════════════════════════════════════════════════════════

test('readProject 는 대상 저장소에 1바이트도 쓰지 않는다(실제 git 워킹트리 비교)', () => {
  withFx({}, (fx) => {
    const before = fx.porcelain()
    assert.equal(before, '', '픽스처는 clean 상태로 시작한다')
    const snap = readProject(fx.root)
    assert.equal(snap.schema, SNAPSHOT_SCHEMA)
    assert.equal(fx.porcelain(), before, 'readProject 후 워킹트리가 달라졌다 — 어딘가에 썼다')
    diagnose(snap)
    assert.equal(fx.porcelain(), before, 'diagnose 후 워킹트리가 달라졌다')
  })
})

test('소스 앵커: diagnose.mjs 는 node:fs 의 쓰기 API 를 import 하지 않는다', () => {
  const src = readFileSync(join(HERE, 'diagnose.mjs'), 'utf8')
  const READ_ONLY = new Set(['readFileSync', 'existsSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync', 'accessSync', 'readlinkSync'])
  const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs(\/promises)?'/g)]
  assert.ok(imports.length > 0, 'node:fs import 를 찾지 못했다 — 앵커가 무의미해졌으니 테스트를 고칠 것')
  for (const m of imports) {
    assert.equal(m[2], undefined, 'node:fs/promises 는 쓰기 경로를 열어 준다 — 쓰지 않는다')
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim()
      if (!name) continue
      assert.ok(READ_ONLY.has(name), `쓰기 가능 API 를 import 했다: ${name}`)
    }
  }
  assert.ok(!/require\(\s*'node:fs'/.test(src), 'require 로 fs 를 다시 열지 않는다')
  assert.ok(!/\bwriteFileSync\s*\(|\bmkdirSync\s*\(|\brenameSync\s*\(|\brmSync\s*\(|\bappendFileSync\s*\(/.test(src), '쓰기 호출문이 있다')
})

// ═══════════════════════════════════════════════════════════════════════════
// B. jng-os 실물 형식 파싱(설계 §0)
// ═══════════════════════════════════════════════════════════════════════════

test('에픽 헤더는 ## 과 ### 가 혼재해도 전부 읽는다', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    assert.deepEqual(snap.epicHeaders.map((h) => h.epic), [1, 2, 3])
    assert.deepEqual(snap.epicStories.map((s) => s.id), ['1-1', '1-2', '2-1', '2-2', '3-1'])
  })
})

test('sprint-status 는 2칸 들여쓰기 스토리 행만 읽는다 — 긴 주석 안의 가짜 키·epic 집계 행 제외', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    assert.deepEqual(snap.sprint.map((r) => r.key), [K.ok, K.noFileList, K.openPatch, K.openDecision])
    assert.ok(!snap.sprint.some((r) => r.key.startsWith('epic-')), 'epic-N 집계 행이 섞였다')
    assert.ok(!snap.sprint.some((r) => r.key.startsWith('9-9')), '주석 안의 가짜 키를 스토리로 읽었다')
    assert.ok(snap.sprint.every((r) => r.line > 0), '줄 번호가 없다')
    assert.match(snap.sprint[0].note, /dev 완주/)
  })
})

test('File List 는 한 줄에 백틱 경로가 여러 개여도 전부 읽는다(matchAll)', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const st = snap.stories.find((s) => s.key === K.ok)
    assert.ok(st.fileList.sectionPresent)
    assert.deepEqual(st.fileList.declared.sort(), ['src/feature/a.ts', 'src/lib/strings.ts', 'tests/feature/a.test.ts'])
    assert.deepEqual(st.fileList.missing, [])
    assert.deepEqual(st.fileList.untested, [], '대응 테스트가 있는데 untested 로 셌다')
  })
})

test('굵은 `**[Review][Patch]**` 도 열린 finding 으로 센다(2026-08-30 실사고)', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const st = snap.stories.find((s) => s.key === K.openPatch)
    assert.equal(st.signals.openPatches, 2, '굵은 표기가 0으로 읽혔다')
    assert.equal(st.signals.openDecision, false)
  })
})

test('미완 Task 에서 👤 사람 게이트 줄은 빠진다(2026-08-31 실사고)', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const st = snap.stories.find((s) => s.key === K.openPatch)
    // Tasks 절 안: 미완 1 + (h3 Review Findings 안의 열린 지적 2) = 3. 👤 줄 1건은 제외돼야 한다.
    assert.equal(st.signals.unfinishedTasks, 3, '👤 줄을 셌거나 h3 구획 계산이 달라졌다')
  })
})

test('AC 식별자·Status 헤더·baseline_commit 을 읽는다', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const st = snap.stories.find((s) => s.key === K.ok)
    assert.deepEqual(st.acIds, ['AC-0', 'AC-1'])
    assert.equal(st.statusInFile, 'done')
    assert.equal(st.statusInSprint, 'done')
    assert.equal(st.baselineCommit, '0'.repeat(40))
    assert.ok(st.sections['Acceptance Criteria'] > 0)
    assert.equal(st.qaClaims.length, 1, '문서의 qa 주장(rank 4)을 따로 모아야 한다')
  })
})

test('`N-M-slug` 형태지만 스토리가 아닌 문서는 고아 문서로만 경고한다', () => {
  withFx({}, (fx) => {
    const on = readProject(fx.root)
    assert.deepEqual(on.orphanStoryDocs.map((o) => o.name), ['1-9-관리팀-질의서-2026-09-02'])
    assert.ok(!on.sprint.some((r) => r.key.startsWith('1-9')), '고아 문서를 스토리로 셌다')
  })
  withFx({ traps: { orphanDoc: false } }, (fx) => {
    assert.deepEqual(readProject(fx.root).orphanStoryDocs, [], '함정을 껐는데도 고아 문서가 나왔다')
  })
})

test('epics.md 의 마지막 스토리 절도 읽는다(종결 헤더가 없어 정규식이 빈 문자열을 주는 실물 함정)', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const only = snap.epicOnly.find((e) => e.id === '3-1')
    assert.ok(only, 'epics 에만 있는 3-1 을 못 찾았다')
    assert.match(only.section, /과거 기록을 옮긴다/)
    assert.ok(only.files.includes('supabase/migrations/20260201000000_import_legacy.sql'), '절 안의 신규 마이그레이션 경로를 못 읽었다')
  })
})

test('sectionOfStory 는 story-ledger 를 먼저 쓰고 마지막 절만 줄 번호로 보강한다', () => {
  const text = '## Epic 1: a\n\n### Story 1.1: 첫\n본문1\n\n### Story 1.2: 끝\n본문2\n'
  const stories = [{ id: '1-1', line: 3 }, { id: '1-2', line: 6 }]
  assert.match(sectionOfStory(text, '1-1', stories, []), /본문1/)
  assert.match(sectionOfStory(text, '1-2', stories, []), /본문2/)
  assert.equal(sectionOfStory(text, '9-9', stories, []), '')
})

// ═══════════════════════════════════════════════════════════════════════════
// C. 강등표 D1~D11 (설계 §2-1)
// ═══════════════════════════════════════════════════════════════════════════

test('evidenceRank — 실행(1) → 테스트(2) → 코드(3) → 스토리(4) → 계획(5)', () => {
  assert.equal(evidenceRank('gate'), 1)
  assert.equal(evidenceRank('test'), 2)
  assert.equal(evidenceRank('code'), 3)
  assert.equal(evidenceRank('story'), 4)
  assert.equal(evidenceRank('plan'), 5)
  assert.equal(evidenceRank('무엇이든'), 5, '모르는 종류는 가장 약한 증거로 본다')
})

test('스토리 5종 판정 — qa 미실행이면 done 도 verified-done 이 못 된다(D11)', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const d = diagnose(snap)
    assert.equal(verdictOf(d, K.ok), 'not-verified')
    assert.equal(verdictOf(d, K.noFileList), 'partial')
    assert.equal(verdictOf(d, K.openPatch), 'partial')
    assert.equal(verdictOf(d, K.openDecision), 'blocked')
    assert.equal(verdictOf(d, '3-1'), 'missing')
    assert.equal(d.counts.declaredDone, 2)
    assert.equal(d.counts.verifiedDone, 0, '문서 done 만으로 verified-done 이 나왔다')
    assert.ok(d.notVerified.some((n) => n.what === 'qa 게이트'))
  })
})

test('qa GREEN 을 주입하면 정상 스토리만 verified-done 으로 올라간다(D10)', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const d = diagnose(snap, { gates: { qa: { exit: 0, ms: 1234, source: 'gate' } } })
    assert.equal(verdictOf(d, K.ok), 'verified-done')
    assert.equal(d.counts.verifiedDone, 1)
    // 나머지 4건은 그대로 — 게이트 GREEN 이 열린 지적을 지우지 않는다
    assert.equal(verdictOf(d, K.noFileList), 'partial')
    assert.equal(verdictOf(d, K.openPatch), 'partial')
    assert.equal(verdictOf(d, K.openDecision), 'blocked')
    assert.equal(verdictOf(d, '3-1'), 'missing')
    const ok = d.stories.find((s) => s.key === K.ok)
    assert.equal(ok.confidence, 'high')
    assert.ok(ok.evidence.some((e) => e.rank === 1), 'rank 1 증거가 없는데 verified-done 이다')
  })
})

test('D1 — qa RED 가 그 스토리 File List 파일을 가리키면 defect(다른 강등보다 먼저)', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const gates = { qa: { exit: 1, ms: 10, log: 'FAIL src/feature/c.ts\nAssertionError', failure: { kind: 'test', signature: 'test:src/feature/c.ts' } } }
    const d = diagnose(snap, { gates })
    assert.equal(verdictOf(d, K.openPatch), 'defect', '열린 Patch(D4)보다 실행 증거(D1)가 먼저여야 한다')
    assert.equal(verdictOf(d, K.openDecision), 'blocked', 'qa 로그가 안 가리키는 스토리는 종전 판정')
    assert.ok(d.findings.some((f) => f.kind === 'gate-red' && f.tier === 2))
  })
})

test('D7 — Status 헤더와 sprint 상태가 어긋나면 partial + status-drift', () => {
  withFx({ traps: { statusDrift: true } }, (fx) => {
    const snap = readProject(fx.root)
    const st = snap.stories.find((s) => s.key === K.drift)
    assert.equal(st.statusInFile, 'review')
    assert.equal(st.statusInSprint, 'done')
    const d = diagnose(snap, { gates: { qa: { exit: 0 } } })
    const v = d.stories.find((s) => s.key === K.drift)
    assert.equal(v.verdict, 'partial')
    assert.ok(v.gaps.some((g) => g.code === 'status-drift'))
    assert.ok(d.findings.some((f) => f.kind === 'status-drift' && f.story === K.drift))
  })
})

// codex-review-r3 L1 — 상수표는 `gate > test > code > story > plan` 인데 실행 순서는 D2(code)가 D3(test)보다
// 앞이라, 둘 다 해당하면 **약한 code 증거로 조기 반환**했다. 이제 전부 모아 rank 최소값으로 판정한다.
test('L1 — File List 파일 부재(D2·code)와 테스트 부재(D3·test)가 동시면 더 센 test 증거로 판정한다', () => {
  withFreshFx({}, (fx) => {
    // 대응 테스트가 하나도 없는 실재 파일을 만든다(`tests/hooks/` 도 `/hooks/` 도 없다).
    fx.write('src/hooks/useThing.ts', 'export const useThing = (): number => 1\n')
    // `ok` 스토리(선언 done)의 File List 를 「실재하지 않는 파일 1 + 테스트 없는 실재 파일 1」로 바꾼다.
    const rel = `_bmad-output/implementation-artifacts/${K.ok}.md`
    const before = fx.read(rel)
    const after = before.replace(
      '- `src/feature/a.ts` · `tests/feature/a.test.ts`',
      '- `src/feature/사라진.ts` · `src/hooks/useThing.ts`',
    )
    assert.notEqual(after, before, '픽스처 File List 형식이 바뀌었다 — 테스트를 고칠 것')
    fx.write(rel, after)

    const snap = readProject(fx.root)
    const st = snap.stories.find((s) => s.key === K.ok)
    assert.deepEqual(st.fileList.missing, ['src/feature/사라진.ts'], 'D2 조건(파일 부재)이 서지 않았다')
    assert.deepEqual(st.fileList.untested, ['src/hooks/useThing.ts'], 'D3 조건(테스트 부재)이 서지 않았다')

    const r = classifyStoryCompletion(st, snap, {})
    assert.equal(r.verdict, 'partial')
    const deciding = r.evidence[r.evidence.length - 1]
    assert.equal(deciding.kind, 'test', `code(rank ${evidenceRank('code')}) 가 test(rank ${evidenceRank('test')}) 를 이겼다`)
    assert.equal(deciding.rank, evidenceRank('test'))
    assert.ok(r.gaps.some((g) => g.code === 'untested-files'), '판정 근거의 gap 이 실리지 않았다')
  })
})

test('classifyStoryCompletion 은 순수 — 같은 입력이면 같은 결과', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const st = snap.stories.find((s) => s.key === K.openPatch)
    const a = classifyStoryCompletion(st, snap, {})
    const b = classifyStoryCompletion(st, snap, {})
    assert.deepEqual(a, b)
    assert.equal(a.verdict, 'partial')
    assert.deepEqual(a.gaps, [{ code: 'open-patch', n: 2 }])
  })
})

test('D8 — sprint 키는 있는데 스토리 md 가 없으면 missing', () => {
  withFreshFx({}, (fx) => {
    // sprint 에 키를 하나 더 얹되 md 는 만들지 않는다(실물에서 흔한 backlog 상태)
    const p = '_bmad-output/implementation-artifacts/sprint-status.yaml'
    fx.write(p, fx.read(p) + '  2-9-없는-스토리: backlog  # 파일 없음\n')
    const snap = readProject(fx.root)
    const st = snap.stories.find((s) => s.key === '2-9-없는-스토리')
    assert.equal(st.exists, false)
    assert.equal(verdictOf(diagnose(snap, { gates: { qa: { exit: 0 } } }), '2-9-없는-스토리'), 'missing')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D. 휴리스틱 (설계 §2-2)
// ═══════════════════════════════════════════════════════════════════════════

test('lineContextAt — 문자열/주석/코드를 가른다', () => {
  assert.equal(lineContextAt("expect(x).toContain('it.only(')", 22), 'string')
  assert.equal(lineContextAt('// 금지: it.only( 를 쓰지 말 것', 8), 'comment')
  assert.equal(lineContextAt('  it.only(\'a\', () => {})', 2), 'code')
  assert.equal(lineContextAt("const a = ['it.only(', 'b']", 12), 'string')
})

test('`.only` — 문자열·주석·가드 테스트 안이면 needs-review, 실코드면 차단급', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const by = Object.fromEntries(snap.code.onlyHits.map((o) => [o.path, o]))
    assert.equal(by['tests/feature/b.test.ts'].kind, 'test-only')
    assert.equal(by['tests/feature/b.test.ts'].severity, 'high')
    assert.equal(by['tests/feature/lint-rule.test.ts'].kind, 'test-only-needs-review')
    assert.equal(by['tests/feature/lint-rule.test.ts'].context, 'string')
    assert.equal(by['src/lib/strings.ts'].kind, 'test-only-needs-review')
    assert.equal(by['tests/db/story-guard.test.ts'].kind, 'test-only-needs-review')
    assert.equal(by['tests/db/story-guard.test.ts'].guardFile, true)
  })
})

test('`.skip` — 위 3줄 안에 사유 주석이 있으면 낮은 등급, 없으면 medium', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const by = Object.fromEntries(snap.code.disabledTests.map((o) => [o.path, o]))
    assert.equal(by['tests/feature/skip-reason.test.ts'].kind, 'test-skip-justified')
    assert.equal(by['tests/feature/skip-bare.test.ts'].kind, 'test-skip')
    assert.equal(by['tests/feature/skip-bare.test.ts'].severity, 'medium')
  })
})

test('임시 코드 — 대문자 마커·한국어 표현만 세고 JSX placeholder 속성은 안 센다(실측 오탐 65건)', () => {
  const files = [
    { path: 'src/a.tsx', text: '<Input placeholder="검색어" />\n' },
    { path: 'src/b.ts', text: "const S = new Set(['skipped','todo'])\n" },
    { path: 'src/c.ts', text: '.dchip.todo{color:red}\n' },
    { path: 'src/d.ts', text: '// TODO: 나중에 고침\nconst x = 1\n' },
    { path: 'src/e.ts', text: 'const N = 30 // 30 은 임시값 — 실측 쌓이면 조정\n' },
    { path: 'src/f.ts', text: '// dummy 구현 — 화면 확인용\n' },
    { path: 'tests/g.test.ts', text: '// TODO: 여기는 테스트라 제외\n' },
  ]
  const hits = detectTempCode(files)
  assert.deepEqual(hits.map((h) => h.path).sort(), ['src/d.ts', 'src/e.ts', 'src/f.ts'])
  assert.ok(hits.every((h) => h.kind === 'temp-code'))
})

test('임시 코드가 비밀정보 경로에 있으면 tier 1 종류로 올라간다', () => {
  const hits = detectTempCode([{ path: 'secrets/loader.ts', text: '// TODO: 열쇠 회전 미구현\n' }])
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kind, 'temp-code-in-secret-path')
  assert.equal(hits[0].severity, 'high')
})

test('hasTestFor — basename 매칭과 tests/<도메인> 관례를 모두 인정한다', () => {
  assert.equal(hasTestFor('src/feature/a.ts', ['tests/other/a.test.ts']), true)
  assert.equal(hasTestFor('src/feature/a.ts', ['tests/feature/zzz.test.ts']), true)
  assert.equal(hasTestFor('src/feature/a.ts', ['tests/nope/zzz.test.ts']), false)
})

test('배포 차단 — DB 드리프트 대기 · preflight 부재 · 추적된 비밀 파일', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    assert.equal(snap.ledgers.dbDrift.pendingCount, 1)
    const f = detectDeployBlockers(snap)
    assert.ok(f.some((x) => x.kind === 'db-drift-pending' && x.count === 1))
    assert.ok(!f.some((x) => x.kind === 'deploy-preflight-missing'), 'preflight 가 실재하는데 없다고 했다')
    assert.ok(!f.some((x) => x.kind === 'secret-path-tracked'), '.env.example 은 공개 견본이라 위반이 아니다')
  })
  withFx({ traps: { dbDrift: false, trackedEnvProd: true } }, (fx) => {
    const snap = readProject(fx.root)
    const f = detectDeployBlockers(snap)
    assert.ok(!f.some((x) => x.kind === 'db-drift-pending'))
    assert.ok(f.some((x) => x.kind === 'secret-path-tracked' && x.path === '.env.production'), '추적된 .env.production 을 못 잡았다')
  })
})

test('문서 불일치 — 계획만/원장 밖/고아/파일 부재/File List 부재', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const f = detectDocMismatch(snap)
    const kinds = new Set(f.map((x) => x.kind))
    assert.ok(kinds.has('plan-only-story'), 'epics 에만 있는 3-1 을 못 잡았다')
    assert.ok(kinds.has('orphan-doc'))
    assert.ok(f.some((x) => x.kind === 'file-list-missing' && x.story === K.noFileList))
    assert.ok(!kinds.has('sprint-only-story'), '픽스처는 sprint 키가 전부 epics 에 있다')
  })
})

test('보안 — 코드에 박힌 열쇠는 findings, 미추적 .env 의 값은 정상으로 본다', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const paths = snap.security.valueHits.map((h) => h.path)
    assert.deepEqual(paths, ['src/lib/config.ts'], '코드에 박힌 열쇠만 위험으로 올라와야 한다')
    assert.ok(snap.security.envValueHits.length >= 2, '미추적 .env 의 값은 집계에 남긴다')
    const f = detectSecurityRisks(snap)
    assert.ok(f.some((x) => x.kind === 'secret-value' && x.path === 'src/lib/config.ts'))
  })
  withFx({ traps: { secretInCode: false } }, (fx) => {
    const snap = readProject(fx.root)
    assert.deepEqual(snap.security.valueHits, [])
    assert.deepEqual(detectSecurityRisks(snap), [])
  })
})

test('`service_role` 낱말은 비밀이 아니다 — 값 대입 형태만 잡는다(실측 오탐 119건)', () => {
  assert.equal(maskSecrets('// service_role 키는 EF 전용이다'), '// service_role 키는 EF 전용이다')
  assert.match(maskSecrets('SERVICE_ROLE_KEY=abcdefghijklmnopqrstuvwxyz'), /\*\*\*REDACTED\*\*\*/)
  assert.equal(maskSecrets('const k = "sk-abcdefghijklmnopqrst"'), 'const k = "sk-***REDACTED***"')
})

// 2026-09-02 R4 — 진단의 마스커는 **사본이 아니라 재수출**이다(공용 그물이 2조각 JWT 를 흡수한 뒤 덧그물을 지웠다).
// 여기서 함수 객체 동일성을 물어 두면, 누군가 진단 쪽에 다시 사본을 만드는 순간 RED 가 난다.
test('진단의 maskSecrets·deepRedact 는 providers/redact.mjs 재수출이다 — 사본이 갈릴 여지 0', () => {
  assert.equal(maskSecrets, sharedRedactSecrets, '진단이 자기 마스커 사본을 다시 만들었다')
  assert.equal(deepRedact, sharedDeepRedact, '진단이 자기 깊은 마스킹 사본을 다시 만들었다')
  // 재수출로 바꾼 뒤에도 종전 덧그물이 막던 것(서명부가 잘린 2조각 JWT)이 그대로 막혀야 한다
  const twoPart = 'SUPABASE_SERVICE_ROLE=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.bGVha2VkLXNlY3JldA'
  const masked = maskSecrets(twoPart)
  assert.ok(!masked.includes('bGVha2VkLXNlY3JldA'), masked)
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(masked), `헤더가 남아 JWT 형태가 보인다: ${masked}`)
})

// codex-review-r3 H1 — 진단이 쓰던 **자체 정규식**이 R2 에서 이미 고친 세 형식을 그대로 통과시켰다.
// 이제 마스커는 공용 하나뿐이므로, 그 세 형식이 다시 새면 여기서 RED 가 난다.
test('R2 회귀 3형식(JSON 키·Authorization 헤더·인용값)을 마스커가 놓치지 않는다', () => {
  for (const [label, raw, secret] of [
    ['JSON 키', '{"api_key":"JSONSECRET123456"}', 'JSONSECRET123456'],
    ['Authorization 헤더', 'Authorization: Bearer TOKENVALUE123456', 'TOKENVALUE123456'],
    ['인용값', 'PRIVATE_KEY="alpha beta gamma secret"', 'alpha beta gamma secret'],
  ]) {
    const masked = maskSecrets(raw)
    assert.ok(!masked.includes(secret), `${label} 의 값이 그대로 남았다: ${masked}`)
    assert.match(masked, /\*\*\*REDACTED\*\*\*/, `${label} 이 마스킹 표식조차 남기지 않았다`)
  }
})

test('시크릿 원문은 스냅숏·진단 어디에도 없다(전수 grep)', () => {
  withFx({ traps: { trackedEnvProd: true } }, (fx) => {
    const snap = readProject(fx.root)
    const d = diagnose(snap, { gates: { qa: { exit: 1, log: `boom ${FIXTURE_SECRETS.apiKey}` } } })
    const blob = JSON.stringify({ snap, d })
    for (const [name, value] of Object.entries(FIXTURE_SECRETS)) {
      assert.ok(!blob.includes(value), `시크릿 원문이 새어 나왔다: ${name}`)
    }
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(blob), '마스킹 안 된 sk- 토큰이 있다')
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(blob), '마스킹 안 된 JWT 가 있다')
  })
})

// codex-review-r3 H1 — `readProject()` 가 `scripts`·`manifests`·`engineState` 를 **깊은 마스킹 없이**
// 스냅숏에 실었다. package.json script 한 줄·state.json·과거 verification.json 에 토큰을 심어
// 스냅숏 / 진단 / 보고서(JSON·MD) 넷 어디에도 원문이 남지 않는지 실물로 문다.
test('package.json scripts·state.json·과거 verification.json 에 심은 토큰이 스냅숏·진단·보고서에 없다', () => {
  withFreshFx({ traps: { injectedSecrets: true } }, (fx) => {
    const snap = readProject(fx.root)
    const d = diagnose(snap, {})
    const model = buildReport({ diagnoses: [d] })
    const blob = [JSON.stringify(snap), JSON.stringify(d), JSON.stringify(renderReportJson(model)), renderReportMd(model)].join('\n')
    for (const [name, value] of Object.entries(FIXTURE_INJECTED_SECRETS)) {
      assert.ok(!blob.includes(value), `주입한 시크릿 원문이 새어 나왔다: ${name}`)
    }
    // 마스킹이 「가지를 통째로 지워서」 통과한 것이 아님을 확인한다 — 가지 자체는 살아 있어야 한다.
    assert.ok(snap.scripts?.all && Object.keys(snap.scripts.all).length > 0, 'scripts 가지가 사라졌다')
    assert.ok(snap.engineState, 'engineState 가지가 사라졌다')
    assert.ok(Object.keys(snap.manifests ?? {}).length > 0, 'manifests 가지가 사라졌다')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// E. 게이트 프로브 — 실행부
// ═══════════════════════════════════════════════════════════════════════════

test('runGateProbe 는 정확히 1회만 spawn 하고 결과 객체만 돌려준다(로그 파일 안 쓴다)', async () => {
  await withFx({}, async (fx) => {
    let calls = 0
    let seen = null
    const exec = (bin, args, opts) => { calls++; seen = { bin, args, opts }; return { status: 0, stdout: 'all green', stderr: '' } }
    const before = fx.porcelain()
    const r = await runGateProbe({ root: fx.root, name: 'qa', script: 'qa', exec, logDir: join(fx.root, 'logs') })
    assert.equal(calls, 1, '게이트를 한 번만 돌려야 한다')
    assert.equal(r.exit, 0)
    assert.equal(r.available, true)
    assert.equal(r.cmd, 'npm run qa')
    assert.equal(r.failure, null)
    assert.equal(seen.opts.shell, false, '셸을 켜면 문자열 결합 경로가 열린다')
    assert.ok(Array.isArray(seen.args), 'argv 는 배열로 분리한다')
    assert.ok(r.logPath.endsWith('gate-qa.log'))
    assert.ok(!existsSync(r.logPath), '이 모듈은 로그 파일을 쓰지 않는다(호출부 몫)')
    assert.equal(fx.porcelain(), before)
  })
})

test('runGateProbe — 스크립트가 없으면 n/a(GREEN 아님) · 실행 0회', async () => {
  let calls = 0
  const r = await runGateProbe({ root: '.', name: 'security', script: null, exec: () => { calls++; return { status: 0 } } })
  assert.equal(calls, 0)
  assert.equal(r.available, false)
  assert.equal(r.exit, null)
  assert.match(r.why, /n\/a/)
})

test('runGateProbe — RED 면 실패 종류·서명을 붙이고 로그를 마스킹한다', async () => {
  const exec = () => ({ status: 1, stdout: `src/a.ts(3,1): error TS2322: bad\nkey=${FIXTURE_SECRETS.apiKey}`, stderr: '' })
  const r = await runGateProbe({ root: '.', name: 'qa', script: 'qa', exec })
  assert.equal(r.exit, 1)
  assert.equal(r.failure.kind, 'typecheck')
  assert.ok(!r.log.includes(FIXTURE_SECRETS.apiKey), '게이트 로그에 시크릿이 남았다')
})

test('runGateProbe — 타임아웃은 exit 124 로 정직하게 기록한다', async () => {
  const exec = () => ({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' })
  const r = await runGateProbe({ root: '.', name: 'qa', script: 'qa', exec, timeoutMs: 5 })
  assert.equal(r.timedOut, true)
  assert.equal(r.exit, 124)
  // 트리 종료 실행기(spawnWithDeadline)는 `timedOut` 표식을 준다 — 그것만으로도 124 여야 한다
  const marked = await runGateProbe({ root: '.', name: 'qa', script: 'qa', timeoutMs: 5, exec: () => ({ status: null, signal: null, timedOut: true, stdout: '', stderr: '' }) })
  assert.equal(marked.timedOut, true)
  assert.equal(marked.exit, 124)
})

test('runGateProbe — 출력 과다(ENOBUFS)는 timeout 이 아니다 · exit 124 금지 · 사유 「출력 과다」', async () => {
  // spawnWithDeadline 은 maxBuffer 초과를 **spawnSync 와 같은 조합**으로 접는다 —
  // error.code='ENOBUFS' + signal='SIGTERM' + timedOut=false. `signal` 을 먼저 보는 분류기는
  // 이걸 exit 124(timeout)로 둔갑시켜, 운영자가 예산을 늘리며 헛발질하게 만든다
  // (2026-09-03 codex-review-r7 Low).
  const exec = () => ({ status: null, signal: 'SIGTERM', error: { code: 'ENOBUFS', message: 'stdout maxBuffer length exceeded' }, timedOut: false, stdout: 'x'.repeat(100), stderr: '' })
  const r = await runGateProbe({ root: '.', name: 'qa', script: 'qa', exec })
  assert.equal(r.timedOut, false, 'ENOBUFS 를 timeout 으로 적었다 — 사유가 뒤바뀌었다')
  assert.notEqual(r.exit, 124, 'exit 124(timeout)로 둔갑했다')
  assert.equal(r.exit, GATE_EXIT_OVERFLOW)
  assert.match(r.why, /출력 과다/, `사유에 「출력 과다」가 없다: ${r.why}`)

  // 진짜 timeout 은 종전대로 124 다(폴백을 죽이지 않았는지 같이 문다)
  const t = await runGateProbe({ root: '.', name: 'qa', script: 'qa', exec: () => ({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, timedOut: true, stdout: '', stderr: '' }) })
  assert.equal(t.exit, 124)
  assert.equal(t.timedOut, true)
  // 원인 없는 signal 도 종전대로 timeout 폴백(124)
  const sig = await runGateProbe({ root: '.', name: 'qa', script: 'qa', exec: () => ({ status: null, signal: 'SIGKILL', error: null, timedOut: false, stdout: '', stderr: '' }) })
  assert.equal(sig.exit, 124)
  assert.equal(sig.timedOut, true)
})

test('셸 메타문자를 가진 스크립트·값은 거부한다(정책 8)', () => {
  assert.throws(() => npmInvocation('qa; rm -rf /'), /셸 메타문자/)
  assert.throws(() => npmInvocation('qa && echo x'), /셸 메타문자/)
  assert.throws(() => assertNoShellMeta('model', 'opus`whoami`'), /셸 메타문자/)
  const inv = npmInvocation('qa')
  assert.ok(Array.isArray(inv.args) && inv.args.includes('qa'))
  assert.ok(!inv.args.some((a) => /\s&&|;/.test(a)))
})

test('게이트 총횟수 계약 — diagnose 는 스스로 게이트를 돌리지 않는다', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    let calls = 0
    const orig = process.env.PATH
    // diagnose 는 순수 함수라 spawn 자체가 없다 — 게이트를 주입해도 실행 0
    diagnose(snap, { gates: { qa: { exit: 0, exec: () => { calls++ } } } })
    assert.equal(calls, 0)
    assert.equal(process.env.PATH, orig)
  })
})

test('진단 스키마·지문 — 같은 스냅숏이면 지문이 같다(진전 판정의 열쇠)', () => {
  withFx({}, (fx) => {
    const snap = readProject(fx.root)
    const a = diagnose(snap, { gates: { qa: { exit: 0 } } })
    const b = diagnose(snap, { gates: { qa: { exit: 0 } } })
    assert.equal(a.schema, DIAGNOSIS_SCHEMA)
    assert.equal(a.fingerprint, b.fingerprint)
    assert.deepEqual(a.findings.map((f) => f.id), b.findings.map((f) => f.id))
    const c = diagnose(snap, { gates: { qa: { exit: 0 } }, prevDiagnosis: a })
    assert.equal(c.progress.delta, 0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// F. 실물(jng-os) 읽기 전용 스모크 — 있을 때만 돈다
// ═══════════════════════════════════════════════════════════════════════════

const JNG = process.env.JNG_OS_ROOT ?? 'C:/Projects/jng-os'
test('실물 BaroOS 저장소 읽기 전용 스모크(있을 때만)', { skip: existsSync(join(JNG, '_bmad-output')) ? false : 'jng-os 없음' }, () => {
  const st = () => spawnSync('git', ['-C', JNG, 'status', '--porcelain'], { encoding: 'utf8', shell: false }).stdout
  const before = st()
  const snap = readProject(JNG)
  assert.equal(st(), before, 'jng-os 워킹트리가 달라졌다 — 읽기 전용 위반')
  assert.equal(snap.stories.length, 84, 'sprint 스토리 행 수(2026-09-02 실측 84)')
  assert.equal(snap.stories.filter((s) => s.statusInSprint === 'done').length, 19, '선언 done 19건')
  assert.equal(snap.orphanStoryDocs.length, 1, '고아 문서 1건(11-5 관리팀 질의서)')
  assert.match(snap.orphanStoryDocs[0].name, /^11-5-관리팀-질의서/)
  assert.equal(snap.epicStories.length, 83, 'epics.md 스토리 절 83건')
  assert.equal(snap.code.srcCount, 230, 'src 코드 파일 230')
  assert.ok(snap.code.testCount >= 200, `테스트 파일 ${snap.code.testCount}`)
  assert.ok(snap.deploy.migrations >= 118, `마이그레이션 ${snap.deploy.migrations}`)
  assert.deepEqual(snap.scripts.chain, ['typecheck', 'lint', 'test'])
  assert.deepEqual(snap.scripts.missing, ['coverage', 'e2e', 'security', 'performance'])

  const d = diagnose(snap)
  assert.equal(d.counts.storiesTotal, 84)
  assert.equal(d.counts.verifiedDone, 0, 'qa 미실행이면 verified-done 은 0 이어야 한다')
  assert.ok(d.counts.findings[1] === 0, `tier 1 은 0 이어야 한다(실측): ${d.counts.findings[1]}`)
  const blob = JSON.stringify({ snap, d })
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(blob), '실물에서 마스킹 안 된 sk- 토큰이 나왔다')
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(blob), '실물에서 마스킹 안 된 JWT 가 나왔다')
  assert.equal(st(), before)
})
