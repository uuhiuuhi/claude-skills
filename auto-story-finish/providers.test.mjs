// providers 계층 테스트 — `node --test` · LLM 호출 0 · 실 CLI 호출 0(exec 주입).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DEFAULT_CLAUDE_LADDER, detectProviders, enforceCrossSpec, formatModelSpec, nextWorkerDown,
  parseModelSpec, providersLine, resolveWorkerSpec, shownSpec, specEquals,
} from './providers/index.mjs'
import {
  CODEX_MARKERS, CODEX_SLOT_STALE_MS, NO_DEFER_RE, buildCodexCommand, classifyCodexFailure, codexCwdAllowed, codexDevPrompt,
  codexFailureText, codexRepairPrompt, codexReviewPrompt, envFilesToHide, isSlotStale, parseCodexEvents, parseReviewJson,
  redactSecrets, renderReviewFindings, validateReviewRun,
} from './providers/codex.mjs'
import { buildClaudeCommand, runClaudeWorker } from './providers/claude.mjs'
import { openFindings, readStorySignals } from '../night-batch-ops/engine/story-ledger.mjs'

const here = dirname(fileURLToPath(import.meta.url))

describe('[providers] 모델 스펙 — 접두사 없으면 종전 그대로 claude 별칭(하위 호환)', () => {
  it('parse/format/shown', () => {
    assert.deepEqual(parseModelSpec('opus'), { provider: 'claude', model: 'opus' })
    assert.deepEqual(parseModelSpec(''), { provider: 'claude', model: '' })
    assert.deepEqual(parseModelSpec(undefined), { provider: 'claude', model: '' })
    assert.deepEqual(parseModelSpec('codex'), { provider: 'codex', model: '' })
    assert.deepEqual(parseModelSpec('codex:gpt-5.6-sol'), { provider: 'codex', model: 'gpt-5.6-sol' })
    assert.deepEqual(parseModelSpec('claude:fable'), { provider: 'claude', model: 'fable' })
    assert.deepEqual(parseModelSpec('CODEX'), { provider: 'codex', model: '' })
    assert.equal(formatModelSpec({ provider: 'claude', model: 'opus' }), 'opus') // claude 는 접두사 없이(종전 표기)
    assert.equal(formatModelSpec({ provider: 'claude', model: '' }), '')
    assert.equal(formatModelSpec({ provider: 'codex', model: '' }), 'codex')
    assert.equal(formatModelSpec('codex:x'), 'codex:x')
    assert.equal(shownSpec(''), 'cli-default') // 종전 로그 문구 보존
    assert.equal(shownSpec('codex'), 'codex:default')
    assert.ok(specEquals('opus', { provider: 'claude', model: 'opus' }))
    assert.ok(!specEquals('opus', 'codex'))
  })
})

describe('[providers] 능력 감지 — 요청된 프로바이더만 찌르고, 불가 사유를 사람 말로', () => {
  const mk = (table) => (bin, args) => table[`${bin} ${args.join(' ')}`] ?? { status: 127, stdout: '', stderr: 'not found' }
  it('Claude-only 요청이면 codex 는 감지조차 하지 않는다(새 프로세스 0)', () => {
    const calls = []
    const exec = (bin, args) => { calls.push(`${bin} ${args.join(' ')}`); return { status: 0, stdout: '2.1.250 (Claude Code)', stderr: '' } }
    const d = detectProviders({ want: ['claude'], exec, env: {} })
    assert.deepEqual(calls, ['claude --version'])
    assert.equal(d.claude.available, true)
    assert.equal(d.codex.wanted, false)
    assert.equal(d.codex.available, false)
  })
  it('codex 미설치 → available=false + 「Claude 전용으로 진행」 사유(배치는 서지 않는다)', () => {
    const d = detectProviders({ want: ['claude', 'codex'], exec: mk({ 'claude --version': { status: 0, stdout: '2.1.250', stderr: '' } }), env: {} })
    assert.equal(d.codex.available, false)
    assert.match(d.codex.reason, /미설치/)
    assert.match(providersLine(d), /claude=YES\(2\.1\.250\) codex=NO\(/)
  })
  it('codex 설치됐지만 미인증 → available=false + codex login 안내', () => {
    const d = detectProviders({ want: ['codex'], exec: mk({ 'codex --version': { status: 0, stdout: 'codex-cli 0.152.1', stderr: '' }, 'codex login status': { status: 1, stdout: 'Not logged in', stderr: '' } }), env: {} })
    assert.equal(d.codex.available, false)
    assert.equal(d.codex.loggedIn, false)
    assert.match(d.codex.reason, /codex login/)
  })
  it('codex 설치 + ChatGPT 로그인 → available=true(실측 문구 "Logged in using ChatGPT")', () => {
    const d = detectProviders({ want: ['codex'], exec: mk({ 'codex --version': { status: 0, stdout: 'codex-cli 0.152.1', stderr: '' }, 'codex login status': { status: 0, stdout: 'Logged in using ChatGPT', stderr: '' } }), env: {} })
    assert.equal(d.codex.available, true)
    assert.equal(d.codex.version, 'codex-cli 0.152.1')
    assert.match(providersLine(d), /codex=YES\(codex-cli 0\.152\.1\)/)
  })
  it('CLAUDE_BIN/CODEX_BIN env 를 존중한다(테스트 스텁 오버라이드 종전 규약)', () => {
    const calls = []
    const exec = (bin, args) => { calls.push(bin); return { status: 0, stdout: 'Logged in using ChatGPT', stderr: '' } }
    detectProviders({ want: ['claude', 'codex'], exec, env: { CLAUDE_BIN: 'C:/stub/claude.cmd', CODEX_BIN: 'C:/stub/codex.cmd' } })
    assert.deepEqual(calls, ['C:/stub/claude.cmd', 'C:/stub/codex.cmd', 'C:/stub/codex.cmd'])
  })
})

describe('[providers] 스펙 확정 — codex 불가면 claude 대체(dev 와 다른 모델)로 폴백 · 배치 계속', () => {
  it('codex 가용 + cwd 허용 → 그대로', () => {
    const r = resolveWorkerSpec({ spec: 'codex', availability: { codex: { available: true } } })
    assert.deepEqual(r, { spec: { provider: 'codex', model: '' }, fallback: false, why: '' })
  })
  it('codex 미설치 → claude 최상위, dev 가 그 모델이면 차순위', () => {
    const r = resolveWorkerSpec({ spec: 'codex', availability: { codex: { available: false, reason: '미설치' } }, avoid: 'fable' })
    assert.equal(r.fallback, true)
    assert.deepEqual(r.spec, { provider: 'claude', model: 'opus' })
    assert.match(r.why, /미설치/)
  })
  it('cwd 프라이버시 불허 → 폴백 + 사유', () => {
    const r = resolveWorkerSpec({ spec: 'codex', availability: { codex: { available: true } }, codexCwd: { ok: false, why: '본 트리' } })
    assert.equal(r.fallback, true)
    assert.match(r.why, /본 트리/)
  })
  it('claude 스펙은 손대지 않는다', () => {
    assert.equal(resolveWorkerSpec({ spec: 'opus', availability: {} }).fallback, false)
  })
})

describe('[providers] 한도 사다리 — 같은 프로바이더 차순위 → 다른 프로바이더(전환 1회 상한) → null', () => {
  const both = { claude: { available: true }, codex: { available: true } }
  it('claude 사다리는 종전 그대로(fable→opus→sonnet · avoid 건너뜀)', () => {
    assert.deepEqual(nextWorkerDown({ current: 'fable' }).next, { provider: 'claude', model: 'opus' })
    assert.deepEqual(nextWorkerDown({ current: 'fable', avoid: 'opus' }).next, { provider: 'claude', model: 'sonnet' })
    assert.equal(nextWorkerDown({ current: 'sonnet' }), null) // 기본 허용 = claude 뿐 → 전환 없음(하위 호환)
  })
  it('claude 사다리 소진 + codex 허용·가용 → codex 로 전환(switched=true)', () => {
    const r = nextWorkerDown({ current: 'sonnet', availability: both, allowedProviders: ['claude', 'codex'] })
    assert.deepEqual(r, { next: { provider: 'codex', model: '' }, switched: true })
  })
  it('전환 상한 소진(switchesUsed=1) → null — 무한 핑퐁 금지(08-29 설계 §5-3)', () => {
    assert.equal(nextWorkerDown({ current: 'sonnet', availability: both, allowedProviders: ['claude', 'codex'], switchesUsed: 1 }), null)
    assert.equal(nextWorkerDown({ current: 'codex', availability: both, allowedProviders: ['claude', 'codex'], switchesUsed: 1 }), null)
  })
  it('codex 한도 → claude 최상위(dev 모델 회피) · claude 불가면 null', () => {
    assert.deepEqual(nextWorkerDown({ current: 'codex', avoid: 'fable', availability: both, allowedProviders: ['claude', 'codex'] }), { next: { provider: 'claude', model: 'opus' }, switched: true })
    assert.equal(nextWorkerDown({ current: 'codex', availability: { claude: { available: false } }, allowedProviders: ['claude', 'codex'] }), null)
  })
  it('codex 가 허용 역할이 아니면 전환하지 않는다', () => {
    assert.equal(nextWorkerDown({ current: 'sonnet', availability: both, allowedProviders: ['claude'] }), null)
  })
  it('avoid 가 codex(dev=codex) 이면 review 는 codex 로 전환하지 않는다(교차검증)', () => {
    assert.equal(nextWorkerDown({ current: 'sonnet', avoid: 'codex', availability: both, allowedProviders: ['claude', 'codex'] }), null)
  })
})

describe('[providers] 교차검증 — 같은 프로바이더·같은 모델이면 review 를 바꾼다', () => {
  it('claude 동일 모델 → 사다리에서 dev 와 다른 첫 모델(종전 enforceCrossModel 과 동일)', () => {
    assert.deepEqual(enforceCrossSpec({ dev: 'opus', review: 'opus' }), { review: { provider: 'claude', model: 'fable' }, changed: true })
    assert.deepEqual(enforceCrossSpec({ dev: 'fable', review: 'fable' }).review, { provider: 'claude', model: 'opus' })
    assert.equal(enforceCrossSpec({ dev: 'opus', review: 'fable' }).changed, false)
    assert.equal(enforceCrossSpec({ dev: '', review: '' }).changed, false) // 둘 다 cli-default 는 종전처럼 손대지 않는다(새 프로세스=새 컨텍스트)
  })
  it('codex↔codex 는 claude 최상위로', () => {
    assert.deepEqual(enforceCrossSpec({ dev: 'codex', review: 'codex' }), { review: { provider: 'claude', model: DEFAULT_CLAUDE_LADDER[0] }, changed: true })
  })
  it('프로바이더가 다르면 이미 교차 — 손대지 않는다', () => {
    assert.equal(enforceCrossSpec({ dev: 'opus', review: 'codex' }).changed, false)
  })
})

describe('[codex] 명령 빌더 — 실측된 플래그만 · 역할이 샌드박스를 정한다 · 셸 문자열 결합 없음(#6)', () => {
  it('review = read-only + 스키마 + -o · dev = workspace-write + 네트워크 · -a 플래그는 절대 없음', () => {
    const r = buildCodexCommand({ role: 'review', cwd: 'C:/wt', schemaPath: 'C:/s.json', outFile: 'C:/o.txt' })
    assert.equal(r.sandbox, 'read-only')
    assert.equal(r.file, 'codex')
    assert.deepEqual(r.argv, ['exec', '-C', 'C:/wt', '-s', 'read-only', '--json', '--ephemeral', '--output-schema', 'C:/s.json', '-o', 'C:/o.txt', '-'])
    const d = buildCodexCommand({ role: 'dev', cwd: 'C:/wt', model: 'gpt-5.6-sol', networkAccess: true })
    assert.equal(d.sandbox, 'workspace-write')
    assert.deepEqual(d.argv, ['exec', '-C', 'C:/wt', '-s', 'workspace-write', '--json', '--ephemeral', '-m', 'gpt-5.6-sol', '-c', 'sandbox_workspace_write.network_access=true', '-'])
    // 네트워크는 **기본 닫힘**(F4) — 열면 workspace-write 세션이 push·외부 전송을 할 수 있다
    assert.ok(!buildCodexCommand({ role: 'dev', cwd: 'C:/wt' }).argv.some((a) => a.includes('network_access')))
    assert.equal(d.argv.at(-1), '-', 'stdin 프롬프트')
    assert.ok(!d.argv.includes('-a') && !d.argv.includes('--ask-for-approval'), 'codex exec 는 -a 를 받지 않는다(실측 unexpected argument)')
    assert.ok(!d.argv.some((a) => a.includes('danger-full-access')))
  })
  it('networkAccess=false 면 네트워크 플래그 없음 · repair 도 workspace-write · skipGitCheck 옵트인', () => {
    const d = buildCodexCommand({ role: 'repair', cwd: 'C:/wt', networkAccess: false })
    assert.equal(d.sandbox, 'workspace-write')
    assert.ok(!d.argv.some((a) => a.includes('network_access')))
    assert.ok(!d.argv.includes('--skip-git-repo-check'))
    assert.ok(buildCodexCommand({ role: 'dev', cwd: 'C:/wt', skipGitCheck: true }).argv.includes('--skip-git-repo-check'))
  })
  it('CODEX_BIN 대체 · 공백 경로는 argv 원소 하나로 온전히 · 따옴표가 든 경로는 거부(#6)', () => {
    const c = buildCodexCommand({ bin: 'C:/Program Files/codex/codex.cmd', role: 'review', cwd: 'C:/tmp dir with space/wt' })
    assert.equal(c.file, 'C:/Program Files/codex/codex.cmd')
    assert.equal(c.argv[2], 'C:/tmp dir with space/wt')
    assert.throws(() => buildCodexCommand({ role: 'review', cwd: 'C:/a "b"' }), /SPAWN-SAFE/)
  })
})

describe('[codex] JSONL 이벤트 파서 — 실측 이벤트 형태(2026-09-02 프로브)', () => {
  const probe = [
    '{"type":"thread.started","thread_id":"01a061b3"}',
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","exit_code":0}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"file_change"}}',
    'garbage line',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"verdict\\":\\"pass\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":14710,"cached_input_tokens":0,"output_tokens":7}}',
  ].join('\n')
  it('마지막 agent_message · usage · 명령/파일 변경 수 · 비JSON 줄 무시', () => {
    const e = parseCodexEvents(probe)
    assert.equal(e.threadId, '01a061b3')
    assert.equal(e.lastMessage, '{"verdict":"pass"}')
    assert.equal(e.usage.input_tokens, 14710)
    assert.equal(e.commands, 1)
    assert.equal(e.fileChanges, 1)
    assert.equal(e.failed, false)
    assert.equal(e.parsed, 7)
  })
  it('turn.failed / error 이벤트는 errors 에 모이고 failed=true', () => {
    const e = parseCodexEvents('{"type":"error","message":"stream disconnected"}\n{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit"}}')
    assert.equal(e.failed, true)
    assert.deepEqual(e.errors, ['stream disconnected', "You've hit your usage limit"])
  })
  it('빈 입력은 빈 결과(예외 없음)', () => {
    assert.equal(parseCodexEvents('').parsed, 0)
    assert.equal(parseCodexEvents(null).lastMessage, '')
  })
})

describe('[codex] 실패 분류 — auth > spend > limit > other (엔진 classifyFailure 와 같은 규율)', () => {
  it('바이너리 실측 문구', () => {
    assert.equal(classifyCodexFailure('Error: Not logged in'), 'auth')
    assert.equal(classifyCodexFailure('ChatGPT account ID not available, please re-run codex login'), 'auth')
    assert.equal(classifyCodexFailure("You've hit your usage limit. Upgrade to Pro"), 'limit')
    assert.equal(classifyCodexFailure("You've reached your usage limit. Increase your limits to continue using codex."), 'limit')
    assert.equal(classifyCodexFailure('stream disconnected before completion: rate limit exceeded'), 'limit')
    assert.equal(classifyCodexFailure('Quota exceeded'), 'limit')
    assert.equal(classifyCodexFailure('ECONNRESET'), 'other')
  })
  it('Plus 사용량 한도 안내의 "purchase more credits" 는 spend 가 아니다(5시간 창이 지나면 풀린다) · 조직 크레딧 소진만 spend', () => {
    assert.equal(classifyCodexFailure("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits"), 'limit')
    assert.equal(classifyCodexFailure('Your workspace is out of credits. Ask your workspace admin'), 'spend')
  })
  it('auth 가 limit 보다 우선', () => {
    assert.equal(classifyCodexFailure('401 unauthorized · usage limit'), 'auth')
  })
})

describe('[codex] cwd 프라이버시 가드 — 배치 워크트리에서만(👤 2026-08-29 설계 §2-1)', () => {
  it('marker · linked worktree · env 명시 중 하나면 허용, 아니면 사유와 함께 거부', () => {
    assert.equal(codexCwdAllowed({}).ok, false)
    assert.match(codexCwdAllowed({}).why, /본 트리/)
    assert.equal(codexCwdAllowed({ markerPresent: true }).ok, true)
    assert.equal(codexCwdAllowed({ gitIsFile: true }).ok, true)
    assert.equal(codexCwdAllowed({ envOverride: '1' }).ok, true)
    assert.equal(codexCwdAllowed({ envOverride: 'yes' }).ok, false)
    assert.ok(CODEX_MARKERS.includes('.auto-batch-worktree') && CODEX_MARKERS.includes('.baroos-auto-worktree'))
  })
})

describe('[codex] 리뷰 결과 렌더 — 원장 형식 계약(story-ledger 파서 · 래칫 · bmad-code-review step-04)', () => {
  const result = {
    summary: '요약 문장.', verdict: 'findings',
    acVerdicts: [{ ac: 'AC-1', status: 'pass', evidence: 't1' }, { ac: 'AC-2', status: 'fail', evidence: 'src/a.ts:9' }],
    findings: [
      { lens: 'blind', severity: 'high', kind: 'patch', title: '경계 누락', file: 'src/a.ts', line: 10, detail: '첫 줄\n둘째 줄', evidence: 'if (x)', preExisting: false },
      { lens: 'acceptance', severity: 'medium', kind: 'decision', title: '정책 갈림', file: '', line: 0, detail: '무엇을 택할지', evidence: '', preExisting: false },
      { lens: 'edge', severity: 'low', kind: 'patch', title: '원래 있던 것', file: 'src/b.ts', line: 0, detail: '기존', evidence: '', preExisting: true },
      { lens: 'blind', severity: 'low', kind: 'optional', title: '취향', file: '', line: 0, detail: '스타일', evidence: '', preExisting: false },
    ],
  }
  const r = renderReviewFindings({ story: '2-3', model: 'gpt-5.6-sol', date: '2026-09-02', targetRef: 'abc..HEAD', round: 7, result })
  it('열린 patch/decision 은 `- [ ]` · defer/optional 은 `- [x]` + ⏭️(래칫 통과) · 한 줄로 접힘', () => {
    const lines = r.block.split('\n')
    assert.ok(lines[0].startsWith('### Review Findings — Codex 교차리뷰 (2026-09-02 · 7차 · codex exec · gpt-5.6-sol)'))
    assert.ok(lines.some((l) => l === '- [ ] [Review][Decision] 정책 갈림 — 무엇을 택할지'))
    assert.ok(lines.some((l) => l === '- [ ] [Review][Patch][high] 경계 누락 [src/a.ts:10] — 첫 줄 둘째 줄 (근거: if (x))'))
    assert.ok(lines.some((l) => l.startsWith('- [x] [Review][Defer] 원래 있던 것 [src/b.ts] — ⏭️ deferred, pre-existing')))
    assert.ok(lines.some((l) => l.startsWith('- [x] [Review][Optional] 취향 — ⏭️ optional')))
    assert.ok(lines.some((l) => l.includes('AC 판정: pass 1 · fail 1 · unknown 0') && l.includes('AC-2=fail')))
    for (const l of lines) if (/^- \[x\] \[Review\]\[(Patch|Decision)/.test(l)) assert.match(l, /~~|✅|⏭️|❌/, '닫힌 [x] 는 닫힘 기호 필수(story-ledger-guard)')
  })
  it('preExisting 은 kind 와 무관하게 defer 로 분리(이번 스토리의 findings 가 아니다) · 집계·상태 전이', () => {
    assert.deepEqual(r.counts, { decision: 1, patch: 1, defer: 1, optional: 1, high: 1, promoted: 0 })
    assert.equal(r.newStatus, 'in-progress')
    assert.equal(r.deferred.length, 1)
    assert.deepEqual(r.decisions, ['정책 갈림 — 무엇을 택할지'])
  })
  it('이월 금지 5범주(보안·권한/개인정보/데이터 손실/결제·청구/발송·배포)는 defer/optional 로 내도 patch 로 승격한다(👤 P0-④)', () => {
    const res = { summary: '', verdict: 'findings', acVerdicts: [], findings: [
      { lens: 'blind', severity: 'low', kind: 'defer', title: 'RLS 정책이 누락된 테이블', file: 'supabase/x.sql', line: 3, detail: 'policy 없음', evidence: '', preExisting: true },
      { lens: 'blind', severity: 'low', kind: 'optional', title: '연락처 마스킹 없이 로그 출력', file: 'src/a.ts', line: 1, detail: '개인정보', evidence: '', preExisting: false },
      { lens: 'blind', severity: 'low', kind: 'optional', title: '변수명 취향', file: '', line: 0, detail: '스타일', evidence: '', preExisting: false },
    ] }
    const z = renderReviewFindings({ story: 's', date: 'd', result: res })
    assert.equal(z.counts.patch, 2)
    assert.equal(z.counts.promoted, 2)
    assert.equal(z.counts.optional, 1)
    assert.equal(z.newStatus, 'in-progress')
    assert.ok(z.block.split('\n').filter((l) => l.includes('(이월 금지 5범주 — 엔진 승격)')).length === 2)
    assert.ok(/보안|권한|개인정보|손실|결제|청구|발송|배포/.test(NO_DEFER_RE.source))
  })
  it('story-ledger 파서가 그대로 센다 — 열린 Patch 1 · Decision 1 · Tasks 절 안이면 미완 일감 2', () => {
    assert.equal(openFindings(r.block, 'Patch'), 1)
    assert.equal(openFindings(r.block, 'Decision'), 1)
    const md = '# S\nStatus: review\n\n## Tasks / Subtasks\n\n- [x] T1\n\n' + r.block + '\n\n## Dev Notes\n'
    const s = readStorySignals(md)
    assert.equal(s.openPatches, 1)
    assert.equal(s.openDecision, true)
    assert.equal(s.unfinishedTasks, 2)
  })
  it('0건이면 체크박스 없는 라운드 기록(NO-OP 방지)과 done', () => {
    const z = renderReviewFindings({ story: 's', date: 'd', result: { summary: '깨끗', verdict: 'clean', acVerdicts: [], findings: [] } })
    assert.ok(z.block.includes('- ✅ Clean review — 발견 0건'))
    assert.equal(z.newStatus, 'done')
    assert.equal(openFindings(z.block, 'Patch'), 0)
  })
})

describe('[codex] 구조화 응답 파서 — 스키마 강제 JSON · 코드펜스 변형 허용 · 불량은 null', () => {
  it('parseReviewJson', () => {
    assert.equal(parseReviewJson('{"findings":[],"summary":"x"}').summary, 'x')
    assert.equal(parseReviewJson('```json\n{"findings":[]}\n```').findings.length, 0)
    assert.equal(parseReviewJson('prefix {"findings":[{"a":1}]} suffix').findings.length, 1)
    assert.equal(parseReviewJson('DONE'), null)
    assert.equal(parseReviewJson('{"verdict":"pass"}'), null) // findings 배열이 없으면 불량
  })
})

describe('[codex] 자립형 프롬프트 — 슬래시 스킬 없이 계약을 담는다', () => {
  it('review: 3렌즈 · 정확성/요구사항만 patch · pre-existing 분리 · 이월 금지 5범주 · 읽기 전용 · JSON 만', () => {
    const p = codexReviewPrompt({ story: '2-3', storyFile: '_bmad-output/implementation-artifacts/2-3.md', diffFile: '_bmad-output/implementation-artifacts/auto-pipeline-logs/x-diff.txt', changedFiles: ['src/a.ts'], targetRef: 'HEAD' })
    for (const must of ['Blind Hunter', 'Edge Case Hunter', 'Acceptance Auditor', '정확성', 'preExisting', '이월 금지 5범주', 'git commit', '읽기 전용', 'JSON 스키마', 'src/a.ts', 'CLAUDE.md', 'AGENTS.md']) assert.ok(p.includes(must), `누락: ${must}`)
    assert.ok(!p.includes('/bmad-'), '슬래시 스킬 명령은 Codex 에 무의미')
  })
  it('dev: 미완 Task 순서 · TDD · 허용 절만 · Status→review · sprint-status · 꼼수 금지 · 커밋 금지', () => {
    const p = codexDevPrompt({ story: '2-3', storyFile: 's.md', sprintStatusFile: 'sprint-status.yaml', qaCmd: 'npm run qa', guard: 'GUARD-X' })
    for (const must of ['미완([ ])', 'RED', 'npm run qa', 'baseline_commit', '### File List', '`Status:` 줄을 review', 'sprint-status.yaml', '.only', 'git commit', 'GUARD-X', '무인 기본값 결정', '✅ 해소', '.env*', '게이트 설정']) assert.ok(p.includes(must), `누락: ${must}`)
  })
  it('repair: 실패 분류·서명·발췌·무결성 결과·수리 기록 의무', () => {
    const p = codexRepairPrompt({ story: 's', storyFile: 's.md', attempt: 2, maxAttempts: 5, failure: { kind: 'lint', signature: 'lint:x', excerpt: 'E1' }, integrity: [{ level: 'block', rule: 'test-only', file: 't.ts', line: 3, detail: 'd' }] })
    for (const must of ['자동 수리 2/5', 'lint', 'lint:x', 'E1', '[block] test-only', '테스트 수정 사유', '자동 수리 2차']) assert.ok(p.includes(must), `누락: ${must}`)
  })
  it('리뷰 스키마 파일은 strict 형(additionalProperties=false · 전 필드 required)', () => {
    const schema = JSON.parse(readFileSync(join(here, 'providers', 'codex-review.schema.json'), 'utf8'))
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, ['summary', 'verdict', 'acVerdicts', 'findings'])
    const f = schema.properties.findings.items
    assert.equal(f.additionalProperties, false)
    assert.deepEqual(f.required, ['lens', 'severity', 'kind', 'title', 'file', 'line', 'detail', 'evidence', 'preExisting'])
  })
})

describe('[codex] 방어 부품 — 실패 텍스트 선별 · 시크릿 가리기 · .env 격리 대상 · 슬롯 판정 · 리뷰 신뢰 판정', () => {
  it('codexFailureText: 오류 이벤트+stderr 우선 · 둘 다 비면 stdout 꼬리(도구 출력 속 401 오판 방지 · F21)', () => {
    const res = { events: { errors: ["You've hit your usage limit"] }, stderr: '', stdout: '{"item":{"text":"HTTP 401 in fixture"}}' }
    assert.equal(classifyCodexFailure(codexFailureText(res)), 'limit')
    const only = { events: { errors: [] }, stderr: '', stdout: 'x'.repeat(5000) + ' rate limit exceeded' }
    assert.equal(classifyCodexFailure(codexFailureText(only)), 'limit')
    assert.equal(codexFailureText({ events: { errors: [] }, stderr: 'Not logged in', stdout: '401' }).includes('401'), false)
  })
  it('redactSecrets: KEY=값·sb_secret_·JWT·sk-·AKIA 값을 가리고 이름은 남긴다', () => {
    const t = 'SUPABASE_SERVICE_ROLE_KEY=sb_secret_ABCDEFGHIJKLMNOP\nQA_ADMIN_PASSWORD: "hunter2xyz"\ntoken eyJabcdefghijk.abcdefghijklmn.abcdefg\nsk-ABCDEFGHIJKLMNOPQRSTUV\nAKIAABCDEFGHIJKLMNOP\nplain=ok'
    const r = redactSecrets(t)
    assert.ok(!r.includes('ABCDEFGHIJKLMNOP'), r)
    assert.ok(!r.includes('hunter2xyz'))
    assert.ok(!r.includes('abcdefghijklmn'))
    assert.ok(r.includes('SUPABASE_SERVICE_ROLE_KEY=***REDACTED***'))
    assert.ok(r.includes('plain=ok'))
  })
  it('envFilesToHide: .env·.env.local·.env.production 은 격리 · .env.example 은 제외', () => {
    assert.deepEqual(envFilesToHide(['.env', '.env.local', '.env.production', '.env.example', 'env.txt', 'package.json']), ['.env', '.env.local', '.env.production'])
  })
  it('isSlotStale: ESRCH 사망은 즉시 stale · 살아 있으면 심박과 무관하게 유효 · pid 없으면 심박 3h 초과가 기준', () => {
    const dead = () => false, alive = () => true, unknown = () => 'unknown'
    assert.equal(isSlotStale({ pid: 111, killProbe: dead }), true)
    assert.equal(isSlotStale({ pid: 111, hb: new Date(0).toISOString(), killProbe: alive }), false)
    assert.equal(isSlotStale({ pid: 111, hb: new Date().toISOString(), killProbe: unknown }), false)
    assert.equal(isSlotStale({ pid: 111, hb: new Date(Date.now() - CODEX_SLOT_STALE_MS - 1).toISOString(), killProbe: unknown }), true)
    assert.equal(isSlotStale({ pid: null, hb: null }), true, '손상된 lock 은 stale')
    assert.equal(classifyCodexFailure('codex slot busy — concurrent codex workers reached max'), 'limit')
  })
  it('validateReviewRun: JSON 없음·빈 diff·「명령 0 + clean」은 무효 · 명령 0 + findings 는 경고', () => {
    assert.equal(validateReviewRun({ json: null }).ok, false)
    assert.equal(validateReviewRun({ json: { findings: [] }, events: { commands: 3 }, diffEmpty: true }).ok, false)
    const clean0 = validateReviewRun({ json: { findings: [] }, events: { commands: 0 } })
    assert.equal(clean0.ok, false)
    assert.match(clean0.why, /명령을 하나도/)
    const warn = validateReviewRun({ json: { findings: [{}] }, events: { commands: 0 } })
    assert.equal(warn.ok, true)
    assert.equal(warn.warnings.length, 1)
    // storyFile 미제공(호출부 미배선)은 종전 판정 + 경고 — 조용히 통과시키지 않는다
    const legacy = validateReviewRun({ json: { findings: [] }, events: { commands: 5 } })
    assert.equal(legacy.ok, true)
    assert.match(legacy.warnings.join(' '), /열람 증거 판정 재료/)
  })
})

describe('[claude] 어댑터 — 인자 계약은 종전 그대로 · 우회 플래그 없음 · 셸 결합 없음(#6)', () => {
  it('buildClaudeCommand 는 file+argv 를 분리해 돌려준다(로그용 display 는 종전 한 줄 표기)', () => {
    const c = buildClaudeCommand({ model: 'opus', settingsPath: 'C:/p.json' })
    assert.equal(c.file, 'claude')
    assert.deepEqual(c.argv, ['-p', '--model', 'opus', '--permission-mode', 'acceptEdits', '--settings', 'C:/p.json'])
    assert.equal(c.display, 'claude -p --model opus --permission-mode acceptEdits --settings "C:/p.json"')
    assert.deepEqual(buildClaudeCommand({}).argv, ['-p', '--permission-mode', 'acceptEdits'])
    assert.ok(!buildClaudeCommand({ model: 'x' }).argv.join(' ').includes('bypass'))
  })
  it('runClaudeWorker 는 shell:false 로 file+argv 를 넘기고 ETIMEDOUT 을 timedOut 으로 매핑', () => {
    let seen = null
    const spawn = (file, argv, opts) => { seen = { file, argv, opts }; return { status: null, stdout: 'partial', stderr: '', error: { code: 'ETIMEDOUT' } } }
    const r = runClaudeWorker({ cmd: buildClaudeCommand({ model: 'opus' }), prompt: 'P', timeoutMs: 123, spawn })
    assert.equal(seen.opts.shell, false)
    assert.deepEqual(seen.argv, ['-p', '--model', 'opus', '--permission-mode', 'acceptEdits'])
    assert.equal(seen.opts.input, 'P')
    assert.equal(seen.opts.timeout, 123)
    assert.equal(r.code, 1)
    assert.equal(r.timedOut, true)
    assert.equal(r.provider, 'claude')
  })
  it('env 를 주면 그대로 자식에 전달한다(git-guard shim PATH 배선 지점)', () => {
    let seen = null
    const spawn = (file, argv, opts) => { seen = opts; return { status: 0, stdout: '', stderr: '' } }
    runClaudeWorker({ cmd: buildClaudeCommand({}), prompt: 'P', timeoutMs: 1, env: { PATH: '/shim:/usr/bin' }, spawn })
    assert.deepEqual(seen.env, { PATH: '/shim:/usr/bin' })
  })
})
