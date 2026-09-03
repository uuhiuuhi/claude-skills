#!/usr/bin/env node
// night-batch-ops 설치기 — **대상 프로젝트 루트에서** 실행한다.
//
//   node <이 폴더>/install.mjs                  # 파일 설치 + 다음 단계 안내(예약 등록은 안 함)
//   node <이 폴더>/install.mjs --register-tasks # 무정지 예약 작업 1개 등록(관리 권한 불필요 · 로그온 세션 필요)
//   node <이 폴더>/install.mjs --clone <경로>   # 실행 전용 클론까지 생성(예: 프로젝트 폴더와 나란한 <이름>-auto)
//   node <이 폴더>/install.mjs --force          # 기존 tools/auto/*.mjs 덮어쓰기(업그레이드)
//
// 설치 원칙: 실행 인프라(예약·클론)는 기본 **안내만** 하고, 옵트인 플래그로만 만든다 —
// 시스템 상태 변경은 사람이 보는 앞에서.
//
// 무정지(Non-Stop) 개편 — 예약 작업은 **1개**뿐이다: 00:05 시작 · 30분 간격 · 무기한 반복.
// 구판의 「18:00 데일리 + 4시간 슬롯 5회」는 시계가 밤에만 열려 있었다. 러너가 lock·연속 루프·
// 선형 승계로 겹침과 미머지를 스스로 처리하게 된 이상, 시계는 계속 두드리기만 하면 된다.
// ⚠️ 실측된 함정: PowerShell `New-ScheduledTaskTrigger -RepetitionDuration ([TimeSpan]::MaxValue)` 는
//    "The task XML contains a value which is incorrectly formatted or out of range" 로 **실패한다**.
//    그래서 **작업 XML 직접 등록**을 쓰고, Repetition 에서 <Duration> 을 아예 생략한다(생략 = 무기한).
//    XML 은 항상 파일로 남긴다 — 등록이 실패해도 사람이 같은 파일로 재현할 수 있어야 한다.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve('.')
const argv = process.argv.slice(2)
const has = (n) => argv.includes(`--${n}`)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }

const fail = (m) => { console.error(`✖ ${m}`); process.exit(2) }
if (!existsSync(join(ROOT, 'package.json'))) fail('대상 프로젝트 루트에서 실행해야 한다(package.json 없음)')

// ── 능력 감지 실행기 — **셸 문자열 결합 금지**(2026-09-02 하드닝 정책 8 · codex-review-r2) ─────────
// 종전 `spawnSync('codex --version', { shell:true })` 는 ① `CODEX_BIN` 이 `C:\Program Files\…\codex.cmd`
// 처럼 공백을 품으면 실행조차 못 하고 ② 그 값에 `&`·`|` 가 있으면 cmd.exe 가 두 번째 명령을 돌린다.
// 실행파일과 argv 를 분리하고, Windows 의 `.cmd`/`.bat` 심만 cmd.exe 전용 경로로 부른다(메타문자는 거부).
const SHELL_META_RE = /[&|<>^"`$;\r\n]/
const PATH_SEP = process.platform === 'win32' ? ';' : ':'
/** PATH(+Windows PATHEXT) 에서 실행파일을 직접 찾는다 — `shell:false` 는 PATH 를 풀어 주지 않는다. */
function whichBin(name) {
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : ''
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const raw of (process.env.PATH || '').split(PATH_SEP).filter(Boolean)) {
    const dir = raw.replace(/^"|"$/g, '')
    for (const ext of exts) {
      const p = join(dir, name + ext)
      if (existsSync(p)) return p
    }
  }
  return ''
}
function safeExec(bin, args = []) {
  const file = String(bin ?? '')
  const list = (args ?? []).map(String)
  if (file === '' || SHELL_META_RE.test(file) || list.some((a) => SHELL_META_RE.test(a))) {
    return { status: 1, stdout: '', stderr: `실행 거부 — 실행파일·인자에 셸 메타문자가 있다: ${file}` }
  }
  const o = { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, shell: false }
  // `/s` 는 바깥 따옴표 한 쌍만 벗긴다 — 그래서 전체를 한 번 더 감싼다(안 감싸면 공백 경로가 깨진다).
  const r = /\.(cmd|bat)$/i.test(file) && process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${file}" ${list.map((a) => `"${a}"`).join(' ')}"`], { ...o, windowsVerbatimArguments: true })
    : spawnSync(file, list, o)
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const notes = []

// 프로젝트 이름·상태 폴더는 **러너와 같은 3단계 우선순위**로 정한다(공유 계약 C3):
//   이름  = 기존 auto.config.json 의 project → package.json name → 폴더명
//   폴더  = AUTO_BATCH_STATE_DIR → auto.config.json 의 stateDir → ~/.claude-auto/<이름>
// 설치기가 package.json 만 보면, 이미 config 에 project 를 적어 둔 저장소에서 상태 폴더가 둘로
// 갈라진다 — 설치기가 만든 로그·작업 XML 은 A 폴더로, 러너의 lock·원장·심박은 B 폴더로 흩어져
// 「심박 확인」이 영영 빈 파일을 본다.
const cfgPath = join(ROOT, 'tools', 'auto', 'auto.config.json')
const readJsonIf = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {} } catch { return {} } }
const existingCfg = readJsonIf(cfgPath)
// project 해석은 엔진 3파일과 **똑같이** 2단계다 — `auto.config.json` 의 project → 폴더 이름.
// package.json 의 name 을 중간에 끼우면, project 키 없는 손수 쓴 config 에서 설치기와 러너가
// 서로 다른 상태 폴더를 보게 된다(예약 작업의 로그와 러너의 lock·원장이 갈라진다).
const project = String(existingCfg.project || basename(ROOT)).replace(/[^a-zA-Z0-9-_]/g, '-')

// ── 전제 점검(막지 않고 기록) ──────────────────────────────────────────────
const engine = join(homedir(), '.claude', 'skills', 'auto-story-finish', 'auto-story-pipeline.mjs')
if (!existsSync(engine)) notes.push('⚠️ auto-story-finish 전역 스킬이 없다 — 같은 저장소의 auto-story-finish/ 를 ~/.claude/skills/ 에 먼저 설치할 것')
else if (!existsSync(join(dirname(engine), 'providers', 'index.mjs'))) notes.push('⚠️ 설치된 auto-story-finish 가 구판(providers/ 계층 없음) — Codex 워커·자동 수리를 쓰려면 같은 저장소의 최신 auto-story-finish/ 로 갱신할 것')
// Codex 는 선택 사항 — 없어도 Claude 전용으로 그대로 돈다. 있으면 어떤 상태인지만 적어 둔다(설치 결정은 사람 몫).
{
  const codexBin = process.env.CODEX_BIN || whichBin('codex')
  const v = codexBin ? safeExec(codexBin, ['--version']) : { status: 1, stdout: '', stderr: 'PATH 에 codex 없음' }
  if ((v.status ?? 1) !== 0) notes.push('· Codex CLI 없음 — Claude 전용(providers.codex.enabled 는 false 유지). 쓰려면 `npm i -g @openai/codex` + `codex login`')
  else {
    const l = safeExec(codexBin, ['login', 'status'])
    const ok = (l.status ?? 1) === 0 && /logged in/i.test(`${l.stdout}${l.stderr}`) && !/not logged in/i.test(`${l.stdout}${l.stderr}`)
    notes.push(`· Codex CLI ${String(v.stdout).trim()} — ${ok ? '로그인됨. providers.codex.enabled 를 true 로 켜면 리뷰 교차검증에 쓴다(배치 워크트리에서만 실행)' : '미인증 — `codex login` 후 켤 것'}`)
  }
}
// nested 워커의 commit/push deny 설정 — 엔진은 이게 없으면 배치를 **시작조차 하지 않는다**(fail-closed).
if (![join(ROOT, '.claude', 'pipeline-settings.json'), join(homedir(), '.claude', 'pipeline-settings.json')].some((p) => existsSync(p)))
  notes.push('⚠️ pipeline-settings.json 이 없다(.claude/ · ~/.claude/ 모두) — 엔진이 배치를 시작하지 않는다. ' +
    'deny 규칙(예: {"permissions":{"deny":["Bash(git commit:*)","Bash(git push:*)","Bash(git stash:*)","Bash(git reset:*)"]}})을 담아 둘 것')
if (!existsSync(join(ROOT, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml')))
  notes.push('⚠️ sprint-status.yaml 이 없다 — BMad 산출물이 없으면 자동 편성(--auto-plan)은 돌지 않는다(수동 큐는 가능)')
if (!(pkg.scripts && pkg.scripts.qa)) notes.push('⚠️ `npm run qa` 스크립트가 없다 — 엔진 qa 게이트가 실패한다. typecheck+lint+test 조합으로 정의할 것')

// ── 1. 엔진 파일 설치 ────────────────────────────────────────────────────
const dst = join(ROOT, 'tools', 'auto')
mkdirSync(dst, { recursive: true })
// 목록을 고정하지 않는다 — 엔진에 새 모듈(plan-dag·conflicts…)이 생길 때마다 설치본만 구판이 되어
// 러너가 ERR_MODULE_NOT_FOUND 로 죽는다(2026-09-02 e2e 실측). 테스트 파일은 제외한다.
for (const f of readdirSync(join(SELF, 'engine')).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
  const to = join(dst, f)
  if (existsSync(to) && !has('force')) { notes.push(`· ${f} 이미 있음 — 건너뜀(덮어쓰려면 --force)`); continue }
  copyFileSync(join(SELF, 'engine', f), to)
  console.log(`✔ tools/auto/${f}`)
}

// ── 2. 설정 파일(프로젝트 고유값의 집) ──────────────────────────────────
if (!existsSync(cfgPath)) {
  writeFileSync(cfgPath, JSON.stringify({
    _readme: [
      '프로젝트 고유값의 집 — 엔진 코드에는 프로젝트 값을 넣지 않는다.',
      'epicOrder: 에픽 우선순위(사람이 정한다). 비어 있으면 자동 편성이 이유를 말하고 선다.',
      'parallelAllow: { "<스토리키>": <에픽번호> } — 그 에픽이 진행 중이어도 후보로 두는 예외.',
      'dailyCap: 하루 편성 상한 — 단위는 **하루 고유 스토리 수**다(dev↔review 재편성은 무과금). 폭주 방지 백스톱이지 페이스가 아니다 · parallel: 병렬 폭.',
      'exhaustedModels: 이번 주 한도가 소진된 모델 목록(예: ["fable"]). 편성 단계에서 짝 단위로 대체해 교차검증(dev ≠ review)을 지킨다. 기본은 빈 목록.',
      'stateDir: 상태 폴더를 직접 지정(비우면 ~/.claude-auto/<project> · 환경변수 AUTO_BATCH_STATE_DIR 이 최우선).',
      'models: 적지 않으면 엔진 기본값 = 종류별 교차검증(신규 dev/review 상위-차상위 · 회수는 반대 · 마감 재검수 review 상위).',
      '  고정하고 싶을 때만 { "new": {...}, "recovery": {...}, "closeout": {...} } 또는 평면 { "dev": "...", "review": "..." } 로 적는다.',
      '  ⚠️ { "dev": null, "review": null } 처럼 빈 값을 적으면 기본 교차검증이 통째로 꺼진다 — 쓸 게 없으면 키를 두지 않는다.',
      'mockupGate: 새 화면 스토리의 목업 승인 게이트. marker 를 비우면 게이트 미구성으로 보고 통과시킨다.',
      '  marker = 스토리 절에서 찾을 표시 문구 · ruleId = 함께 요구할 내부 규칙 ID(없으면 null)',
      '  mockupsDir = 목업 파일 폴더 · verdictsPath = 승인 판정 JSON 경로.',
      '── 다중 프로바이더 하네스(2026-09-02 · 전부 선택 · 키를 지우면 종전 Claude 전용 동작) ──',
      'workers: { max: 총 동시 워커(기본 3 = 종전 하드캡 · 절대 상한 6), batchSize: 규칙 5 짝 크기(기본 2) }',
      'providers.codex: { enabled(기본 false), max(동시 1 고정 권장 — 같은 auth.json 동시 사용 불가), roles([\"review\"] 또는 [\"review\",\"dev\"]),',
      '  reviewKinds([\"new\",\"closeout\"] — recovery 는 review 단계가 없다), split(dev 역할일 때 병렬 짝을 Claude/Codex 로 나눔), network(기본 false — Codex dev 샌드박스 네트워크) }',
      '  codex 는 배치 워크트리에서만 실행되며(본 트리 실데이터 반출 방지) 미설치·미인증·한도면 엔진이 claude 로 폴백한다 — 배치는 서지 않는다.',
      'quality: { autoRepair: true|숫자(총 수리 시도 · 기본 0 = qa RED 즉시 STOP), sameRootCauseMaxRetries(기본 3), integrity: auto|on|off }',
      'integrationGate: { enabled(병렬 landing 뒤 통합 트리에서 qa 1회) } — RED 는 **설정으로 우회 불가**: 항상 landing 되돌림 + STOP + push 금지(옛 pushOnFail 은 폐지 · 남아 있으면 무시하고 경고)',
      'orchestrator: { enabled(기본 true), model(기본 fable), timeoutMin(기본 5), cacheHours(기본 12) }',
      '  👤 2026-09-03 결정: 「(가) 캐시 추가 후 Fable 계획을 켠다 · BaroOS 프로젝트 중에는 항상 켜 두어 최대 작업량으로」 — 그래서 기본값이 켜짐이다.',
      '  켜면 --auto-plan 의 규칙 큐를 지휘 모델이 재편성한다. 후보는 규칙이 고른 스토리뿐이고(추가 불가) 검증기를 통과할 때만 채택 —',
      '  거부·오류·타임아웃은 전부 규칙 큐 폴백이다(로그 [ORCHESTRATOR] source=…). LLM 때문에 밤이 서지 않는다.',
      '  cacheHours = 같은 후보 지문(후보 키·kind·상태 · 봉쇄 · 남은 상한 · parallel · 체인 나이 · 모델 가용성)이면 지난 계획을 그대로 다시 쓴다(0 이면 매 슬롯 호출).',
      '  적중은 [ORCHESTRATOR] source=fable(cache) (cache hit) — 30분 슬롯마다 같은 질문을 사지 않는다. 실행기가 연속 3회 죽으면 그 시간만큼 호출을 쉰다(runner-cooldown).',
      '⚠️ providers.codex.max 는 동시 상한이자 **배치당 Codex 몫**이다 — max:1 + 2폭이면 배치의 첫 스토리만 Codex 리뷰를 받는다.',
    ],
    project,
    epicOrder: [],
    parallelAllow: {},
    dailyCap: 30,
    exhaustedModels: [],
    parallel: 2,
    stateDir: null,
    mockupGate: {
      marker: '새 화면',
      ruleId: null,
      mockupsDir: 'mockups',
      verdictsPath: 'tools/dev-status/mockup-verdicts.json',
    },
    workers: { max: 3, batchSize: 2 },
    providers: {
      claude: { enabled: true, max: 3 },
      codex: { enabled: false, max: 1, roles: ['review'], reviewKinds: ['new', 'closeout'], split: false, network: false, fallback: true },
    },
    quality: { autoRepair: true, sameRootCauseMaxRetries: 3, totalRepairAttempts: 5, integrity: 'auto' },
    integrationGate: { enabled: true },
    orchestrator: { enabled: true, model: 'fable', timeoutMin: 5, cacheHours: 12 },
  }, null, 2) + '\n', 'utf8')
  console.log('✔ tools/auto/auto.config.json (epicOrder 를 채워야 자동 편성이 돈다)')
} else notes.push('· auto.config.json 이미 있음 — 유지')

const queuePath = join(dst, 'night-queue.json')
if (!existsSync(queuePath)) {
  // ⚠️ planned 는 반드시 'auto' 로 시작한다. 러너는 `planned !== 'auto'` 를 「사람이 쓴 큐」로 읽고
  //    그 큐를 그 날의 1순위로 소비한다 — 설명 문장을 넣어 두면 **빈 수동 큐가 첫 라운드를 통째로
  //    먹고** 자동 편성으로 넘어가지 않는다(실측). 설명은 _readme 로 뺀다.
  writeFileSync(queuePath, JSON.stringify({
    _readme: '수동 큐 — batches 를 채우고 planned 를 아무 설명 문장으로 바꾸면 다음 라운드가 1회 우선 소비한다. ' +
      "비워 둘 때는 planned 를 'auto' 로 두어야 자동 편성이 돈다.",
    planned: 'auto',
    updated: '',
    defaults: { waitAuthMin: 480, stageTimeoutMin: 150, commit: true, push: true },
    batches: [],
  }, null, 2) + '\n', 'utf8')
  console.log("✔ tools/auto/night-queue.json (빈 수동 큐 · planned='auto' → 자동 편성)")
} else notes.push('· night-queue.json 이미 있음 — 유지')

// ── 3. 실행 전용 클론(옵트인) ────────────────────────────────────────────
const clonePath = opt('clone', '')
if (clonePath) {
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim()
  if (!origin) fail('origin 원격이 없다 — 클론을 만들 수 없다')
  if (!existsSync(clonePath)) {
    console.log(`… git clone ${origin} → ${clonePath}`)
    const r = spawnSync('git', ['clone', origin, clonePath], { stdio: 'inherit' })
    if (r.status !== 0) fail('클론 실패')
  }
  writeFileSync(join(clonePath, '.auto-batch-worktree'), 'night-batch-ops 실행 전용 클론 marker — 러너가 이 파일이 있을 때만 checkout -f 새로고침을 한다\n', 'utf8')
  console.log(`✔ 실행 전용 클론 + marker: ${clonePath}`)
  notes.push(`· 클론에서 \`npm install\` 을 한 번 돌려 둘 것(qa 게이트용): cd ${clonePath} && npm install`)
}

// ── 4. 예약 작업 = 무정지 1개(기본 = 명령 출력 · --register-tasks 로만 실제 등록) ─────
const runDir = clonePath || ROOT
// 실행 폴더에 엔진이 실제로 있는지 본다. 방금 만든 클론에는 **없다** — 엔진은 ROOT 에 복사됐을 뿐
// 아직 커밋·푸시되지 않았기 때문이다. 여기서 파일을 클론에 직접 복사해 넣는 우회는 쓰지 않는다:
// 러너는 marker 클론을 라운드마다 `git clean -fdq` + `checkout -f` 로 새로고침하므로 복사본이
// 첫 라운드에 그대로 지워진다(= 며칠 뒤 조용히 실패). 그래서 「커밋·푸시 → 클론 pull」이
// 유일하게 안 깨지는 경로이고, 그 전에는 **예약을 등록하지 않는다**(등록 즉시 실패 방지).
// 목록을 손으로 적지 않는다 — engine/ 에 새 모듈(plan-dag·orchestrate·assign·conflicts·metrics·bench…)이
// 생겼는데 여기만 구판이면 클론은 「동기 완료」로 보이고 러너는 첫 라운드에 ERR_MODULE_NOT_FOUND 로 죽는다.
// 설치 복사와 **같은 규칙**(engine/*.mjs 에서 테스트 제외)으로 세고, 설정 파일 하나를 더한다.
const engineFiles = [
  ...readdirSync(join(SELF, 'engine')).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')).sort(),
  'auto.config.json',
]
const missingInRunDir = engineFiles.filter((f) => !existsSync(join(runDir, 'tools', 'auto', f)))
const syncSteps = [
  `cd ${ROOT} && git add tools/auto && git commit -m "chore(auto): night-batch-ops 엔진·설정" && git push`,
  `cd ${runDir} && git pull`,
]
const nodeExe = process.execPath
// C3 3단계 — 러너·편성기와 같은 순서. 이 폴더가 어긋나면 로그·lock·원장이 갈라진다.
const stateDir = process.env.AUTO_BATCH_STATE_DIR || existingCfg.stateDir || join(homedir(), '.claude-auto', project)
mkdirSync(stateDir, { recursive: true })
if (process.env.AUTO_BATCH_STATE_DIR) {
  notes.push('⚠️ 상태 폴더를 환경변수 AUTO_BATCH_STATE_DIR 로 잡았다 — 예약 작업은 이 셸의 환경변수를 물려받지 않는다. ' +
    'auto.config.json 의 stateDir 에 같은 경로를 적어 둘 것(안 적으면 러너는 기본 폴더를 본다).')
}

const taskName = `${project}-nonstop`
const legacyNames = [`${project}-night-batch`, `${project}-auto-slots`] // 구판 2개 — 삭제하지 않는다(롤백 경로)
const logPath = join(stateDir, 'slots.log')
const xmlPath = join(stateDir, `${taskName}.xml`)
const ymd = (() => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` })()
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 작업 XML — Windows 가 실제로 받아 준 형태를 그대로 쓴다(Export-ScheduledTask 왕복본 기준).
//  · Repetition 에 <Duration> 없음 = 무기한 반복  · ExecutionTimeLimit PT0S = 시간 제한 없음
//    (연속 루프가 몇 시간을 돌아도 스케줄러가 중간에 죽이지 않는다)
//  · MultipleInstancesPolicy IgnoreNew = 앞 라운드가 아직 돌면 새 인스턴스를 만들지 않는다
//    (러너 lock v2 와 이중 방어 — 30분 간격이 라운드보다 짧아도 겹치지 않는다)
//  · 배터리 조건 false = 노트북에서 전원이 빠져도 밤이 서지 않는다
//  · UserId 는 등록 시점에 PowerShell 이 현재 사용자 SID 로 치환한다(__USERID__ 자리표)
// ⚠️ XML 선언(<?xml … encoding=…?>)을 **일부러 넣지 않는다**. 넣으면 두 경로 중 하나가 반드시 깨진다:
//    PowerShell 은 문자열(UTF-16)로 넘기므로 encoding="UTF-8" 선언이면 파서가
//    "unable to switch the encoding" 로 거부하고(실측), 반대로 UTF-16 이라 선언하면 UTF-8 파일을
//    GUI「작업 가져오기」로 읽을 때 깨진다. 선언이 없으면 문자열 경로는 그대로 통과하고
//    파일 경로는 XML 기본값(UTF-8)으로 읽혀 둘 다 맞는다.
const taskXml = `<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${esc(`night-batch-ops 무정지 러너 — 00:05 시작 · 30분 간격 무기한 · ${runDir} 에서 --auto-plan`)}</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>__USERID__</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT30M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${ymd}T00:05:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>cmd</Command>
      <Arguments>${esc(`/c cd /d ${runDir} && "${nodeExe}" tools\\auto\\run-night.mjs --auto-plan >> "${logPath}" 2>&1`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`
writeFileSync(xmlPath, taskXml, 'utf8') // BOM 없는 UTF-8 — 설정 JSON 과 같은 규율
console.log(`✔ 작업 XML: ${xmlPath}`)

// 등록 명령 — Get-Content 는 반드시 -Encoding UTF8(PS 5.1 기본은 ANSI 라 한글 설명이 깨진다).
const ps = `$xml = Get-Content -Raw -Encoding UTF8 "${xmlPath}"
$xml = $xml.Replace('__USERID__', [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
Register-ScheduledTask -TaskName "${taskName}" -Xml $xml -Force`

// 이미 있는 작업 조회(읽기 전용) — 구판 2개는 **삭제하지 않고 Disable 을 권고**한다(롤백 경로 보존).
const existingTasks = (() => {
  if (process.platform !== 'win32') return []
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-ScheduledTask | Select-Object -ExpandProperty TaskName'], { encoding: 'utf8' })
  return (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
})()
const foundLegacy = legacyNames.filter((n) => existingTasks.includes(n))

if (process.platform !== 'win32') {
  notes.push(`⚠️ Windows 가 아니다 — 예약 등록은 건너뛴다. 동등 편성: 30분마다 \`cd ${runDir} && node tools/auto/run-night.mjs --auto-plan\`(cron \`*/30 * * * *\` 등 · 중복 기동은 러너 lock 이 막는다)`)
} else if (missingInRunDir.length > 0) {
  console.log(`\n✖ 예약 등록 보류 — 실행 폴더에 엔진이 없다: ${runDir} (없는 파일: ${missingInRunDir.join(', ')})`)
  console.log('   지금 등록하면 30분마다 즉시 실패한다. 아래 두 줄을 먼저 실행한 뒤 다시 돌린다:')
  for (const s of syncSteps) console.log(`   ${s}`)
  console.log(`   그 다음: node <이 폴더>/install.mjs --register-tasks   (또는 아래 PowerShell 을 직접)`)
  console.log(ps)
} else if (has('register-tasks')) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' })
  if (r.status === 0) console.log(`✔ 예약 작업 등록: ${taskName} — 00:05 시작 · 30분 간격 · 무기한 반복`)
  else {
    console.log('✖ 예약 등록 실패 — 아래를 사람이 직접 실행(또는 작업 스케줄러 GUI → 작업 가져오기 로 XML 불러오기)')
    console.log(ps)
  }
} else {
  console.log(`\n── 예약 작업(등록 안 함 — --register-tasks 또는 아래 PowerShell 을 직접 실행) ──`)
  console.log(`# ${taskName}: 00:05 시작 · 30분 간격 · 무기한 반복(작업 1개가 24시간을 덮는다)`)
  console.log(ps)
}
if (foundLegacy.length) {
  notes.push(`· 구판 예약 작업 발견: ${foundLegacy.join(', ')} — **삭제하지 말고 사용 중지**(롤백 경로): ` +
    foundLegacy.map((n) => `Disable-ScheduledTask -TaskName "${n}"`).join(' ; '))
}
if (existingTasks.includes(taskName)) notes.push(`· ${taskName} 이 이미 있다 — --register-tasks 는 -Force 로 덮어쓴다(트리거·동작이 위 XML 로 교체됨)`)

// ── 5. 남은 사람 몫 ─────────────────────────────────────────────────────
console.log('\n── 다음 단계(사람 확인 필요) ──')
console.log(`1. tools/auto/auto.config.json 의 epicOrder 를 채운다(예: [1,2,3] — 에픽 번호를 우선순위 순으로) · mockupGate 는 프로젝트 관례에 맞게`)
if (clonePath) {
  console.log(`1-b. **클론 실행 전 필수** — 엔진이 git 을 타고 클론에 들어가야 한다(직접 복사는 러너 새로고침에 지워진다):`)
  for (const s of syncSteps) console.log(`     ${s}`)
}
console.log(`2. 프로젝트 .claude/settings.json 에 npm·node·git 읽기/빌드 allow 규칙 추가 후 대화형에서 1회 신뢰`)
console.log(`3. (알림) 텔레그램: ~/.claude-auto/telegram-token.txt + telegram-chat.json (공용 — 여러 프로젝트가 같은 봇 공유) 또는 ~/.claude/ntfy-topic.txt`)
console.log(`4. 프로젝트 CLAUDE.md 에 무정지 계약을 기록: 선형 승계(미머지가 남아도 밤은 계속) · 하향 동기(라운드마다 origin/main 흡수) · 체인 게이트(미머지 2일 이상이면 신규 착수만 보류 — 회수·마감은 계속) · 하루 상한은 폭주 방지 백스톱(그날만 늘리려면 텔레그램 /extend N)`)
console.log(`5. **먼저 커밋**(방금 만든 tools/auto 가 untracked 면 러너의 dirty 가드에 걸려 리허설이 exit 4 로 죽는다):`)
for (const s of syncSteps) console.log(`     ${s}`)
console.log(`6. 리허설: node tools/auto/plan-queue.mjs --dry → node tools/auto/run-night.mjs --auto-plan --dry-run`)
console.log(`7. 예약은 Interactive only — PC 가 로그온 상태로 켜져 있어야 30분마다 깨어난다. 심박 확인: ${logPath}`)
if (notes.length) { console.log('\n── 점검 메모 ──'); for (const n of notes) console.log(n) }
