#!/usr/bin/env node
// night-batch-ops 설치기 — **대상 프로젝트 루트에서** 실행한다.
//
//   node <이 폴더>/install.mjs                  # 파일 설치 + 다음 단계 안내(예약 등록은 안 함)
//   node <이 폴더>/install.mjs --register-tasks # 예약 작업 2개까지 등록(관리 권한 불필요 · 로그온 세션 필요)
//   node <이 폴더>/install.mjs --clone <경로>   # 실행 전용 클론까지 생성(예: C:\Projects\<이름>-auto)
//   node <이 폴더>/install.mjs --force          # 기존 tools/auto/*.mjs 덮어쓰기(업그레이드)
//
// 설치 원칙: 실행 인프라(예약·클론)는 기본 **안내만** 하고, 옵트인 플래그로만 만든다 —
// 시스템 상태 변경은 사람이 보는 앞에서.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const project = (pkg.name || basename(ROOT)).replace(/[^a-zA-Z0-9-_]/g, '-')
const notes = []

// ── 전제 점검(막지 않고 기록) ──────────────────────────────────────────────
const engine = join(homedir(), '.claude', 'skills', 'auto-story-finish', 'auto-story-pipeline.mjs')
if (!existsSync(engine)) notes.push('⚠️ auto-story-finish 전역 스킬이 없다 — 같은 저장소의 auto-story-finish/ 를 ~/.claude/skills/ 에 먼저 설치할 것')
if (!existsSync(join(ROOT, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml')))
  notes.push('⚠️ sprint-status.yaml 이 없다 — BMad 산출물이 없으면 자동 편성(--auto-plan)은 돌지 않는다(수동 큐는 가능)')
if (!(pkg.scripts && pkg.scripts.qa)) notes.push('⚠️ `npm run qa` 스크립트가 없다 — 엔진 qa 게이트가 실패한다. typecheck+lint+test 조합으로 정의할 것')

// ── 1. 엔진 파일 설치 ────────────────────────────────────────────────────
const dst = join(ROOT, 'tools', 'auto')
mkdirSync(dst, { recursive: true })
for (const f of ['run-night.mjs', 'plan-queue.mjs', 'runner-rules.mjs']) {
  const to = join(dst, f)
  if (existsSync(to) && !has('force')) { notes.push(`· ${f} 이미 있음 — 건너뜀(덮어쓰려면 --force)`); continue }
  copyFileSync(join(SELF, 'engine', f), to)
  console.log(`✔ tools/auto/${f}`)
}

// ── 2. 설정 파일(프로젝트 고유값의 집) ──────────────────────────────────
const cfgPath = join(dst, 'auto.config.json')
if (!existsSync(cfgPath)) {
  writeFileSync(cfgPath, JSON.stringify({
    _readme: '프로젝트 고유값의 집 — epicOrder 는 사람이 정한다(비어 있으면 자동 편성이 서서 알려 준다)',
    project,
    epicOrder: [],
    parallelAllow: {},
    dailyCap: 12,
    models: { dev: null, review: null },
  }, null, 2) + '\n', 'utf8')
  console.log('✔ tools/auto/auto.config.json (epicOrder 를 채워야 자동 편성이 돈다)')
} else notes.push('· auto.config.json 이미 있음 — 유지')

const queuePath = join(dst, 'night-queue.json')
if (!existsSync(queuePath)) {
  writeFileSync(queuePath, JSON.stringify({
    planned: '수동 큐 — 사람이 채우면 다음 슬롯이 1회 우선 소비한다',
    updated: '',
    defaults: { waitAuthMin: 480, stageTimeoutMin: 150, commit: true, push: true },
    batches: [],
  }, null, 2) + '\n', 'utf8')
  console.log('✔ tools/auto/night-queue.json (빈 수동 큐)')
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

// ── 4. 예약 작업(기본 = 명령 출력 · --register-tasks 로만 실제 등록) ─────
const runDir = clonePath || ROOT
const nodeExe = process.execPath
const stateDir = join(homedir(), '.claude-auto', project)
const psTask = (name, times) => `
$a = New-ScheduledTaskAction -Execute "cmd" -Argument '/c cd /d ${runDir} && "${nodeExe}" tools\\auto\\run-night.mjs --auto-plan >> "${stateDir}\\slots.log" 2>&1'
$t = @(${times.map((t) => `New-ScheduledTaskTrigger -Daily -At ${t}`).join(', ')})
Register-ScheduledTask -TaskName "${name}" -Action $a -Trigger $t -Force`

const ps = [psTask(`${project}-night-batch`, ['18:00']), psTask(`${project}-auto-slots`, ['22:00', '02:00', '06:00', '10:00', '14:00'])].join('\n')
mkdirSync(stateDir, { recursive: true })
if (has('register-tasks')) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' })
  console.log(r.status === 0 ? `✔ 예약 작업 등록: ${project}-night-batch(18:00) · ${project}-auto-slots(4시간 슬롯)` : '✖ 예약 등록 실패 — 아래 명령을 사람이 직접 실행')
  if (r.status !== 0) console.log(ps)
} else {
  console.log('\n── 예약 작업(등록 안 함 — --register-tasks 또는 아래 PowerShell 을 직접 실행) ──')
  console.log(ps)
}

// ── 5. 남은 사람 몫 ─────────────────────────────────────────────────────
console.log('\n── 다음 단계(사람 확인 필요) ──')
console.log(`1. tools/auto/auto.config.json 의 epicOrder 를 채운다(예: [2,3,11,4]) — 프로젝트의 파일럿/목표 경로`)
console.log(`2. 프로젝트 .claude/settings.json 에 npm·node·git 읽기/빌드 allow 규칙 추가 후 대화형에서 1회 신뢰`)
console.log(`3. (알림) 텔레그램: ~/.claude-auto/telegram-token.txt + telegram-chat.json (공용 — 여러 프로젝트가 같은 봇 공유) 또는 ~/.claude/ntfy-topic.txt`)
console.log(`4. 프로젝트 CLAUDE.md 에 낮/밤 리듬 4목적·무인 결정 규칙·커밋 가드 옵트인을 기록(SKILL.md 부록 참조)`)
console.log(`5. 리허설: node tools/auto/plan-queue.mjs --dry → node tools/auto/run-night.mjs --auto-plan --dry-run`)
if (notes.length) { console.log('\n── 점검 메모 ──'); for (const n of notes) console.log(n) }
