// providers/claude.mjs — Claude Code 워커 어댑터 (종전 runClaude 의 실행부를 그대로 옮긴 것).
//
// 인자 계약은 **종전과 같다** — `claude -p [--model X] --permission-mode acceptEdits [--settings <path>]`.
// 권한 우회 플래그는 의도적으로 없다(엔진 가드레일).
//
// 2026-09-02 하드닝(codex-review-r1 #6): 종전에는 위 인자들을 **문자열로 이어 붙여** `shell:true` 로 돌렸다.
// 모델 값이 `opus & git push origin HEAD:main` 이면 cmd.exe 가 두 번째 명령을 실행했고, 공백이 든
// `CLAUDE_BIN=C:\Program Files\…\claude.cmd` 는 반대로 실행조차 되지 않았다. 이제 **실행파일과 argv 를 분리**해
// `shell:false` 로 spawn 하고, Windows `.cmd` 심만 spawn-safe 의 전용 cmd.exe 경로로 간다(메타문자는 거부).
import { spawnSync } from 'node:child_process'
import { assertSafeModel, assertSafePath, spawnSafe } from './spawn-safe.mjs'

export const CLAUDE_PERM_MODE = 'acceptEdits'

/** 반환 `{ file, argv, display }` — display 는 로그 전용(종전 한 줄 표기 보존). 실행은 file+argv 로만 한다. */
export function buildClaudeCommand({ bin = 'claude', model = '', permMode = CLAUDE_PERM_MODE, settingsPath = null } = {}) {
  const file = assertSafePath(bin, 'CLAUDE_BIN')
  const argv = ['-p']
  if (model) argv.push('--model', assertSafeModel(model, '모델'))
  argv.push('--permission-mode', assertSafeModel(permMode, 'permission-mode'))
  if (settingsPath) argv.push('--settings', assertSafePath(settingsPath, 'settings 경로'))
  const display = `${file} -p${model ? ` --model ${model}` : ''} --permission-mode ${permMode}${settingsPath ? ` --settings "${settingsPath}"` : ''}`
  return { file, argv, display }
}

/** 실행 — stdin 프롬프트 · 타임아웃 · stdout/stderr 수집. 반환 형태는 codex 어댑터와 동일 계약.
 *  `cmd` 에 buildClaudeCommand 의 반환값을 통째로 넘겨도 되고, file/argv 를 직접 줘도 된다.
 *  `env` 를 주면 그대로 자식에 전달한다 — git-guard 의 shim PATH 를 여기로 배선한다. */
export function runClaudeWorker({ cmd = null, file = null, argv = null, prompt, timeoutMs, env = undefined, spawn = spawnSync }) {
  const f = file ?? cmd?.file
  const a = argv ?? cmd?.argv ?? []
  const res = spawnSafe(f, a, {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    ...(env ? { env } : {}),
  }, spawn)
  return {
    provider: 'claude',
    code: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    timedOut: Boolean(res.error && res.error.code === 'ETIMEDOUT'),
    lastMessage: null, // claude -p 는 stdout 전체가 응답이다
    events: null,
  }
}
