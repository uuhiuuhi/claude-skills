// fake-bmad-project.mjs — 진단기·백로그·종단 테스트가 공유하는 **실물 픽스처 생성기**.
//
// 왜 실물인가: 스텁 객체로 진단기를 먹이면 「정규식이 실제 jng-os 형식을 읽는가」를 영영 못 본다.
// 2026-08-30 실사고(굵은 `**[Review][Patch]**` 16건이 0으로 읽힘)·2026-08-31 실사고(미완 Task 줄의
// 👤 인용이 사람 게이트로 오판)는 전부 **표기 실물**에서만 재현된다. 그래서 이 생성기는
//   · 실제 임시 폴더에 실제 파일을 쓰고
//   · 실제 `git init` + `git commit` 으로 clean 워킹트리를 만들고
//   · jng-os 실측 형식(설계 §0)을 그대로 흉내낸다
//      - 에픽 헤더 `##`/`###` 혼재
//      - sprint-status 상단 **주석 수천 자** + 2칸 들여쓰기 + `epic-N:` 집계 행 혼재
//      - File List 한 줄에 백틱 경로 2개
//      - 굵은 `- [ ] **[Review][Patch][high] …`
//      - 고아 문서 `N-M-slug` (스토리 아님)
//      - `.only(` 이 문자열 리터럴 안 / `*guard*.test.*` 안
//
// 스토리 5개 상태 혼합(설계 §9-2 표):
//   | 키                | sprint       | 파일 Status  | 함정                         | 기대 verdict            |
//   |-------------------|--------------|--------------|------------------------------|-------------------------|
//   | 1-1-정상-스토리    | done         | done         | 없음                         | not-verified → verified-done(qa 주입 시) |
//   | 1-2-파일목록-부재  | done         | done         | File List 절 자체가 없음      | partial                 |
//   | 2-1-패치-열림      | in-progress  | in-progress  | 굵은 열린 Patch 2 + 미완 Task | partial                 |
//   | 2-2-결정-열림      | review       | review       | 열린 Decision 1 (Patch 0)     | blocked                 |
//   | 3-1-이관-골격      | (없음)       | (파일 없음)   | epics.md 에만 · 마이그레이션 신규 | missing              |
//
// 이 파일은 **테스트 픽스처**라 쓰기 API 를 쓴다(진단기 본체와 달리 앵커 대상이 아니다).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** 함정 스위치 — 전부 기본 on. 테스트가 하나씩 꺼서 「그 함정이 없으면 안 잡힌다」를 증명한다. */
export const TRAP_DEFAULTS = Object.freeze({
  orphanDoc: true, // N-M-slug 인데 스토리가 아닌 문서
  tempCode: true, // TODO/임시 구현
  onlyReal: true, // 진짜 it.only(
  onlyInString: true, // 문자열 리터럴 안의 '.only(' (가드 테스트가 자기 규칙을 인용)
  onlyInGuard: true, // *guard*.test.* 안의 .only(
  skipWithReason: true, // 사유 주석이 붙은 skip
  skipNoReason: true, // 맨 skip
  envSecret: true, // .env 안의 실제 형태 토큰
  secretInCode: true, // 소스에 박힌 sk- 키
  dbDrift: true, // DB-DRIFT 운영 적용 대기 1건
  statusDrift: false, // 6번째 스토리(Status 헤더 ≠ sprint) — 기본 off(5스토리 표 유지)
  trackedEnvProd: false, // .env.production 을 git 추적(tier 1)
  injectedSecrets: false, // package.json scripts · state.json · 과거 verification.json 에 토큰 심기(H1 회귀)
})

/** 스토리 5종의 sprint 키 — 파일명은 `<키>.md` 로 정확히 일치한다(jng-os 관례). */
export const FIXTURE_STORY_KEYS = Object.freeze({
  ok: '1-1-정상-스토리',
  noFileList: '1-2-파일목록-부재',
  openPatch: '2-1-패치-열림',
  openDecision: '2-2-결정-열림',
  epicsOnly: '3-1', // sprint 에 없다 — epics.md 의 `### Story 3.1:` 로만 존재
  drift: '1-3-상태-불일치', // statusDrift 함정을 켜야 생긴다
})

/** 시크릿 원문 — 테스트가 「스냅숏·진단 어디에도 없다」를 grep 으로 증명할 때 쓴다. */
export const FIXTURE_SECRETS = Object.freeze({
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ZmFrZS1zZXJ2aWNlLXJvbGU',
  apiKey: 'sk-fakefakefakefake0123456789abcd',
  codeKey: 'sk-inlinekeyinlinekey9876543210zz',
})

/** codex-review-r3 H1 회귀용 — 스냅숏이 **원문 객체 그대로** 담던 가지 세 곳에 심는 값.
 *  각각 R2 가 이미 고친 대표 형식(비인용 KEY=VALUE · Authorization 헤더 · JSON 키)을 쓴다. */
export const FIXTURE_INJECTED_SECRETS = Object.freeze({
  script: 'sk-scriptscriptscript0123456789',   // package.json scripts.deploy:staging
  header: 'TOKENVALUE123456',                   // state.json 안 로그 문장의 Authorization 헤더
  manifest: 'JSONSECRET123456',                 // 과거 verification.json 의 api_key 필드
})

const IMPL = '_bmad-output/implementation-artifacts'
const PLAN = '_bmad-output/planning-artifacts'
const LOGS = `${IMPL}/auto-pipeline-logs`

// ── 문서 본문 ────────────────────────────────────────────────────────────────

const epicsMd = () => `# 에픽 목록 (가짜 프로젝트 · 진단기 픽스처)

> 이 파일은 목록 SoT 다. 상태는 sprint-status.yaml 이 소유한다.

## Epic 1: 토대 — 로그인하고 기준정보를 한 곳에

에픽 1 은 앱이 서는 최소 골격이다.

### Story 1.1: 정상 스토리

**As a** 운영자, **I want** 목록을 본다, **so that** 오늘 할 일을 안다.

완료 기준: 목록이 뜨고 테스트가 있다.

### Story 1.2: 파일목록 부재

**As a** 운영자, **I want** 상세를 본다, **so that** 근거를 확인한다.

### Epic 2: 티켓 — 현장에서 기록이 완결된다

에픽 2 는 헤더 수준이 다르다(\`###\`) — 실제 jng-os 가 혼재한다.

### Story 2.1: 패치 열림

**As a** 엔지니어, **I want** 저장한다, **so that** 기록이 남는다.

### Story 2.2: 결정 열림

**As a** 팀장, **I want** 문구를 정한다, **so that** 고객이 헷갈리지 않는다.

## Epic 3: 이관 — 병행 평가를 시작한다

### Story 3.1: 이관 골격

**As a** 관리팀, **I want** 과거 기록을 옮긴다, **so that** 비교가 된다.

신규 마이그레이션 \`supabase/migrations/20260201000000_import_legacy.sql\` 과
\`src/features/import/importLogic.ts\` 가 필요하다. 결제·청구 축은 건드리지 않는다.
`

// sprint-status.yaml — 상단 주석이 길다(jng-os 는 수천 자). 주석 안에 스토리 키처럼 보이는
// 문자열을 일부러 넣어, 파서가 **2칸 들여쓰기 행만** 읽는지 확인한다.
const sprintYaml = (traps) => `# generated: 2026-01-01
# last_updated: 2026-09-02  (2-1 2026-09-02 **dev 3차 회수 라운드 → in-progress** — 2차 리뷰 열린 Patch 2/2 미회수.
#   전부 \`tests/feature/c.test.ts\` 2.1 구획(소스·마이그레이션 무수정): 저장 실패 문구 · 목록 정렬 안정성.
#   qa 파이프 없이 exit 0(3 files · 12 passed / 0 skipped) · Defer 1(신규 1·이월 0) · 이월 금지 5범주 해당 0 ·
#   적용 큐 무변화 · commit/push 0. ↓ 직전: 2-2 2026-09-01 **2차 적대 리뷰 → review** — Decision 1(문구 ·
#   사람 게이트) · Patch 0 · Defer 0 · 기각 2 · blocking 0. ↓ 직전: 1-2 2026-08-31 **dev 1차 완주 → done** —
#   File List 절을 적지 못한 채 종결(회수 대상). 이 주석 안의 "9-9-가짜-키: done" 같은 문자열은 스토리 행이
#   아니다 — 들여쓰기 0 이라 파서가 무시해야 한다.)

development_status:
  epic-1: done
  ${FIXTURE_STORY_KEYS.ok}: done  # 2026-08-30 dev 완주 · 리뷰 GREEN
  ${FIXTURE_STORY_KEYS.noFileList}: done  # 2026-08-31 dev 완주 · File List 미기재
${traps.statusDrift ? `  ${FIXTURE_STORY_KEYS.drift}: done  # 파일 Status 는 review 다(드리프트 함정)\n` : ''}  epic-2: in-progress
  ${FIXTURE_STORY_KEYS.openPatch}: in-progress  # 2차 리뷰 Patch 2 미회수
  ${FIXTURE_STORY_KEYS.openDecision}: review  # Decision 1 사람 대기
  epic-3: backlog
`

/** 스토리 md 본문 — jng-os 절 이름·순서를 그대로 따른다(설계 §0 표). */
function storyMd({ key, num, title, status, tasks, findings, fileList, notes = '구현 완료.' }) {
  const [epic, story] = key === '3-1' ? ['3', '1'] : [key.split('-')[0], key.split('-')[1]]
  return `---
baseline_commit: 0000000000000000000000000000000000000000
---

# Story ${epic}.${story}: ${title}

Status: ${status}

> **${num}차 라운드 기록** — 이 인용문은 판정 재료가 아니다.

## Story

**As a** 사용자, **I want** ${title}, **so that** 일이 끝난다.

## Acceptance Criteria

**AC-0 착수 선행 조건(Task 0 가드)**
**Then** 선행 스토리가 review 이상이어야 시작한다.

**AC-1 ${title}**
**When** 사용자가 화면을 열면
**Then** 목록이 뜬다 (FR-01)

## Tasks / Subtasks

${tasks}

### Review Findings

\`/bmad-code-review\` — ${num}라운드(2026-09-01 · 비대화형 · 3계층 병렬).

${findings}

## Dev Notes

이 스토리는 픽스처다.

### References

- \`${PLAN}/epics.md\` — Story ${epic}.${story}

## Dev Agent Record

### Agent Model Used

opus (dev) · fable (review)

### Debug Log References

qa 파이프 없이 exit 0(3 files · 12 passed / 0 skipped)

### Completion Notes List

- ${notes}

${fileList}
## Change Log

| 날짜 | 변경 |
|---|---|
| 2026-09-01 | ${num}차 라운드 |
`
}

const FILE_LIST_OK = `### File List

**신규 (2)**

- \`src/feature/a.ts\` · \`tests/feature/a.test.ts\`

**수정 (1)**

- \`src/lib/strings.ts\` (문구 1줄)

`

const FILE_LIST_PATCH = `### File List

**신규 (2)**

- \`src/feature/c.ts\` · \`tests/feature/c.test.ts\`

`

const FILE_LIST_DECISION = `### File List

**수정 (1)**

- \`src/feature/d.ts\`

`

// ── 코드·설정 본문 ───────────────────────────────────────────────────────────

const SRC = {
  'src/feature/a.ts': `export const listA = (rows: string[]): string[] => rows.filter(Boolean).sort()\n`,
  'src/feature/b.ts': `export const listB = (rows: string[]): number => rows.length\n`,
  'src/feature/d.ts': `export const labelD = (n: number): string => (n > 0 ? '진행' : '대기')\n`,
}

/** `.only(` 이 **문자열 리터럴 안**에 있는 소스 — 가드가 자기 금지 규칙을 인용하는 실제 패턴. */
const STRINGS_TS_QUOTED_ONLY = `// 가드 테스트가 인용하는 규칙 문자열 — 실제 코드가 아니다.\nexport const BANNED_TEST_PATTERNS = ['it.only(', 'describe.only(']\nexport const trim = (s: string): string => s.trim()\n`
const STRINGS_TS_PLAIN = `export const BANNED_TEST_PATTERNS: string[] = []\nexport const trim = (s: string): string => s.trim()\n`

const TEST_FILES = {
  'tests/feature/a.test.ts': `import { describe, it, expect } from 'vitest'\nimport { listA } from '../../src/feature/a'\ndescribe('listA', () => { it('정렬한다', () => { expect(listA(['b', 'a'])).toEqual(['a', 'b']) }) })\n`,
  'tests/feature/c.test.ts': `import { describe, it, expect } from 'vitest'\ndescribe('c', () => { it('저장한다', () => { expect(1 + 1).toBe(2) }) })\n`,
  'tests/feature/d.test.ts': `import { describe, it, expect } from 'vitest'\nimport { labelD } from '../../src/feature/d'\ndescribe('labelD', () => { it('라벨', () => { expect(labelD(1)).toBe('진행') }) })\n`,
  'tests/lib/strings.test.ts': `import { describe, it, expect } from 'vitest'\nimport { trim } from '../../src/lib/strings'\ndescribe('trim', () => { it('공백 제거', () => { expect(trim(' a ')).toBe('a') }) })\n`,
}

const PKG = {
  name: 'fake-bmad-project',
  private: true,
  type: 'module',
  scripts: {
    dev: 'vite',
    build: 'tsc -b && vite build',
    typecheck: 'tsc -b --noEmit',
    lint: 'eslint . --max-warnings=0',
    test: 'vitest run',
    qa: 'npm run typecheck && npm run lint && npm run test',
    'deploy:prod': 'npm run qa && node tools/deploy/preflight.mjs production && vite build && wrangler deploy --env production',
  },
}

const WRANGLER = `{
  "name": "fake-bmad-project",
  "compatibility_date": "2026-01-01",
  "assets": { "directory": "./dist" },
  "env": { "dev": { "name": "fake-dev" }, "production": { "name": "fake-prod" } }
}
`

const dbDriftMd = (pending) => `# DB 드리프트 원장 — 개발 ↔ 운영

> 핵심 규칙: 스탬프로는 판별할 수 없다 — 객체 실측만 진실이다.

## 1. 운영 적용 대기 — **${pending}건** (2026-09-01 실측 재판정)

${pending > 0 ? '- `supabase/migrations/20260201000000_import_legacy.sql` — 3.1 신규 · 운영 미적용\n' : '- 없음\n'}
`

const INBOX = `# 결정 인박스 (상시)

## ✅ 확정 — 1-1 목록 정렬 기준 (2026-08-30 확정)

→ ✅ 2026-08-30 확정 ⓐ — 이름 오름차순

## 🟠 남은 사람 판단 1건 — 2-2 문구

### ① 🟠 저장 실패 문구를 어떻게 보여 줄까 (medium)

- ⓐ "잠시 후 다시 시도해 주세요" (추천)
- ⓑ 원인까지 적는다
`

const DEFERRED = `# Deferred Work

코드 리뷰에서 "실재하지만 지금 처리하지 않는다"로 판정된 항목.

## Deferred from: code review of 2-1-패치-열림 (2026-09-01 · 2차 라운드)

- **[2.1][Defer] 목록 가상화가 없다** — 행 1만 건에서 느려진다 [\`src/feature/c.ts:40\`]. **소유: 목록을 다음에 만질 라운드**
`

// ── 생성기 ───────────────────────────────────────────────────────────────────

const gitArgs = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false']

/**
 * 실제 임시 폴더에 가짜 BMAD 프로젝트를 만든다.
 * @param {{dir?:string, traps?:object, git?:boolean}} opts
 * @returns {{root:string, traps:object, cleanup:()=>void, porcelain:()=>string, git:(argv:string[])=>object, storyPath:(key:string)=>string, write:(rel:string,text:string)=>void, read:(rel:string)=>string, keys:object, secrets:object}}
 */
export function createFakeProject(opts = {}) {
  const traps = { ...TRAP_DEFAULTS, ...(opts.traps ?? {}) }
  const root = opts.dir ?? mkdtempSync(join(tmpdir(), 'bmad-fx-'))
  const write = (rel, text) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text, 'utf8')
  }
  const read = (rel) => readFileSync(join(root, rel), 'utf8')

  // 1) 계획·상태 문서
  write(`${PLAN}/epics.md`, epicsMd())
  write(`${IMPL}/sprint-status.yaml`, sprintYaml(traps))
  write(`${IMPL}/DECISIONS-INBOX.md`, INBOX)
  write(`${IMPL}/deferred-work.md`, DEFERRED)
  write(`${IMPL}/DB-DRIFT-LEDGER.md`, dbDriftMd(traps.dbDrift ? 1 : 0))

  // 2) 스토리 5종
  write(
    `${IMPL}/${FIXTURE_STORY_KEYS.ok}.md`,
    storyMd({
      key: FIXTURE_STORY_KEYS.ok,
      num: 2,
      title: '정상 스토리',
      status: 'done',
      tasks: '- [x] Task 1 목록 구현\n- [x] Task 2 회귀 테스트',
      findings:
        '- [x] [Review][Patch] ~~목록 정렬이 불안정하다~~ — ✅ 해소(2026-08-30 · Task 1)\n- [x] [Review][Defer] ⏭️ 가상화는 다음 라운드',
      fileList: FILE_LIST_OK,
    }),
  )
  write(
    `${IMPL}/${FIXTURE_STORY_KEYS.noFileList}.md`,
    storyMd({
      key: FIXTURE_STORY_KEYS.noFileList,
      num: 1,
      title: '파일목록 부재',
      status: 'done',
      tasks: '- [x] Task 1 상세 구현',
      findings: '**Dismiss 2건**(조치 불필요 — 근거만 기록)',
      fileList: '', // ← File List 절 자체가 없다(함정)
      notes: 'File List 를 적지 못한 채 종결했다.',
    }),
  )
  write(
    `${IMPL}/${FIXTURE_STORY_KEYS.openPatch}.md`,
    storyMd({
      key: FIXTURE_STORY_KEYS.openPatch,
      num: 2,
      title: '패치 열림',
      status: 'in-progress',
      tasks:
        '- [x] Task 1 저장 구현\n- [ ] Task 2 2차 리뷰 Patch 회수\n- [ ] 👤 박사장 승인 대기 — 문구 최종확정',
      findings:
        '- [ ] **[Review][Patch][high] 저장 실패 시 문구가 안 뜬다** [src/feature/c.ts:12]\n- [ ] **[Review][Patch][medium] 목록 정렬이 흔들린다** [src/feature/c.ts:40]\n- [x] [Review][Defer] ⏭️ 가상화는 이월',
      fileList: FILE_LIST_PATCH,
      notes: '2차 리뷰 Patch 2건 미회수.',
    }),
  )
  write(
    `${IMPL}/${FIXTURE_STORY_KEYS.openDecision}.md`,
    storyMd({
      key: FIXTURE_STORY_KEYS.openDecision,
      num: 2,
      title: '결정 열림',
      status: 'review',
      tasks: '- [x] Task 1 화면 구현\n- [x] Task 2 테스트',
      findings:
        '- [ ] [Review][Decision] 저장 실패 문구를 ⓐ/ⓑ 중 어느 쪽으로 할지 사람 판단이 필요하다 [src/feature/d.ts:8]',
      fileList: FILE_LIST_DECISION,
      notes: 'Decision 1건 사람 대기.',
    }),
  )
  if (traps.statusDrift) {
    write(
      `${IMPL}/${FIXTURE_STORY_KEYS.drift}.md`,
      storyMd({
        key: FIXTURE_STORY_KEYS.drift,
        num: 1,
        title: '상태 불일치',
        status: 'review', // sprint 는 done
        tasks: '- [x] Task 1',
        findings: '**Dismiss 1건**',
        fileList: FILE_LIST_OK,
      }),
    )
  }

  // 3) 고아 문서 — `N-M-slug` 형태지만 sprint 키가 아니다
  if (traps.orphanDoc) {
    write(`${IMPL}/1-9-관리팀-질의서-2026-09-02.md`, '# 1-9 관리팀 질의서\n\n스토리가 아니다 — 회신 대기 문서.\n')
  }

  // 4) 소스·테스트
  for (const [p, t] of Object.entries(SRC)) write(p, t)
  write('src/lib/strings.ts', traps.onlyInString ? STRINGS_TS_QUOTED_ONLY : STRINGS_TS_PLAIN)
  write(
    'src/feature/c.ts',
    traps.tempCode
      ? `// TODO: 임시 구현 — 나중에 고침(저장 실패 문구 미반영)\nexport const saveC = (v: string): string => v\n`
      : `export const saveC = (v: string): string => v\n`,
  )
  if (traps.secretInCode) write('src/lib/config.ts', `export const LEGACY_KEY = '${FIXTURE_SECRETS.codeKey}'\n`)
  for (const [p, t] of Object.entries(TEST_FILES)) write(p, t)
  if (traps.onlyReal) {
    write(
      'tests/feature/b.test.ts',
      `import { describe, it, expect } from 'vitest'\nimport { listB } from '../../src/feature/b'\ndescribe('listB', () => {\n  it.only('길이', () => { expect(listB(['a'])).toBe(1) })\n})\n`,
    )
  }
  if (traps.onlyInGuard) {
    write(
      'tests/db/story-guard.test.ts',
      `import { describe, it, expect } from 'vitest'\n// 가드: 저장소 전체에 it.only( 가 없어야 한다\ndescribe('guard', () => { it('only 금지', () => { expect(true).toBe(true) }) })\n`,
    )
  }
  if (traps.onlyInString) {
    write(
      'tests/feature/lint-rule.test.ts',
      `import { describe, it, expect } from 'vitest'\nimport { BANNED_TEST_PATTERNS } from '../../src/lib/strings'\ndescribe('rule', () => { it('목록', () => { expect(BANNED_TEST_PATTERNS).toContain('it.only(') }) })\n`,
    )
  }
  if (traps.skipWithReason) {
    write(
      'tests/feature/skip-reason.test.ts',
      `import { describe, it, expect } from 'vitest'\ndescribe('skip', () => {\n  // 사유: 운영 DB 연결이 필요해 CI 에서만 돌린다(2026-09-01 확정)\n  it.skip('DB 연결', () => { expect(1).toBe(1) })\n})\n`,
    )
  }
  if (traps.skipNoReason) {
    write(
      'tests/feature/skip-bare.test.ts',
      `import { describe, it, expect } from 'vitest'\ndescribe('skip', () => {\n  it.skip('미정', () => { expect(1).toBe(1) })\n})\n`,
    )
  }

  // 5) 설정·배포·DB
  const pkg = traps.injectedSecrets
    ? { ...PKG, scripts: { ...PKG.scripts, 'deploy:staging': `OPENAI_API_KEY=${FIXTURE_INJECTED_SECRETS.script} vite build` } }
    : PKG
  write('package.json', JSON.stringify(pkg, null, 2) + '\n')
  write('wrangler.jsonc', WRANGLER)
  write('tools/deploy/preflight.mjs', `console.log('preflight ok')\n`)
  write('supabase/migrations/20260101000000_init.sql', 'create table t (id uuid primary key);\n')
  write('supabase/migrations/20260115000000_policies.sql', 'create policy p on t for select using (true);\n')
  write('.env.example', 'VITE_API_URL=\n')
  if (traps.envSecret) write('.env', `SUPABASE_SERVICE_ROLE=${FIXTURE_SECRETS.jwt}\nOPENAI_API_KEY=${FIXTURE_SECRETS.apiKey}\n`)
  if (traps.trackedEnvProd) write('.env.production', `OPENAI_API_KEY=${FIXTURE_SECRETS.apiKey}\n`)

  // 6) 엔진 로그·상태
  const state = { done: { [`${FIXTURE_STORY_KEYS.ok}::dev`]: '2026-08-30T10:00:00.000Z' } }
  if (traps.injectedSecrets) state.lastError = `POST /rpc 실패 — Authorization: Bearer ${FIXTURE_INJECTED_SECRETS.header}`
  write(`${LOGS}/state.json`, JSON.stringify(state, null, 2) + '\n')
  write(`${LOGS}/${FIXTURE_STORY_KEYS.ok}-dev.log`, 'dev 완주\nqa exit 0\n')
  const verification = { schema: 'auto-story-finish/verification/1', story: FIXTURE_STORY_KEYS.ok, qa: { exit: 0 } }
  if (traps.injectedSecrets) verification.env = { api_key: FIXTURE_INJECTED_SECRETS.manifest }
  write(`${LOGS}/${FIXTURE_STORY_KEYS.ok}-verification.json`, JSON.stringify(verification, null, 2) + '\n')

  // 7) git — `.env` 는 추적하지 않는다(`.env.production` 함정만 예외)
  write('.gitignore', traps.trackedEnvProd ? 'node_modules/\n.env\n' : 'node_modules/\n.env\n.env.production\n')

  const git = (argv) => spawnSync('git', [...gitArgs, '-C', root, ...argv], { encoding: 'utf8', shell: false })
  if (opts.git !== false) {
    spawnSync('git', [...gitArgs, 'init', '-q', '-b', 'main', root], { encoding: 'utf8', shell: false })
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'fixture: 초기 상태'])
  }

  return {
    root,
    traps,
    keys: FIXTURE_STORY_KEYS,
    secrets: FIXTURE_SECRETS,
    git,
    write,
    read,
    storyPath: (key) => join(root, IMPL, `${key}.md`),
    porcelain: () => git(['status', '--porcelain']).stdout ?? '',
    cleanup: () => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }) },
  }
}

export const FIXTURE_PATHS = Object.freeze({ IMPL, PLAN, LOGS })
