// 엔진 소스 앵커 가드 — failure-classify.test.mjs 와 같은 방식(소스 문자열을 문다 · 의존성 0).
//
// 왜: 다중 프로바이더 확장(2026-09-02)이 종전 가드를 「구조가 복잡하다」는 이유로 지우거나, 현황판(dev-status)이
// 읽는 로그 줄 형식을 바꾸는 것을 기계가 막는다. 문서에만 있는 규정은 반복된다(반복 원장 교훈).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'auto-story-pipeline.mjs'), 'utf8').replace(/\r\n/g, '\n')
const has = (s) => src.includes(s)

describe('[engine-guards] 현황판이 읽는 로그 줄 형식은 그대로다(dev-status scan.mjs reviewRuns/parseBatch)', () => {
  it('`→ [story] <stage> (model=…, perm=…)` 템플릿과 `   exit=<code>` 줄이 그대로 있다', () => {
    assert.ok(has('note(`→ [${story}] ${w.stageLabel} (model=${shownModel(model)}, perm=${w.perm})`)'), '스테이지 시작 줄 템플릿')
    assert.ok(has('note(`   exit=${code}${timedOut ? " (TIMEOUT)" : ""} log=${logFile}`)'), 'exit 줄 템플릿')
    assert.ok(has('note(`→ [${story}] qa-gate: ${qaCmd}`)'))
    assert.ok(has('note(`   qa exit=${res.status} log=${logFile}`)'))
  })
  it('새 태그 줄은 `→` 로 시작하지 않는다(현황판 파서의 pending 을 리셋하지 않는다)', () => {
    const tagged = src.match(/note\(`\[\$\{story\}\]\[[^`]*`\)/g) ?? []
    assert.ok(tagged.length >= 5, '태그 줄이 있어야 한다')
    for (const t of tagged) assert.ok(!t.includes('→'), t)
  })
  it('종전 STOP 문구가 보존된다(브리핑·현황판이 exit 코드와 함께 읽는다)', () => {
    assert.ok(has('qa RED(exit=${exitCode}). 거짓 PASS 차단 → 배치 중단. (사람 개입 필요)'))
    assert.ok(has('NO-OP STOP — [${story}] ${stage}: exit=0 이지만 스토리 산출물이 갱신되지 않음'))
    assert.ok(has('COMMIT GUARD STOP — --commit 은 시작 시점 작업 트리가 clean 이어야 한다'))
  })
})

describe('[engine-guards] 하드코딩 가드레일 보존', () => {
  it('권한 모드 acceptEdits 고정 · 우회 플래그 없음 · nested deny 설정 경로 해석 유지', () => {
    assert.ok(has('const permMode = "acceptEdits";'))
    assert.ok(!/bypassPermissions|dangerously-skip-permissions|--dangerously/.test(src.replace(/\/\/[^\n]*/g, '')), '주석 밖에 우회 플래그가 있으면 안 된다')
    assert.ok(has('[resolve(".claude/pipeline-settings.json"), join(homedir(), ".claude", "pipeline-settings.json")]'))
  })
  it('브랜치·푸시 가드(auto/ 접두사) · 커밋 화이트리스트·금지 경로·시크릿 스캔이 그대로 있다', () => {
    assert.ok(has('if (doPush && !/^auto\\//.test(branchName))'))
    assert.ok(has('if (branchName && !/^auto\\//.test(branchName))'))
    assert.ok(has('const DENY_PATH_RE ='))
    assert.ok(has('const SECRET_RES = ['))
    assert.ok(has('SECRET STOP — [${story}] 스테이징 diff 에 시크릿 패턴'))
  })
  it('허수 완주 방지(U1-b) · create 는 --force 로도 재생성 불가 · state.json skip 판정이 그대로 있다', () => {
    assert.ok(has('function hasNoCompletedWork(story)'))
    assert.ok(has('create skip — 스토리 파일이 이미 존재 (--force 무시'))
    assert.ok(has('skip — state.json 완료 기록 (재실행=--force)'))
  })
  it('dry-run 은 워커를 실행하지 않는다 — `if (dryRun)` 반환이 `w.run()` 보다 앞에 있다', () => {
    const fn = src.slice(src.indexOf('function runClaude(stage, story, variant = null)'))
    const dry = fn.indexOf('if (dryRun) {')
    const run = fn.indexOf('res = w.run(')
    assert.ok(dry > 0 && run > dry, 'dry-run 반환이 실행보다 먼저여야 한다')
    assert.ok(fn.slice(dry, run).includes('return "ok";'))
  })
})

describe('[engine-guards] v3 다중 프로바이더 규율', () => {
  it('Codex 네트워크 기본 닫힘 · 동시 실행 상한 기본 1 · 프로바이더 전환은 스토리당 1회', () => {
    assert.ok(has('const codexNetwork = opt("codex-network", "off") === "on";'))
    assert.ok(has('const codexMax = Math.max(1, Number(opt("codex-max", "1")) || 1);'))
    assert.ok(has('switchesUsed[story] ?? 0, maxSwitches: 1'))
  })
  it('Codex 실패는 Claude 프로브로 복구를 판정하지 않는다(pollable=false) · spend 대기 제외 앵커 유지', () => {
    assert.ok(has('function handleFailure(kind, context, logFile, pollable = true)'))
    assert.ok(/pollable && kind !== "spend" && waitForRecovery/.test(src))
    assert.ok(has('failedProvider !== "codex");'))
  })
  it('워커 커밋 가드 — HEAD·브랜치·stash 변동 시 exit 6 · 수리 워커는 트리 지문으로 사후조건', () => {
    assert.ok(has('if (w.guardCommit && headBefore) {'))
    assert.ok(has('워커의 직접 commit/branch/stash 는 금지'))
    assert.ok(has('(w.role === "repair" && treeFingerprint() !== fpBefore)'))
  })
  it('리뷰 diff 는 env·키·시크릿 파일을 제외하고 본문을 가린다 — pathspec 제외 + 섹션 제거 + 최종 재마스킹 3중(#1)', () => {
    // 종전 REVIEW_EXCLUDE_RE(엔진 사본 정규식)는 providers/codex.mjs 의 isSensitivePath 하나로 합쳐졌다.
    // 규율은 더 강해졌다 — ① 만들 때 pathspec 제외 ② 만들어진 diff 에서 파일 섹션 제거 ③ 최종 확정본 재마스킹.
    assert.ok(has('function trackedDiffExcludingSensitive(names, ref)'), 'pathspec 제외 단계')
    assert.ok(has('names.filter(isSensitivePath).map((f) => `:(exclude,top)${f}`)'))
    assert.ok(has('.filter((f) => !f.includes("auto-pipeline-logs/") && !isSensitivePath(f));'), '미추적 파일 민감 경로 제외')
    assert.ok(has('files = names.filter((f) => !isSensitivePath(f));'), 'baseline 폴백도 같은 제외')
    assert.ok(has('diff = redactSecrets(stripSensitiveFileSections(diff));'))
    assert.ok(has('diff = redactSecrets(diff); // 최종 확정본에 한 번 더'), '자른 뒤에도 원문이 남지 않는다')
    assert.ok(!/REVIEW_EXCLUDE_RE/.test(src), '민감 경로 판정은 한 곳(isSensitivePath)만 남긴다')
  })
  it('로그 마스킹은 프로바이더를 가리지 않는다(정책 2) — qa·워커·조건부 게이트 전부 scrubLog 경유', () => {
    assert.ok(has('const scrubLog = (t) => redactSecrets(t);'))
    assert.ok(!/const scrub = \(t\) => \(w\.provider === "codex"/.test(src), 'codex 에만 걸던 마스킹은 폐지됐다')
    assert.ok(has('const out = scrubLog(`${res.stdout || ""}\\n${res.stderr || ""}`);'), 'qa 로그 마스킹')
    assert.ok(has('## stdout\\n${scrubLog(res.stdout || "")}'), '워커 로그 마스킹')
  })
  it('워커 git 은 실행 단계에서 막힌다(#3) — shim env 배선 · exit 86/차단 표식 · 원격 ref 스냅샷 · cleanup', () => {
    assert.ok(has('guard = createGitGuard({ baseEnv: process.env });'))
    assert.ok(has('const workerEnv = guard ? workerEnvWithGuard(guard) : undefined;'))
    assert.ok(has('res = w.run(workerEnv);'), '워커 spawn 에 guard env 가 실제로 넘어간다')
    assert.ok(has('code === guard.exitCode || `${res.stderr || ""}\\n${res.stdout || ""}`.includes(guard.blockedPrefix)'))
    assert.ok(has('const remoteBefore = remoteHeads();') && has('const remoteAfter = remoteHeads();'))
    assert.ok(has('guard?.cleanup();'), 'finally 에서 shim 정리')
  })
  it('무인 커밋 자리 제한(#4) — detached 또는 auto/* 에서만 · 커밋 시점에도 재확인', () => {
    assert.ok(has('const COMMIT_PLACE_MSG = "무인 커밋은 auto/* 또는 detached worktree 에서만";'))
    assert.ok(has('return cur === "HEAD" || /^auto\\//.test(cur) || (branchName && cur === branchName);'))
    assert.ok(has('if (!commitPlaceOk(cur)) {') && has('if (!commitPlaceOk(place)) {'))
  })
  it('Claude 프로브는 실제 실행할 프로바이더가 claude 일 때만(#7) · codex 전용이면 생략', () => {
    assert.ok(has('function storyNeedsClaude(story)'))
    assert.ok(has('if (!dryRun && storyNeedsWork(story) && !storyNeedsClaude(story)) {'))
    assert.ok(has('Claude 인증 프로브 생략'))
  })
  it('조건부 게이트는 있으면 실제로 실행하고 실패는 RED 다(#10) · 인박스는 없으면 만든다(#13)', () => {
    assert.ok(has('function runConditionalGate(story, name, gate)'))
    assert.ok(has('const cg = runTriggeredGates(story, q);'))
    assert.ok(has('return { kind: name, signature: `${name}:${r.script}:${c.signature}`'))
    assert.ok(has('let base = INBOX_TEMPLATE();'), '인박스 부재 시 기본 형식으로 만든다')
    assert.ok(has('return { ok: false, why: `Decision ${r.decisions.length}건을 인박스'))
  })
  it('민감 파일 격리·복원은 fail-closed(exit 6) — 복원 오류가 원 오류를 가리지 않는다', () => {
    assert.ok(has('try { hold = hideSensitiveFiles(process.cwd()); } catch (e) {'))
    assert.ok(has('try { restoreEnvFiles(process.cwd(), hold); } catch (e) { restoreFailure = e; }'))
    assert.ok(has('if (restoreFailure) {'))
  })
  it('빌더는 문자열이 아니라 {file,argv,display} 를 돌려준다 — 로그는 display, 실행은 객체', () => {
    assert.ok(has('const built = buildCodexCommand({') && has('const built = buildClaudeCommand({'))
    assert.ok(has('cmd: built, display: built.display'))
    assert.ok(!/\$\{w\.cmd\}/.test(src), '명령 객체를 문자열 자리에 넣지 않는다')
  })
  it('Codex 리뷰는 엔진이 기재한다 — 이전 라운드 열린 findings 잔존 시 done 금지 · 빈 diff 는 claude 전환 · .env 격리·시크릿 가리기', () => {
    assert.ok(has('countOpenFindings(next, "Patch") + countOpenFindings(next, "Decision")'))
    assert.ok(has('리뷰 대상 diff 가 비어 Codex 리뷰 무의미'))
    assert.ok(has('hideSensitiveFiles(process.cwd())'))
    assert.ok(has('restoreEnvFiles(process.cwd(), hold)'))
    assert.ok(has('redactSecrets(t)'))
  })
  it('프로바이더 전환은 종류를 가리지 않고 한 장부에 센다(검증표 #2) · 수동 실행도 clean 이면 부분 산출물 폐기', () => {
    assert.ok(has('function countProviderSwitch(story, stage, nextSpec, why)'))
    assert.ok(has('countProviderSwitch(story, stage, resolved.spec, "가용성 폴백")'))
    assert.ok(has('countProviderSwitch(story, "review", alt, "빈 diff")'))
    assert.ok(has('treeWasClean = !dirty;'), '커밋 없는 수동 실행도 시작 트리 clean 이면 폐기 대상')
  })
  it('자동 수리 기본 0(종전 동작) · 예산 판정은 repairDecision 하나 · 수리 라운드 신규 흔적 승격', () => {
    assert.ok(has('const autoRepair = Math.max(0, Number(opt("auto-repair", "0")) || 0);'))
    assert.ok(has('repairDecision({ attempts: q.attempts, signatures: q.signatures, cfg: { totalRepairAttempts: autoRepair, sameRootCauseMaxRetries: repairSameCause } })'))
    assert.ok(has('escalateRepairIntroduced(q.baselineIntegrity, integ)'))
    assert.ok(!/MAX_REPAIR|repairBudget\s*=/.test(src), '수리 예산 판정기를 두 곳에 두지 않는다')
  })
  // ── 2026-09-02 2차 리뷰(codex-review-r2) — **실제 동작은 engine-e2e.test.mjs 가 증명**하고,
  //    여기서는 그 배선이 통째로 사라지는 회귀만 문다(앵커는 보강이지 대체가 아니다).
  it('[N1] 통합 게이트가 있으면 스토리 push 를 보류하고 배치 GREEN 뒤 1회만 민다', () => {
    assert.ok(has('const deferPush = doPush && (Boolean(e2eCmd) || deferPushFlag);'))
    assert.ok(has('if (doPush && deferPush) {'), '스토리 단위 push 는 보류 분기를 먼저 본다')
    assert.ok(has('function pushDeferred()'))
    assert.ok(has('pushDeferred(); // (N1)'), 'e2e GREEN 직후에만 민다')
    const e2eBlock = src.slice(src.indexOf('if (e2eCmd) {'))
    assert.ok(e2eBlock.indexOf('process.exit(1);') < e2eBlock.indexOf('pushDeferred();'), 'RED 면 push 에 닿지 않는다')
  })
  it('[N2] git 차단 shim 생성 실패·nested deny 설정 부재는 fail-closed(exit 6)', () => {
    assert.ok(!/사후 비교 가드만으로 진행/.test(src), 'guard 생성 실패 fail-open 은 폐지됐다')
    assert.ok(has('git 차단 shim 을 만들지 못했다'))
    assert.ok(has('SETTINGS STOP'))
    assert.ok(has('function localGitFingerprint()'), '절대경로 git 우회의 reflog 흔적을 본다')
    assert.ok(has('localBefore !== localAfter'))
    // 로그 기록 실패가 가드 검사를 건너뛰게 하면 안 된다(워커가 로그 폴더를 지워 exit 1 로 빠져나가던 우회)
    assert.ok(has('note(`⚠ [${story}] 워커 로그를 쓰지 못했다'))
    assert.ok(has('const settingsOverride = opt("pipeline-settings", process.env.PIPELINE_SETTINGS_PATH || "");'))
  })
  it('[N3] 배치 e2e 로그도 scrubLog 를 지난다', () => {
    assert.ok(has('writeFileSync(e2eLog, `# ${e2eCmd}\\n\\n## stdout\\n${scrubLog(res.stdout || "")}'))
  })
  it('[N8] 리뷰 적용은 임시 파일 → 인박스 우선 확정 → rename 순서다', () => {
    const fn = src.slice(src.indexOf('function applyCodexReview(story, res, w)'))
    assert.ok(fn.indexOf('const writes = [];') > 0)
    assert.ok(fn.indexOf('label: "인박스"') < fn.indexOf('label: "스토리"'), '인박스가 먼저 확정돼야 한다')
    assert.ok(fn.includes('renameSync(w2.tmp, w2.path)'))
    assert.ok(!/writeFileSync\(storyFile, next\);/.test(fn), '스토리 직접 쓰기(부분 적용 경로)는 폐지됐다')
  })
  it('[F6/F8] 인증 프로브는 spawnSafe(argv 분리) · 무결성 기본값은 on', () => {
    assert.ok(has('res = spawnSafe(file, argvProbe,'))
    assert.ok(!/spawnSync\(`\$\{claudeBin\}/.test(src), '프로브의 셸 문자열 결합은 폐지됐다')
    assert.ok(has('const integrityMode = opt("integrity", "on");'))
  })
  it('claude 프로브는 codex 스펙을 `claude --model` 로 새지 않는다', () => {
    assert.ok(has('const claudeModelOf = (m) => { const p = parseModelSpec(m); return p.provider === "claude" ? p.model : null; };'))
    assert.ok(has('const effectiveProbeModel = probeModel || claudeModelOf(models.dev)'))
  })
  // ── 2026-09-02 3차 리뷰(codex-review-r3) — 실동작은 engine-e2e·providers-hardening 이 증명하고,
  //    여기서는 그 배선이 통째로 사라지는 회귀만 문다.
  it('[M5] 엔진에 `shell: true` 가 0건이다 — 자유형 명령은 planCommand 로 argv 분리', () => {
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.equal((code.match(/shell:\s*true/g) ?? []).length, 0, '셸 문자열 실행이 남아 있다')
    assert.ok(has('function planCommand(label, cmd)'), '자유형 명령 정규화 지점')
    assert.ok(has('const plan = planCommand("qa 게이트(--qa)", qaCmd);'))
    assert.ok(has('const e2ePlan = planCommand("배치 e2e(--e2e)", e2eCmd);'))
    assert.ok(has('const plan = planCommand(`${name} 게이트(package.json scripts.${gate.script})`, gate.cmd);'))
    assert.ok(has('COMMAND FORMAT STOP'), '형식 거부는 조용히 넘어가지 않는다')
    // 알림도 셸·curl 을 거치지 않는다(러너와 같은 fetch 경로)
    assert.ok(has('spawnSafe(process.execPath, [NOTIFY_BIN,'))
    assert.ok(!/\bcurl\b/.test(code), 'curl 셸 문자열이 남아 있다')
  })
  it('[H3] 워커 env 에서 원격 자격증명을 지우고, 원격 URL 에 박힌 토큰은 시작 전에 STOP', () => {
    assert.ok(has('const stripped = stripRemoteCredentials(guard.env);'), '워커 env 배선')
    assert.ok(has('const env = { ...stripped.env };'))
    assert.ok(has('const credRemotes = findCredentialRemotes(git(["remote", "-v"]).out);'))
    assert.ok(has('REMOTE CREDENTIAL STOP'))
    assert.ok(has('kind: "remote-credential"'))
  })
  it('[M2] T2 유형 근거는 매니페스트에 구조화해 남긴다 · `checks.unit` 문자열 계약은 그대로', () => {
    assert.ok(has('m.checks.unitKinds = m.completion.evidence?.newTests?.kinds ?? null;'))
    assert.ok(!/checks\.unit\s*=\s*\{/.test(src), 'checks.unit 은 pass/fail 문자열이어야 한다(readiness·현황판이 그렇게 읽는다)')
  })
})
