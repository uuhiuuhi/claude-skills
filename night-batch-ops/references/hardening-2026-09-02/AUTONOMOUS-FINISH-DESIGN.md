# 자율 마무리(Autonomous Finish) — 구현 설계서 (2026-09-02 · 설계 워커 산출 · 지휘 저장)

- 요구 SoT: `night-batch-ops/references/hardening-2026-09-02/AUTONOMOUS-FINISH-SPEC.md` (10절 전부 대응 · 절 번호 = 이 문서 절 번호)
- 코드 맥락: `night-batch-ops/references/multi-provider-design.md` · 두 스킬 `SKILL.md` · F1 신규(`plan-dag`·`orchestrate`·`assign`·`conflicts`) · R/P/E/F2 워커 수정본
- 실측 대상: `C:\Projects\jng-os` (BaroOS · **읽기만 함** · 2026-09-02 실측치를 본문에 인용)
- 원칙: **기존 파일은 거의 손대지 않는다.** 신규 모듈 8개 + 진입점 1개(신규 CLI)로 얹고, `run-night.mjs`·`auto-story-pipeline.mjs`·`plan-queue.mjs` 는 **자식 프로세스로 호출**하거나 **선택 훅 3~5줄**만 받는다.

---

## 0. jng-os 실측 요약 (진단기가 읽을 실제 경로·형식)

| 무엇 | 실제 경로 | 실측(2026-09-02) |
|---|---|---|
| 에픽 목록 SoT | `_bmad-output/planning-artifacts/epics.md` | `### Story 11.3: …` 형식 **83절** · 에픽 헤더는 `## Epic 2: …`/`### Epic 3: …` **혼재** → 헤더 정규식은 `^#{2,3} Epic (\d+):` |
| 스토리 상태 SoT | `_bmad-output/implementation-artifacts/sprint-status.yaml` | 상단 `generated:`/`last_updated:`(주석이 수천 자) → `development_status:` 아래 **2칸 들여쓰기** `  11-3-계약-목록-…: in-progress  # 주석`. 스토리 행 **84건** = `backlog 25 / ready-for-dev 1 / in-progress 24 / review 15 / done 19`. `epic-1: done` 같은 **에픽 집계 행**도 같은 들여쓰기 → `story-ledger.parseSprint` 의 `^ {2}(\d+-\d+…)` 가 걸러낸다 |
| 스토리 md | `_bmad-output/implementation-artifacts/<epic>-<num>-<slug>.md` | 96개 `.md` 중 스토리 파일은 sprint 키와 정확히 일치하는 것만. **함정 실물**: `11-5-관리팀-질의서-2026-09-02.md` 는 `N-M-slug` 형태지만 스토리가 아니다 → **고아 문서**로만 경고 |
| 스토리 절 이름 | (11-3 실측) | frontmatter `baseline_commit:` → `# Story 11.3: …` → `Status: in-progress` → `## Story` → `## Acceptance Criteria`(`**AC-0 …**`/`**When**`/`**Then**`) → `## Tasks / Subtasks` → `### Review Findings` → `### 회수 라운드 개설 (…)` → `## Dev Notes` → `### References` → `## Dev Agent Record` → `### Agent Model Used` → `### Debug Log References …` → `### Completion Notes List` → `### 사람 게이트 (AC-6)` → `### File List` → `## Change Log` |
| 원장 줄 형식 | `### Review Findings` | `- [ ] [Review][Patch] …[경로:줄]` · `- [x] [Review][Decision] ~~취소선~~ — ✅ 해소(날짜 · 근거)` · `- [x] [Review][Defer] ⏭️ …` · `**Dismiss 8건**(조치 불필요 — 근거만 기록)` |
| File List 형식 | `### File List` | `**신규 (9)**` / `**수정 (20)**` / `**문서 (4)**` 소제목 + `` - `경로` `` 불릿. **한 줄에 백틱 경로 2~5개** → `matchAll` 필수(`story-ledger.readStorySignals` 가 이미 그렇게 읽는다) |
| 결정 인박스 | `…/DECISIONS-INBOX.md` | `# 결정 인박스 (상시)` + `## ✅ 확정 — …` / `## 🟠 남은 사람 판단 1건 — …` / `### ① 🟠 …(medium)` · 선택지 `ⓐ/ⓑ/ⓒ` + `→ ✅ 2026-09-02 확정 ⓒ — …` |
| 이월 원장 | `…/deferred-work.md` | `## Deferred from: code review of <스토리키> (날짜 · N차 라운드)` + `- **[2.15][Defer] 제목** — 본문 [경로:줄]` |
| 배포 차단 원장 | `…/DB-DRIFT-LEDGER.md` | `## 1. 운영 적용 대기 — **1건** (2026-08-28 실측 재판정)` · 「스탬프로는 판별 불가 · 객체 실측만 진실」 |
| 엔진 로그 | `…/auto-pipeline-logs/` | **641개** · `<story>-{create,dev,qa,review}.log` · `state.json`(`{"done":{"<story>::dev":"ISO"}}`) · `night-last-run.md` · `<story>-verification.json`(v3 신규 · 이 프로젝트엔 아직 없음) |
| 원장 해석기 | `tools/lib/story-ledger.mjs` | 스킬 `engine/story-ledger.mjs` 의 **구버전 복사본**. 진단기는 **스킬 쪽 모듈을 import**, 프로젝트 복사본은 「설치본 낡음」으로만 진단 |
| 게이트 | `package.json` scripts | `qa = npm run typecheck && npm run lint && npm run test` · `build = tsc -b && vite build` · `test = vitest run` · `deploy:dev/prod = npm run qa && node tools/deploy/preflight.mjs <env> && vite build && wrangler deploy --env …`. **coverage·e2e·security·performance 스크립트 없음** → 매니페스트 `n/a(사유)` |
| 배포 설정 | `wrangler.jsonc` | assets-only(`main` 없음) · env `dev`/`production` · `preview_urls:false` · 배포는 사람 |
| DB | `supabase/migrations/` | **118 파일** |
| 코드·테스트 | `src`/`tests` | src `.ts/.tsx` **230**, 테스트 파일 **214**, `tests/*` 23개 도메인 폴더. 임시코드 후보 **17건**, `.skip(`류 **230건**, `.only(` **3건**(가드 테스트의 문자열 리터럴 포함 가능성 → 별도 판정) |
| git | — | 브랜치 `main` · 워킹트리 사실상 clean(미추적 1: `.review-tmp/…`) |
| 문서 증거(실행 아님) | sprint-status·스토리 md | `qa 파이프 없이 exit 0(215 files · 6,147 passed / 81 skipped)` 형식 반복 → **rank 4 문서 증거**로만 채택 |

---

## 1. 모듈 배치표

신규 파일은 전부 **`night-batch-ops/engine/`** 아래(+ auto-story-finish 1개). ESM · Node 20+ · LF · UTF-8.

| 모듈 | 역할 | 순수/부수효과 | 재사용 |
|---|---|---|---|
| `diagnose.mjs` | 프로젝트 스냅숏 수집 + 진단 판정 | `readProject`/`runGateProbe` = **읽기 IO**(쓰기 0) · 나머지 순수 | `story-ledger.*` · `runner-rules.parseFileList` · `quality-rules.{detectGates,parseQaChain,classifyQaFailure,testIntegrityFindings}` |
| `backlog.mjs` | 작업항목화 + 7단계 우선순위 + 보수 범주 + 실패 6분류 | 순수 | `assign.{storyRisk,storyDifficulty}` · `conflicts.{parallelHazardsExtended,CONFLICT_RULES}` |
| `bmad-sync.mjs` | 스토리 매핑 · 신규 스토리/결함 생성 · 완료 기록 반영 | `plan*`/`render*` 순수 · `applyBmadWrites` = **쓰기 IO(유일)** | `story-writes.*` · `story-ledger.{parseSprint,epicSection}` |
| `readiness.mjs` | 작업 8조건 · 프로젝트 8조건 판정표 | 순수 | `quality-rules.{MANIFEST_SCHEMA,qaSubchecks}` · `metrics.summarizeTimeline` 결과 |
| `decisions.mjs` | 질문 8범주 판별 · 비개발자 질문 렌더 · 인박스 연동 | 순수(쓰기는 bmad-sync) | `story-writes.appendDecisionsInbox` |
| `report.mjs` | 비개발자 보고서(10절 항목) | 순수 | `metrics.{renderMetricsTable,compareRuns}` |
| `autofinish.mjs` | 진입 CLI 루프 + 라운드 통제 | **부수효과 집중부**(spawn · 파일 쓰기 · state) | 위 전부 + `plan-dag`·`orchestrate`·`assign`·`conflicts`·`metrics` |
| `../auto-story-finish/completion-rules.mjs` | 완료 기준 강화 + BMAD 기록 훅(순수) | 순수 | `quality-rules.*` · `story-writes.*` |

**기존 파일 배선(최소)**
1. `auto-story-pipeline.mjs` — `finalizeManifest()` 끝에 3줄: `manifest.completion = strengthenCompletion({manifest, storyText, diff})`. 없으면 `readiness` 가 `not-verified` 판정(기능 손실 없음).
2. `run-night.mjs` — **수정 0.** `autofinish.mjs` 가 큐 JSON 을 만들고 `node <engine>/run-night.mjs --queue <path>` 를 spawn(기존 CLI 계약 그대로).
3. `metrics.mjs` — §8 확장점 3개만(없으면 `report.mjs` 자체 계산 폴백).

### 1-1. `diagnose.mjs`
```js
export const SNAPSHOT_SCHEMA  = 'night-batch-ops/snapshot/1'
export const DIAGNOSIS_SCHEMA = 'night-batch-ops/diagnosis/1'
export function readProject(root, { config = null, maxLogBytes = 262144, now = new Date() } = {}): Snapshot   // 읽기 IO · 쓰기 API import 금지(앵커 테스트)
export function diagnose(snapshot, { gates = {}, prevDiagnosis = null } = {}): Diagnosis                    // 순수 · 실행 0
export function evidenceRank(kind): 1|2|3|4|5           // 'gate'|'test'|'code'|'story'|'plan'
export function classifyStoryCompletion(story, snapshot, gates): { verdict, confidence, evidence[], gaps[] }
export function detectTempCode(files) · detectDisabledTests(files) · detectDeployBlockers(snapshot) · detectDocMismatch(snapshot) · detectSecurityRisks(snapshot): Finding[]
export function runGateProbe({ root, name, script, exec = spawnSync, timeoutMs = 20*60_000, env, logDir = null, now }): GateResult   // IO · spawn 주입
```
`Snapshot` 주요 필드: `schema, at, root, config{epicOrder,dailyCap,parallel,mockupGate,providers}, scripts{qa,build,test,chain[],missing[]}, sprint[{key,status,epic,line,note}], epicHeaders[], epicSections{}, stories[{key,path,hash,bytes,mtime,baselineCommit,statusInFile,statusInSprint,sections{},acIds[],signals{openDecision,openPatches,banPresent,unfinishedTasks,files[]},fileList{declared,missing,untested},qaClaims[]}], orphanStoryDocs[], git{branch,head,dirty[],protected,recent[]}, ledgers{inbox,deferred,dbDrift}, manifests{}, engineState{}, code{srcCount,testCount,tempCode[],disabledTests[],onlyHits[]}, deploy{migrations,wrangler,preflight,envFiles[]}`.

`Diagnosis`: `schema, at, round, gates{qa:{exit,ms,source,log},build}, stories[{key,declared,verdict,confidence,evidence[{rank,kind,what}],gaps[{code,n}]}], findings[{id,kind,severity,tier,path,story,why,evidence[],userImpact}], counts{storiesTotal,declaredDone,verifiedDone,partial,missing,findings{1..7}}, notVerified[{what,why}]`.
`verdict` = `verified-done | partial | missing | defect | test-gap | blocked | not-verified`.

#### 1-1-a. 확정본 (워커 A 구현 · 2026-09-03 · **B·C·D 는 이것을 보고 만든다**)
위 스키마는 **상위 호환으로만** 늘었다(기존 필드 이름·의미 불변). 추가·확정된 것:
- `Snapshot` **추가**: `paths`(해석에 쓴 경로 표 — 프로젝트별 덮어쓰기 가능) · `epicStories[{id,epic,num,title,line}]`(epics.md 의 `### Story N.M` 전량) · `epicOnly[{id,epic,num,title,line,section,files[],origin:'epics'}]`(sprint 에 없는 것만) · `security{valueHits[{path,line,pattern,masked}],envValueHits[],pathHits[]}` · `lastRun` · `installedParser{path,bytes}|null` · `code.{scanned,testPaths[]}` · `git.enabled`.
- `Snapshot.stories[].` **추가**: `id`('11-3') · `epic` · `exists` · `fileList.sectionPresent`(File List **절**의 유무 — `declared` 가 비었다는 것과 다르다) · `origin`.
- `Diagnosis` **추가**: `root` · `fingerprint`(findings 지문 집합의 sha — 무진전 판정 열쇠) · `progress{prevCritical,critical,delta}`(prevDiagnosis 준 경우) · `counts.{epicOnly,blocked,defect,notVerified,findingsTotal}` · `stories[].{id,epic,origin,path}`.
- `Diagnosis.findings[].` **추가**: `fingerprint`(안정 지문) · `line` · `snippet`(마스킹된 발췌).
- **추가 export**(diagnose.mjs): `DEFAULT_PATHS` · `EVIDENCE_RANKS` · `FINDING_TIER`/`tierOfFinding(f)`(kind→tier **배타** 표 — backlog 가 이것을 재사용한다) · `maskSecrets(text)` · `lineContextAt(line,idx)` · `hasTestFor(path,testPaths)` · `sectionOfStory(epicsText,id,epicStories,epicHeaders)` · `npmInvocation(script)` · `assertNoShellMeta(label,value)` · `SHELL_META_RE` · 정규식 SoT(`TEMP_CODE_RE`·`TEMP_CODE_MARKER_RE`·`TEMP_CODE_KO_RE`·`TEMP_CODE_WEAK_RE`·`SKIP_RE`·`ONLY_RE`·`SECRET_PATH_RE`·`SECRET_PATH_EXAMPLE_RE`·`SECRET_VALUE_RE`·`SECRET_ASSIGN_RE`·`EPIC_HEADER_RE`·`EPIC_STORY_RE`·`STORY_DOC_RE`).
- `runGateProbe` 반환: `{name,script,cmd,available,exit,ms,timedOut,source:'gate',log,logPath,failure,why}`. **로그 파일은 쓰지 않는다** — `logPath` 는 호출부(autofinish)가 쓸 권장 경로다. 타임아웃은 `exit 124`. Windows 는 `cmd.exe /d /s /c npm run <script>` 로 **argv 분리**해 간다(셸 문자열 결합 없음 · 메타문자 거부).

**§2-2 휴리스틱 실측 교정(jng-os 2026-09-02 · 오탐이 진짜를 덮었다 — 전부 테스트로 고정)**
1. **임시 코드 3분할** — 원문 그물(`TEMP_CODE_RE`)만 쓰면 143건 중 143건이 오탐이었다(`placeholder=` JSX 속성 65건 · 소문자 `todo` 객체 키·CSS 클래스·상태값). 판정은 ① `TEMP_CODE_MARKER_RE`(**대문자** TODO/FIXME/HACK/XXX) ② `TEMP_CODE_KO_RE`(임시 구현·처리·값·코드 / 나중에 고침·구현) ③ `TEMP_CODE_WEAK_RE`(placeholder·dummy)는 **주석 안일 때만**. 교정 후 143 → **5건**.
2. **`service_role` 은 단독 낱말이면 비밀이 아니다** — Postgres 역할 이름이라 정책·주석·테스트 문장에 흔하다. 값 히트 120건 중 **119건이 오탐**이었고 전부 tier 1 로 올라가 진짜 1건을 덮었다. `SECRET_ASSIGN_RE`(값이 붙은 대입 형태)일 때만 비밀로 친다. `maskSecrets` 도 같은 기준(낱말은 안 지운다 — 지우면 로그가 안 읽힌다).
3. **미추적 `.env*` 의 값은 findings 가 아니다** — 비밀은 거기 있는 것이 정상이다(모든 개발자 PC 에 있다). 위험은 ① 코드에 박히거나 ② git 에 **추적**되는 것. 미추적 분은 `security.envValueHits` 로 집계만 남긴다(안 그러면 P2 가 영원히 fail).
4. **`.env.example`·`.sample`·`.template` 면제**(`SECRET_PATH_EXAMPLE_RE`) — 이름만 적는 공개 견본이라 추적이 정상이다(프로젝트 규약 5). 값이 들어가면 `secret-value` 로 따로 걸린다.
5. **epics.md 의 마지막 스토리 절** — `story-ledger.epicSection` 은 종결 헤더가 없으면 빈 문자열을 준다(마지막 스토리만 통째로 안 읽힌다). `sectionOfStory` 가 줄 번호로 보강한다.
6. **D2 의 「File List 부재」는 두 갈래** — 절 자체가 없음(`sectionPresent:false`) / 선언 파일이 실재하지 않음(`missing[]`). 둘 다 `partial`, gap 코드는 각각 `file-list-missing`·`file-list-file-missing`.
7. **D7 은 스토리 md 가 있을 때만** — 파일이 없으면 `statusInFile` 이 null 이라 D7 이 D8 보다 먼저 걸린다. `exists` 를 먼저 본다.
8. `temp-code` 의 tier 1 승격은 `SECRET_PATH_RE` 경로만(초안의 `auth|security/` 승격은 LoginPage 의 TODO 를 tier 1 로 올려 폐기).

### 1-2. `backlog.mjs`
```js
export const TIERS = [ {tier:1,id:'secret-data-auth'}, {2,'build-run'}, {3,'deploy-block'}, {4,'core-flow'}, {5,'regression-test'}, {6,'perf-a11y'}, {7,'internal-docs'} ]  // label 한국어
export const CONSERVATIVE_RULES  // conflicts.CONFLICT_RULES 에 얹는 mode:'any' 6종(§4-2)
export function hazardOptsFor(items): { rules, shared }
export function priorityOf(finding, ctx): { tier, score, why }
export function toWorkItems(diagnosis, snapshot): WorkItem[]
export function buildBacklog({ diagnosis, snapshot, config }): Backlog
export function mergeBacklog(prev, next): Backlog              // id 안정 · 해소분 closed
export function selectRunnable(backlog, { cap, blocked, doneKeys }): WorkItem[]
export function classifyFailure({ stage, exit, qaLog, manifest, gate }): { kind:'env'|'code'|'test'|'security'|'performance'|'integration', scope, signature }
```
`WorkItem`(SPEC §2 12항목 1:1): `id, fingerprint, title, purpose, userImpact, epic, story, storyLink('existing'|'new'|'defect'), acceptance[], tier, score, risk, riskFlags[], difficulty, deps[], parallelOk, conflictReasons[], gates[], tests[], assignee{dev,review}, source{finding,evidenceRank}, state`.
`Backlog` = `{ schema, at, round, items[], byTier{}, blocked[{key,why}], questions[], fingerprint }`.

#### 1-2-a. 확정본 (워커 A 구현 · 2026-09-03)
- **시그니처 변경 1건**: `toWorkItems(diagnosis, snapshot, { config = null } = {})` — 3번째 인자 추가(제공자 배정에 `auto.config.json` 의 `providers` 가 필요하다. 없으면 `snapshot.config` 폴백 → 그래도 없으면 claude 단독). `buildBacklog({ diagnosis, snapshot, config, round })` 에 `round` 추가.
- `WorkItem` **추가**: `files[]`(병렬 판정에 쓴 경로) · `why`(우선순위 사유 한 줄) · `autoFixAllowed`(이월 금지 5범주면 false — 무인 수리 금지) · `firstSeenRound`(mergeBacklog 가 붙임).
- `Backlog` **추가**: `counts{total,open,blocked,parallelOk}`; `mergeBacklog` 결과에 `closed[]`(지난 라운드에 있었는데 사라진 항목 — 「해소」로 남긴다) + `counts.{closed,carried}`.
- `classifyFailure` 반환 **추가**: `retry`(자동 수리 허용) · `action`(처방 한 줄) · `excerpt`(마스킹된 발췌). `signature` 는 `quality-rules.classifyQaFailure` 의 정의를 그대로 써 **줄·열 번호를 넣지 않는다**(같은 원인 반복을 세는 열쇠라서).
- **추가 export**: `BACKLOG_SCHEMA`('night-batch-ops/backlog/1') · `tierLabel(t)` · `NO_AUTO_FIX_KINDS` · `FAILURE_KINDS` · `ENV_EXITS`([2,5,6]).
- `CONSERVATIVE_RULES` 6종 id 확정: `secret-external · auth-permission · billing-payment · db-change · deploy-config · shared-core`(전부 `mode:'any'`). `hazardOptsFor` 는 `conflicts.CONFLICT_RULES` 중 **`migration` 을 뺀다** — `db-change` 가 같은 사유를 더 세게(any) 흡수하므로 두 번 세지 않는다.
- **배정 규칙**: dev = opus 기본(P0-①), tier≤2 이거나 risk≥`assign.HIGH_RISK_MIN` 이면 무조건 opus; 쉽고(difficulty≤3) 위험 낮은 것만 codex. review 는 **항상 dev 와 다른 제공자**(codex 없으면 claude/fable — 모델이라도 다르다).

### 1-3. `bmad-sync.mjs`
```js
export function mapToStories({ items, snapshot }): { mapped[], newStories[], defects[], unmappable[] }
export function nextStoryNumber(epic, snapshot): number         // sprint ∪ epics ∪ md 파일 max+1
export function storyKeyFor({ epic, num, title }): string
export function renderNewStory(spec) · renderDefectBlock(spec) · renderEpicsEntry(spec) · renderSprintEntry(key,status,note) · renderCompletionRecord(spec)
export function planBmadWrites({ mapping, snapshot, config }): BmadWritePlan   // 순수
export function applyBmadWrites(plan, { root, now, fs }): ApplyResult          // 유일한 쓰기 IO
export const APPEND_ONLY_ANCHORS = ['### Review Findings','### Completion Notes List','### Debug Log References','### File List','## Change Log','### 회수 라운드 개설']
```
`BmadWritePlan.writes[]` op 4종: `create-file{path,body,ifAbsent}` · `insert-after-heading{path,anchor,anchorOccurrence,body,baseHash}` · `upsert-sprint-key{path,key,value,after,comment,baseHash}` · `append-within-section{path,anchor,body,baseHash,sectionHash}`. `guards{allowedPathPrefixes:['_bmad-output/'], maxNewStories:3, maxWritesPerRound:12}`.
`ApplyResult` = `{ applied[], skipped[], conflicts[{path,expected,actual}], rolledBack }`. **원자성**: `path.tmp`→`rename` · 하나라도 `baseHash` 불일치면 **전체 계획 폐기**(부분 적용 금지).

#### 1-3-a. 확정본 (워커 B 구현 · 2026-09-03 · **상위 호환 추가만** — 기존 시그니처·의미 불변)

- **시그니처 추가 3건**: `planBmadWrites({ mapping, snapshot, config, texts = {}, now, round, completions = [], inbox = null })` — `texts`(경로→원문 map)가 있어야 `baseHash`/`sectionHash` 를 **계획 시점에** 계산한다(없으면 `snapshot.stories[].hash` 로 baseHash 만 채우고 sectionHash 는 null). `applyBmadWrites(plan, { root, now, fs, guards })`. 읽기 도우미 `collectTexts(root, paths, {fs})` 추가(읽기 전용 · D 가 `texts` 를 만들 때 쓴다).
- **op 4종 불변**. 앵커 정책을 명문화: `append-within-section` = `APPEND_ONLY_ANCHORS` ∪ `EPIC_STORY_ANCHOR_RE`(`^#{2,3} Story N.M:` — epics 등재 자리) / `insert-after-heading` = `INBOX_H1_RE`(`^# …결정 인박스`) ∪ `APPEND_ONLY_ANCHORS`. 그 밖(`## Acceptance Criteria` 등)은 **계획 전체 폐기**.
- `ApplyResult` **추가**: `schema` · `rejected[{path,why}]`(가드 위반 — conflicts 와 구분) · `wrote[]`. `rolledBack:true` = 「이 계획은 하나도 안 들어갔다」(폐기·되돌림 공통).
- **가드 2개 추가**(설계 §3 「사용자 변경 보존」의 집행 수단): ① **줄 유실 0** — 원문의 어떤 줄도 사라지면 거부(sprint 키 upsert만 1줄 허용) ② **Status 줄 불변** — 바뀌면 거부(상태 전이는 `story-writes.setStoryStatus` 만).
- **추가 export**: `BMAD_PLAN_SCHEMA`·`BMAD_APPLY_SCHEMA`·`DEFAULT_GUARDS`·`WRITE_OPS`·`EPIC_STORY_ANCHOR_RE`·`INBOX_H1_RE`·`slugify`·`pathAllowed`·`anchorAllowed`·`findHeadingLine`·`sectionRange`·`sectionBody`·`applyWriteToText`(순수 1건 적용)·`lineLoss`·`inferEpic`·`collectTexts` · `setStoryStatus` 재수출.
- `mapToStories` 반환 항목 필드: `{item, key, epic, num, title, kind:'new'|'defect', epicsEntry, path?, exists?, why}` · `unmappable[{item, category:'product-intent', why}]`. **에픽 추정**은 `item.epic` → File List 에 그 파일을 선언한 스토리들의 다수 에픽 → null(질문) 순.
- `renderCompletionRecord(spec)` 의 qa 수치 출처는 `spec.manifest.qa{exit,files,passed,skipped}` **하나뿐**이다. 없으면 `NOT VERIFIED` 문자열을 적고 숫자를 만들지 않는다. `checks` 의 `n/a·not-run·unknown·required-missing` 은 전부 「NOT VERIFIED (정직 표기)」 절로 모인다.

### 1-4. `readiness.mjs`
```js
export const TASK_CRITERIA / PROJECT_CRITERIA   // 각 8개 (§6)
export function taskReadiness({ item, manifest, story, diagnosis }): Readiness
export function projectReadiness({ diagnosis, manifests, backlog, metrics }): Readiness
export function renderReadinessTable(r, { lang:'ko' }): string
export const NOT_VERIFIED = 'not-verified'
```
**전파**: `fail` ≥1 → `not-ready` / `fail` 0 & `not-verified` ≥1 → `not-verified`(절대 `ready` 아님) / 전부 pass → `ready`.

### 1-5. `decisions.mjs`
```js
export const QUESTION_CATEGORIES = ['product-intent','ux-business','irreversible-data','paid-cost','account-auth-secret','legal-policy','public-egress','vcs-approval']
export function needsHuman(subject, ctx): { ask, category, why, confidence }
export function renderQuestion(q): string          // 비개발자 언어 · 추천/대안/안전 기본값
export function buildInboxBlock(questions, { date, source }): string
export function pendingKeys(inboxText): { key, why }[]      // → validatePlan constraints.blocked
export function autoDefault(subject): { value, why } | null  // 무인 기본값(사후 확인)
```

#### 1-5-a. 확정본 (워커 B 구현 · 2026-09-03)

- `needsHuman(subject, ctx)` 반환 = `{ask, category, why, confidence, evidence[]}`. `ctx.inboxText` 를 주면 `✅` 절에서 답을 찾아 **ask=false + 근거 인용**. `TECHNICAL_KINDS`(진단이 내는 kind 대부분)는 트리거 문자열이 스쳐도 묻지 않는다 — 단 **되돌릴 수 없는 6범주**(비가역·비용·비밀·법률·발송·승인)는 kind 를 이긴다. `vcs-approval` 트리거는 「배포할 수 없다」 같은 **서술**을 배제하고 승인 맥락·실제 명령어만 문다.
- **추가 export**: `CATEGORY_META`(범주별 사람말 이름·marker·기본 severity·무인 기본값 허용) · `TECHNICAL_KINDS` · `INBOX_HEADER` · `plainKo(text)`(경로·함수 표기·확장자·코드 인용 제거 — 질문 렌더의 언어 가드) · `questionFingerprint(subject)` · `buildQuestion(subject, verdict, {index,now})`(선택지 ⓐⓑⓒ 자동 생성) · `findConfirmed(inboxText, subject)` · `alreadyAsked(text, fp)` · `renderNewInbox(block)` · `inboxWritePlan({path,exists,text,questions,…})` · `blockedMap(pending)`.
- `pendingKeys(inboxText, { storyKeys = [] })` → `[{key, id, why, severity, heading}]`. `storyKeys`(sprint 키)를 주면 `2.24` → `2-24-…` 전체 키로 푼다(안 주면 `N-M`). `blockedMap` 이 `validatePlan(constraints.blocked)` 의 **맵** 형태로 바꾼다. **실물 규칙**: 열린 절 = 🟠/🔴 + 표지 문구(결정 대기·남은 사람 판단·사람 게이트·판단 필요) + `✅/⏳/🟢` 아님 / 번호 하위 항목(`### ① 🟠 …`)은 **부모 절이 열려 있을 때만** 세고 스토리 번호는 부모에게서 물려받는다(`## ✅ 해소` 절 안에도 🟠 하위 항목이 남아 있다 — 실물 함정).
- `inboxWritePlan` 은 `{ok, op:'create-file'|'insert-after-heading'|'skip', path, body, block, questions, anchor, why}`. 인박스 **부재 시 생성**(`renderNewInbox`), 첫 줄이 표준 제목이 아니거나 경로를 모르면 `{ok:false}` = **Decision 적용 실패**(BRIEF 정책 15).
- `autoDefault(subject)` — 기술 판단이면 「추천안대로(무인 규칙 ①)」, `product-intent`·`vcs-approval` 만 안전 기본값이 있고, **정책·문구·비가역·비용·보안·법률·발송은 null**(무인 기본값을 만들지 않는다 — 무인 규칙 ③).
- 질문 렌더 언어 가드는 **테스트로 고정**: `renderQuestion` 출력에 백틱·경로·확장자·`이름(` 형태가 하나라도 있으면 실패한다. (절 제목·목록은 `story-writes.appendDecisionsInbox` 공용 관례를 그대로 쓰므로 그 문장의 스토리 파일 언급은 종전대로다.)

### 1-6. `report.mjs`
```js
export function buildReport({ run, diagnoses[], backlog, readiness, metrics, questions, bmadApplied }): ReportModel
export function renderReportMd(model): string      // SPEC §10 12항목 순서 고정 · 렌더 직전 시크릿 재마스킹
export function renderReportJson(model): object
```

### 1-7. `autofinish.mjs` (진입 CLI)
```
node <skill>/engine/autofinish.mjs
  --root .  --diagnose-only  --dry-run  --max-rounds 3  --budget-min 480
  --gates qa,build | --no-gates  --state <dir>  --out <path>  --bmad-writes on|plan  --plan-model fable
```
```js
export async function runAutoFinish(opts): { exitCode, report, rounds[] }
export function loopDecision({ round, before, after, cfg }): { action:'continue'|'stop'|'escalate', why }
export function buildQueueFromPlan(plan, backlog, snapshot): NightQueue   // run-night --queue 형식
```
루프: r0 `readProject → runGateProbe(qa) 1회 → diagnose → buildBacklog → needsHuman → mapToStories → planBmadWrites → (on 이면 apply) → buildDag → assignWorkers → orchestrate.requestPlan(fable) → validatePlan(거부 시 deterministic 폴백) → buildQueueFromPlan → spawn run-night --queue` / r1.. `readProject → diagnose(prev) → loopDecision` / 끝 `runGateProbe(qa) → projectReadiness → report`. 산출물은 `<state>/autofinish/<runId>/` 에 JSON(재개·감사). **게이트 총횟수 = 라운드 수 + 1.**

---

## 2. 진단 판정 규칙

### 2-1. 증거 우선순위
`evidenceRank = { gate:1, test:2, code:3, story:4, plan:5 }` — 가장 강한 증거가 이기고, 같은 등급이면 부정 증거가 이긴다.

강등표(위부터 첫 일치): D1 qa RED 가 그 스토리 File List 파일을 가리킴 → `defect`(1) · D2 선언 done + File List 부재 ≥1 → `partial`(3>4) · D3 선언 done + 비테스트 파일 대응 테스트 0 → `partial`(2>4) · D4 열린 `[Review][Patch]` ≥1 → `partial` · D5 열린 `[Review][Decision]` → `blocked` · D6 미완 Task ≥1(사람 게이트 줄 제외) → `partial` · D7 `statusInFile !== statusInSprint` → `partial`+`status-drift` · D8 sprint 키 있는데 md 없음 → `missing` · D9 epics 에만 있음 → `missing`(5) · D10 위 전부 아님 + `gates.qa.exit===0` → `verified-done` · D11 qa 미실행 → `not-verified`.
> 문서의 `done` 은 단독으로 `verified-done` 이 못 된다(rank 1 필요).

테스트 대응 매칭(D3): `basename.test.*`/`.spec.*` 또는 `tests/<도메인 폴더>/` 관례.

### 2-2. 휴리스틱
- 임시 코드: `TEMP_CODE_RE = /(TODO|FIXME|HACK|XXX)\b|임시\s*(구현|처리|값|코드)|나중에\s*(고침|구현)|placeholder|dummy/i` (tests/**·mockups/**·*.md 제외)
- 비활성 테스트: `SKIP_RE = (it|test|describe|suite)\.(skip|todo)\(` · `ONLY_RE = (it|test|describe)\.only\(` — 따옴표/백틱 안이거나 `*guard*.test.*` 면 `needs-review`(low), 그 외 tier 5 blocking. skip 은 위 3줄 안 사유 주석 있으면 tier 7, 없으면 tier 5.
- 배포 차단: DB-DRIFT `운영 적용 대기 — **N건**` N>0 → tier 3 · `🚨 적용 큐 +N 파일` · `deploy:prod` 가 참조하는 preflight 실재 · wrangler env 3키 · `.env.production` git 추적 시 tier 1.
- 문서 불일치: A=epics `### Story N.M` · B=sprint 키 · C=impl md 파일 → A\B 계획만 · B\A 원장 밖 · C\B 고아 · B\C 파일 부재 · File List 부재 · Status 헤더 vs sprint.
- 보안: `SECRET_PATH_RE = /(^|\/)\.env(\.|$)|(^|\/)(secrets?|credentials?)\//i` · `SECRET_VALUE_RE = /(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.|-----BEGIN [A-Z ]*PRIVATE KEY-----|service_role)/` → tier 1 · 값은 어디에도 원문 금지.

### 2-3. 실제 실행(비용)
`npm run qa` = autofinish 초기+최종 **2회**(`--no-gates` 0회) · 스토리 단위 qa = 기존 엔진 계약(1+수리≤5) · `build` 최종 1회 · 통합 게이트 배치당 1 · security/performance 는 스크립트 실재 시만(없으면 `n/a` · GREEN 아님). `--diagnose-only` 는 게이트 0회 · 대상 저장소 쓰기 0.

---

## 3. BMAD 보존 규칙
- 매핑: epics 절 + sprint 키 있음 → **기존 스토리에 붙인다**(Review Findings 원장 줄 + 회수 라운드 Task) / 없음 → 결함이면 영향 에픽에 결함 스토리, 기능 누락이면 신규 스토리 / 에픽 없음 → 만들지 않고 **질문**(범주 1). 라운드당 신규 상한 3.
- 번호: `<epic>-<num>-<slug>` · num = max(sprint ∪ epics ∪ md) + 1(에픽 단위 · jng-os epic 11 → `11-8`) · 결함 `<epic>-<num>-결함-<slug>` · slug 한글 유지 40자 · frontmatter `baseline_commit: <HEAD>`.
- 템플릿: jng-os 절 이름 그대로(`# Story N.M:` · `Status: backlog` · 생성 근거 인용 블록 · `## Story` · `## Acceptance Criteria` · `## Tasks / Subtasks` · `### Review Findings` · `## Dev Notes/### References` · `## Dev Agent Record` 하위 5절 · `## Change Log` 표). epics 등재 = 그 에픽 마지막 `### Story` 절 뒤 · sprint 등재 = 그 에픽 마지막 키 다음 줄 `  <key>: backlog  # 날짜 자율 마무리 신설 — F-xxxx`.
- 사용자 변경 보존: 스냅숏 sha256 → write 직전 재계산 비교 → 불일치면 계획 전체 폐기 · **append-only 앵커 화이트리스트 밖 수정 금지**(Status 전이만 `setStoryStatus`) · sprint 는 **키 단위 upsert**(재직렬화 금지 — 주석 유실) · 절 단위 `sectionHash` 3-way · `_bmad-output/` 밖 경로 거부.
- 완료 기록: `### Completion Notes List` 에 `**✅ 날짜 자율 마무리 라운드 n 완주**` 블록(구현·변경 파일·테스트 실측 수치·교차 리뷰 provider/model·남은 위험·**NOT VERIFIED**·commit/push) + File List append + Change Log 행.

---

## 4. 오케스트레이션 흐름
- 역할 분담: 후보 집합·DAG·채택 검증·워커 배정 = 결정적 / 「무엇부터·어떻게 묶을까」 = Fable / 실행 = `run-night --queue`. 폴백은 말없이, 사유는 `plan.source`.
- 보수 범주(`CONSERVATIVE_RULES` · mode any): `auth-permission`(src/auth · *_permissions.sql · 권한·RLS) · `billing-payment`(src/features/contracts|billing · 청구·결제) · `db-change`(기존 migration 규칙) · `deploy-config`(wrangler.* · tools/deploy · workflows) · `shared-core`(src/lib · App.tsx · src/types · routes.ts · multi) · `secret-external`(SECRET_PATH_RE · outbox/teams/ntfy). any = 한 스토리만 만져도 병렬 불가 → `batch-conflict` 거부 → 배치 분리.
- 실패 6종: `env`(exit 2/5/6 · 재실행 금지 · 대기/사람) · `code`(typecheck/lint/build · 파일 범위 · 3/5 예산) · `test`(테스트 파일+File List) · `security`(자동 수리 금지 → 질문/중단) · `performance`(1회) · `integration`(rollback+STOP).
- `loopDecision`: round≥max → stop · 백로그 fingerprint 무진전 → stop · tier≤3 증가 → escalate · 같은 signature 3회 → escalate · 예산 초과 → stop. escalate = `escalationReport` 6항 + 종료.

---

## 5. 질문 최소화
- 8범주 트리거: ① 어느 에픽에도 매핑 불가 · 열린 Decision ⓐⓑⓒ ② 새 사용자 노출 문구 · 목업 미승인 ③ `DROP|DELETE FROM|TRUNCATE|drop policy` · 비가역 대량 생성 ④ 유료 API·구독 ⑤ SECRET 히트 · 새 환경변수 · 테스트 계정 ⑥ 개인정보·약관 ⑦ 실제 발송 경로 신설 ⑧ 커밋·푸시·머지·배포(항상).
- 포맷: `### ① 🟠 <비개발자 제목> (severity)` / **지금 무슨 일** / **왜 물어보나** / **선택지** ⓐ추천·ⓑ대안·ⓒ그대로 / **안전 기본값** / **기다리는 동안 계속 도는 것**. 파일명·함수명 금지.
- 봉쇄는 그 스토리 키만(`pendingKeys` → `constraints.blocked`). 인박스 부재 시 생성, 같은 fingerprint 재등재 금지.

---

## 6. 완료·배포 가능 판정표
작업 T1~T8: T1 `checks.qa.exit===0` · T2 새 테스트 ≥1 · T3 전체 체인 · T4 security/performance/integration(스크립트 없으면 `n/a`→not-verified) · T5 integrity blocking 0 · T6 review.provider≠dev.provider **and** 열람 증거 ≥1 **and** high 0 · T7 verdict verified-done & 상태 3곳 일치 · T8 Completion Notes 실측 인용 + NOT VERIFIED 절.
프로젝트 P1~P8: P1 FR↔스토리 verified-done · P2 high/medium 0 + tier1~3 0 · P3 qa/build/통합 GREEN(보안·성능 없으면 not-verified) · P4 문서 불일치 0 · P5 미완 0 또는 인박스 확정 이연 · P6 File List 부재 0 · DB 드리프트 0 · tier≤3 임시코드 0 · P7 최종 교차 리뷰 매니페스트 · P8 notVerified>0 → ready 금지(코드 강제).
jng-os 현 예상: P2·P4·P5·P6 fail → `not-ready`.

---

## 7. 안전 경계 매핑
1 main 직접 작업 = `commitPlaceOk`(detached/auto/*) · 2 커밋/푸시 = git-guard shim + 통합 RED push 금지 · 3 실패 강제 반영 = RED rollback 고정 · 4 게이트 생략 = integrity + `n/a`→not-verified · **5 사용자 변경 덮어쓰기 = 신규(baseHash/sectionHash 3-way + append-only + 전체 폐기)** · **6 허용 밖 파일 = 신규(`allowedPathPrefixes` · 삭제 op 없음)** · 7 비밀정보 = pathspec 제외 + 재마스킹 + 로그 마스킹 + **report 렌더 직전 재마스킹** · 8 파괴적 데이터 = 범주 3 질문 + 마이그레이션 무인 적용 금지 · **9 무제한 재시도 = 신규(loopDecision + repairDecision + budget)**.

---

## 8. 측정 지표 7종
1 전체·작업별 시간(p50/p95) · 2 병렬률·유휴 · **3 첫 시도 통과율**(첫 dev 뒤 qa 0 & repairRounds 0) · **4 리뷰 결함 수**(decision/patch/defer · high) · 5 자동 수정·**반복 실패**(signature≥3) · **6 통합 실패율** · **7 순차 대비 절약**(serialMs−wallMs). `metrics.mjs` 확장점: `summarizeTimeline` 반환 `firstPass·repeatedFailures·saving` · `opts.quality.findings` · `renderMetricsTable` 7행(기존 행 불변). 게이트 조건 다른 실행은 「비교 불가」.

---

## 9. 테스트 계획
- 단위: `diagnose`(강등표·굵은 Patch·👤 인용 줄·.only 문자열·고아 문서·게이트 1회·시크릿 부재) · `backlog`(tier 배타·id 안정·hazard·6분류·merge) · `bmad-sync`(번호·왕복·baseHash 폐기 실 rename·경로 거부·sprint 주석 무손실·앵커 밖 거부) · `readiness`(n/a→not-verified·전파·T6) · `decisions`(8범주·기술판단 ask=false·중복·인박스 생성·비개발자 언어) · `report`(12항목 순서·마스킹·비교 불가·not-verified 표기) · `autofinish`(loopDecision 4종·diagnose-only 쓰기 0·게이트 횟수) · `completion-rules`.
- 종단 `autofinish-e2e.test.mjs`(실제 git 픽스처 · 스토리 5개 상태 혼합 · 실제 node 스텁): E1 diagnose-only 바이트 동일 · E2 1라운드 왕복 · E3 Fable 채택 · E4 거부 폴백 · E5 보수 범주 분리 · E6 덮어쓰기 방지 · E7 신규 스토리를 plan() 이 읽음 · E8 봉쇄 후 독립 계속 · E9 반복 중단 escalate · E10 시크릿 3파일 전수 grep · E11 게이트 횟수 · E12 하위 호환(run-night --queue 단독 · plan-queue --dry · Claude 단독).
- 실제 흐름(jng-os 읽기 전용): `autofinish.mjs --root C:\Projects\jng-os --diagnose-only --no-gates --state <tmp> --out <tmp>/report.md` → 증거: 전후 `git status --porcelain` 동일 · 84 스토리 · declaredDone 19 · verified-done 0(not-verified) · 판정 not-ready(P2·P4·P5·P6) · 고아 문서 분류 · 임시코드/only/skip 분류 · 시크릿 값 미노출.
- 하위 호환: 기존 전건 GREEN · `autofinish` 키 없으면 코드 경로 0 · 훅 미배선 시도 동작.

---

## 10. 워커 분할안 (A → (B‖C) → D)
- **A 진단·백로그**: `diagnose.mjs`·`backlog.mjs`·테스트·`fixtures/fake-bmad-project.mjs`(공용) — 스키마 확정자 · ~1,960줄
- **B BMAD 동기·결정**: `bmad-sync.mjs`·`decisions.mjs`·테스트 — 유일한 쓰기 IO · ~1,460줄
- **C 판정·보고·완료기준**: `readiness.mjs`·`report.mjs`·`auto-story-finish/completion-rules.mjs`·테스트 — metrics 확장 없어도 폴백 · ~1,680줄
- **D 진입 루프·종단·문서**: `autofinish.mjs`·단위/종단 테스트·`fixtures/stub-claude|codex.mjs`·두 SKILL.md 절·(선택) pipeline 훅 3줄 — ~2,160줄
충돌 회피: 누구도 `run-night.mjs`·`plan-queue.mjs`·`runner-rules.mjs`·`metrics.mjs`·`providers/*` 를 수정하지 않는다(확장 요청은 인터페이스로 넘김).
착수 전 확인: metrics 3필드 확장 주체(F2/폴백) · pipeline 훅 주체(E/D) · `auto.config.json` `autofinish` 블록 기본값(`maxRounds:3 · gates:['qa'] · maxNewStories:3 · bmadWrites:'plan'`).
