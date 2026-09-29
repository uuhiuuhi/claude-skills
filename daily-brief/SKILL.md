---
name: daily-brief
description: 하루 시작 브리핑. "아침 브리핑", "브리핑 해줘", "지난 라운드 결과 보고해줘", "어젯밤 뭐 됐어?", "오늘 뭐 정하면 돼?", 하루를 시작할 때 사용한다. git fetch → 24시간 러너의 지난 라운드 결과 → 개발 현황판 신선도 → 사람이 정할 것 → 다음 작업 추천 → 작업수준 평가표 → 「운영에 반영된 것 같이 확인할까요?」 순으로 읽고 비개발자도 15~20분 안에 판단할 수 있게 정리한다. 읽기 전용이며 커밋·머지·배포는 하지 않는다(프로젝트 규칙이 허용한 문서 기록만 예외). batch-24-multiAG · dev-status 스킬 위에서 동작한다.
---

# daily-brief — 지난 라운드에 된 것 / 오늘 정할 것

24시간 러너(batch-24-multiAG)가 만든 결과를 **사람이 15~20분 안에 판단할 수 있는 형태**로 바꾼다. 코드를 고치지 않는다.

## 먼저 정하는 값 (프로젝트에서 읽는다)

값의 기본값과 읽는 순서는 [references/parameters.md](references/parameters.md)가 정본이다. 요약:

| 이름 | 어디서 | 기본값 |
|---|---|---|
| `HUMAN_TITLE` 사람 몫 절 제목 | 프로젝트 CLAUDE.md 에 정의된 제목 | 「👤 내 차례」 |
| `RUNNER` · `STATE` · `TASK` | `batch-24-multiAG/ops/lib.sh` 와 같은 순서(환경변수 → `tools/auto/auto.config.json` → 기본값) | 현재 폴더 · `~/.claude-auto/<project>` · `<project>-auto-slots` |
| `ART` 산출물 폴더 | CLAUDE.md 재정의 | `_bmad-output/implementation-artifacts` |
| `INBOX` · `RELEASE_LOG` · `SCORECARD` | CLAUDE.md 재정의 | `ART/DECISIONS-INBOX.md` · `ART/RELEASE-LOG.md` · `ART/WORK-LEVEL-SCORECARD.md` |
| `PROD_URL` 운영 주소 | CLAUDE.md 또는 설정 | **없음** — 없으면 10절에서 링크를 만들지 않는다 |
| `BASE` 기준 갈래 | CLAUDE.md 재정의 | `main` (작업 갈래 접두사 `auto/`) |

아래 명령 속 `$BASE` · `$ART` 같은 이름은 이 표의 값으로 바꿔 넣는다.

```bash
# 러너 값 읽기 — 설정이 없으면 러너 관련 절은 전부 「확인 못 함」
( source ~/.claude/skills/batch-24-multiAG/ops/lib.sh && echo "RUNNER=$RUNNER STATE=$STATE TASK=$TASK" )
```

## 공통 규칙

- **판정 재료가 없으면 「판정 불가」라고 쓴다 — GREEN 이라고 쓰지 않는다.** 파일이 없는 것, 형식이 다른 것, 읽다 실패한 것은 전부 「확인 못 함」이지 「이상 없음」이 아니다. 모든 절에 적용한다.
- 스크립트가 없으면(설치 안 된 도구) 그 절은 「확인 못 함 — <무엇이 없어서>」 한 줄로 끝내고 다음 절로 간다. 추측으로 채우지 않는다.
- 각 절은 **「달라진 것」만** 적는다. 배치가 3개를 넘으면 통과하지 못한 것과 병렬로 돈 것만 개별로, 나머지는 한 줄로 묶는다.
- 설명은 전부 비개발자용 쉬운 말. 결론이 첫 문장. 기술 용어는 괄호로 쉬운 뜻을 붙인다.
- 사용자에게는 「24시간 러너」·「지난 라운드」·「지휘 실행」이라고 부른다(파일 이름의 `night` 는 옛 이름일 뿐이다).
- 백그라운드 작업을 띄우면 batch-24-multiAG SKILL.md 「백그라운드 작업 표기 규칙」을 따른다(`[지금작업중·<모델>]` · `[지금감시중]` · `[지금확인중]` · 시한과 시한 뒤 할 일).

## 절별 상한 (낭독 15~20분)

| 절 | 상한 |
|---|---|
| 0. 30초 결론 | 3줄 고정 |
| 1. 저장소 정렬 | — |
| 2. 지난 라운드 | 6줄 |
| 3. 오늘 예정 | 5줄 |
| 4. 계측 요약 | 3줄 + 사용량 1줄 |
| 5. 자율 진단 요약 | 4줄 |
| 6. 현황판 | 신선도 1줄 + 달라진 칸만 |
| 7. 사람 몫 · 결정 소진 | 핵심 — 상한 없음 |
| 8. 다음 작업 추천 | 항상 있음 |
| 9. 작업수준 평가표 | 오늘 줄 + 개선 3~5건 |
| 10. 운영 반영분 같이 확인할지 | 항목당 1줄 + 질문 1개 |

읽는 파일 전체 목록은 [references/sources.md](references/sources.md).

## 순서

### 0. 30초 결론 — 3줄 고정

1. **배포 가능 판정 + 이유 한 줄** — RED 배포 불가 / AMBER 조건부 / GREEN 배포 가능 / **판정 불가**. 재료: 배치 매니페스트의 `integration.result`·`worst`, 계측의 `qualityGate.passed`, 편성 큐의 `validation.ok`, 검증 매니페스트의 실패 검사, 결정 대기 건수, 미머지 `auto/*` 나이, `readiness.json` 의 `verdict`. **`readiness.json` 이 없으면 상한은 AMBER 다.**
2. **오늘 정할 것 N건 (3일 이상 기다린 것 M건)**.
3. **다음 라운드 예정 N배치 (병렬 M쌍)**.

### 1. 저장소를 먼저 맞춘다

```bash
git fetch --all --quiet; git status -sb; git log --oneline -5
git branch -r --no-merged origin/$BASE | grep auto/
```

왜: 다른 창·원격이 앞서 있으면 뒤처진 사본으로 판정을 통째로 틀린다.
**미머지 `auto/*` 가 있으면 최신 산출물은 기준 갈래가 아니라 그 갈래에 있다** — 2·3·7절의 파일은 `git show origin/auto/<최신>:<경로>` 로 읽는다.

### 2. 지난 라운드 결과 (≤6줄)

- 러너 요약 `LOGS/night-last-run.md` — 완주/중단.
- **[의무] 러너 심박** — `STATE/slots.log` 의 마지막 수정 시각과 `STATE/runner.lock`: lock 있고 45분 이내 = 가동 중 / lock 있고 45분 넘음 = **심박 없음 1급 경보** / lock 없고 지난 라운드 기록 0건 = **러너가 안 돌았다 1급 경보** / 로그 없음 = 「러너 로그 없음」. **기록 0건이면 다른 무엇보다 먼저 말한다.**
- **[의무] 한도 대기 분** — `LOGS/run-summary.log` 의 한도 대기 누계(0분이면 0분). 하루 상한 소진으로 편성이 0건이면 상한 연장(원격 명령이 있으면 `/extend N`)을 추천한다.
- **[의무] 통합 게이트** — 배치마다 `batch-<id>-manifest.json` 의 `integration.result` 를 `pass`/`fail`/`rollback` 으로. `rollback` 이면 되돌린 건수 + `landingBase` + 보관 태그. 키가 없으면 「미실행」이지 「pass」가 아니다.
- **구현·리뷰 모델 · 병렬 폭 · 재시도** — 정본은 `<story>-verification.json` 의 `workers`. 없으면 `[ASSIGN]`·`[MODEL-ROUTE]` 줄 → `metrics-<id>.json` 의 `modelCalls` 순으로 찾고, 그래도 없으면 「—」(추측 금지).
- **증거 폴더** — 실패 스토리는 `STATE/archive/*-evidence/<story>/` 를 **실제로 있을 때만** 적는다.
- 중단 사유(exit 코드): `3` 인증 만료(재로그인) · `4` 시작 못 함(작업 폴더 미정리) 또는 바뀐 것 없음 · `5` 사용량 한도(리셋 후 자동 재개) · `6` 저장 가드(비밀값·금지 경로) · `8` 리뷰 대기(고장 아님) · 그 밖 = 단계 실패(검사 RED 포함). 재실행은 같은 명령 그대로(끝난 단계는 건너뛴다).

### 3. 오늘 예정 (≤5줄)

원천 = `STATE/auto-queue-*.json` 중 최신(사람이 확정한 큐 `tools/auto/night-queue.json` 이 있으면 그것).

- **[의무] 편성 출처 `plan.source`** — 규칙 편성 / 지휘 모델 편성 / `deterministic-fallback(<사유>)`. **폴백이면 사유를 반드시 적는다.**
- **[의무] 검증 경고** — `validation.ok` 가 false 면 `validation.errors` 전건 + `_편성.excluded`(빠진 스토리와 이유).
- 배치 순서와 병렬 짝 · 배정 이유(`_편성.picked`) · 사용 모델(`batches[].models`). `STATE/assign-history.json` 에서 연속 실패 2회 이상 조합은 「회피 중」.
- 큐 파일이 없으면 「편성 전」이다(0배치가 아니다).

### 4. 계측 요약 (≤3줄 + 1줄)

원천 `STATE/metrics-history.jsonl` + 최신 `metrics-<id>.json`.

- 지난 3일의 **순차 대비 절약 · 병렬 효율 · 유휴 비율 · 첫 시도 통과율** 방향(개선/악화/평평)만.
- **품질 게이트를 통과하지 못한 실행은 빼고 「제외 N」** — 품질을 깎아 얻은 속도는 개선이 아니다.
- 배치 0건인 날은 「배치 없음」(0으로 세지 않는다). 값이 2개 미만이면 추세 「—」. 이력 파일이 없으면 「계측 이력 없음」.
- **모델별 사용량 한 줄** — 프로젝트가 사용량 집계 명령(`USAGE_CMD`)을 정해 두었으면 실행해 제공자별 비율을 적는다. 없거나 실패하면 「사용량 집계 못 함」.

### 5. 자율 진단 요약 (≤4줄)

원천 `STATE/autofinish/<runId>/` 의 `diagnosis.json` · `backlog.json` · `readiness.json` · `report.json`.

- 5분류 건수 — verified-done / partial / missing / defect / test-gap.
- **배포 차단은 전건** — `readiness.json` 의 `blockers[]`. `report.json` 의 `headline` 을 인용해도 된다.
- `verdict` 가 `not-verified` 면 GREEN 으로 올리지 않고 `notVerified[]` 의 「무엇을 왜 확인 못 했는지」를 적는다.
- 산출물이 없으면 「자율 진단 미실행」 + 0절 판정 상한을 AMBER 로.

### 6. 현황판 — 신선도 검사 먼저

낡은 화면으로 판정하지 않는다. 브리핑마다 현황판을 **새로 만들고 신선도 항목을 먼저 읽는다.** 도구는 dev-status 스킬이 제공한다(프로젝트 사본 `tools/dev-status/` 가 있으면 그것, 없으면 `~/.claude/skills/dev-status/`).

프로젝트 루트에서 실행한다(도구가 현재 폴더로 프로젝트를 찾는다):

```bash
node --input-type=module -e "
import {existsSync} from 'node:fs'; import {join,resolve} from 'node:path'; import {homedir} from 'node:os'
import {pathToFileURL} from 'node:url'; import {spawnSync} from 'node:child_process'
const home=process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude')
const DS=[resolve('tools/dev-status'),join(home,'skills','dev-status')].find(d=>existsSync(join(d,'freshness.mjs')))
if(!DS){console.log('현황판 도구 없음 — 신선도 확인 못 함');process.exit(0)}
spawnSync(process.execPath,[join(DS,'build.mjs')],{stdio:'inherit'})
const u=(f)=>pathToFileURL(join(DS,f)).href
const s=await import(u('scan.mjs')); const f=await import(u('freshness.mjs'))
const ch=f.freshnessChecks(s.scan()); console.log(JSON.stringify(f.freshnessVerdict(ch)))
for(const c of ch) if(c.status!=='ok') console.log(c.id,c.status,c.detail,c.action||'')"
```

- 도구가 없으면 「현황판 도구 없음 — 신선도 확인 못 함」.
- **F1 뒤처짐**(읽는 폴더가 원격 기준 갈래보다 뒤) → `git merge --ff-only origin/$BASE` 로 맞춘 뒤 다시 만든다. 원격보다 **앞선** 미푸시 커밋은 낡음이 아니라 푸시 대상이다.
- 러너 기록(F4)·배치 기록(F5)이 unknown 이면 「지난 라운드 0건」을 믿지 않는다 — 러너가 별도 폴더(`RUNNER`)에 있으면 그쪽 기록을 직접 읽는다.
- 보고 = **신선도 한 줄(ok/warn/stale/unknown 건수)** + 남은 warn/stale 이유 + 어제와 달라진 칸만. 2~5절에서 말한 숫자는 반복하지 않는다. 배포 판정 배지의 근거는 실측으로 한 번 검산한다(이미 기준 갈래에 들어간 갈래를 「미머지」로 세는 오판 방지).

### 7. 사람 몫 · 결정 소진 — 이 브리핑의 핵심

- 사람 몫 한 장은 **`my-todo` 스킬을 그대로 실행**해 만든다 — 재료·형식·반영 절차는 그 스킬이 소유한다. 스킬이 없으면 `INBOX` 의 결정 대기·사후 확인 절과 `STATE/human-gates.json` 을 직접 읽는다.
- **3일 이상 기다린 항목이 있으면 그 사실을 먼저 말한다**(스토리 파일 안에만 적힌 결정이 며칠씩 묻히는 사고 방지).
- **인박스에 안 올라간 결정도 훑는다** — 스토리 원장 전체에서 열린 결정을 센다(도구: batch-24-multiAG 설치본 `tools/auto/story-ledger.mjs` · 없으면 「원장 전수 확인 못 함」):

```bash
node -e "import('./tools/auto/story-ledger.mjs').then(m=>{const fs=require('fs');const A=process.argv[1];for(const f of fs.readdirSync(A).filter(n=>/^\d+-\d+.*\.md$/.test(n))){const n=m.openFindings(fs.readFileSync(A+'/'+f,'utf8'),'Decision');if(n>0)console.log(n+'건',f)}})" "$ART"
```

- 열린 결정 **전건**을 한 장으로 — 항목마다 무엇을 / 선택지 장단점 / ⭐추천안. 답 형식을 한 줄로 안내한다(예: 「1 가 · 3 나 · 나머지 추천대로」).
- 답을 받으면 그 자리에서 원장에 반영하고 `node tools/auto/plan-queue.mjs --dry` 로 풀렸는지 실측한다. 이 기록은 브리핑의 읽기 전용 예외다 — **커밋 여부는 프로젝트 규칙**(문서 전용 변경 즉시 커밋 허용 여부)을 따른다.

### 8. 다음 작업 추천 — 항상 있어야 한다

「오늘은 더 하실 일이 없습니다」는 프로젝트가 완성된 날에만 쓸 수 있다. 사람 몫이 0건이어도 반드시 다음 작업을 추천한다. 후보 순서:

1. 배포 차단(`readiness.blockers[]`)
2. 통합 게이트 `rollback`·`fail` 배치의 스토리 되살리기
3. 결정 대기(3일 이상 먼저)
4. 미머지 `auto/*` 병합 — 체인이 길수록 기준 갈래가 뒤처지고 병합이 커진다(실행 여부는 프로젝트 규칙)
5. 사람 게이트 잔여(운영 적용·실기 확인·계정·키)
6. 목업·스펙 승인 — 다음 라운드 물량 장전
7. 그것도 없으면 다음 마일스톤으로 가는 최단 경로 1가지

### 9. 작업수준 평가표 — 7항목 · 매일 누적

`SCORECARD` 에 **① 품질 ② 안전 ③ 자율지속성 ④ 속도 ⑤ 멀티병렬 ⑥ 계기판 신뢰성 ⑦ 정본 전진**을 0~10점으로 채점해 누적 표에 한 줄 추가한다. 점수는 2~6절에서 이미 읽은 실측에서만 낸다 — 재료가 없는 항목은 「—」(판정 불가)이지 0점이 아니다. 전날 개선 조치의 이행(됨/안 됨/부분)을 먼저 적고, 새 개선 조치는 항목 번호를 달아 3~5건. 보고에는 오늘 줄 + 오른/내린 항목 + 개선 조치만. 파일이 없으면 [references/scorecard-template.md](references/scorecard-template.md) 로 만들지 사람에게 묻는다(묻기 전에 만들지 않는다).

### 10. 운영 반영분 같이 확인할지 — 브리핑의 마지막 질문 (항상)

1. **목록** — 지난 브리핑 뒤 운영에 반영된 변경. 원천 = `RELEASE_LOG` 의 새 절 + `git log <지난 브리핑 시점>..origin/$BASE`. 항목마다 ① 무엇이 바뀌었나(쉬운 말 한 줄) ② **바로가기 전체 주소** — `PROD_URL` + 경로(경로만 적지 않는다) ③ 어느 역할로 들어가 어느 메뉴·어느 칸을 보면 되는지 ④ AI 가 먼저 확인한 판정(통과/실패/못 봄 — 못 본 것은 못 봤다고).
   **`PROD_URL` 이 프로젝트에 없으면 주소를 지어내지 않는다** — 「운영 주소가 설정돼 있지 않아 바로가기를 드릴 수 없습니다」라고 적고, 설정 방법을 사람 몫에 올린다.
2. **질문 도구(AskUserQuestion)로 묻는다** — 선택지 셋:
   - 「바빠서 통과」 — AI 판정으로 확정하고 넘어간다.
   - 「같이 확인」 — 한 항목씩 주소를 띄워 같이 본다. 문제 줄은 후속 스토리 후보로 적고 끝에 한 번에 등재한다.
   - 「일부만」 — 고른 항목만 같이 본다.
3. 반영분이 0건이면 「운영 반영 0건」 한 줄로 끝내고 묻지 않는다. 올릴 수 있는 후보(done · 미반영)가 있으면 목록만 적는다.
4. **답이 없으면 통과로 치지 않는다** — 다음 브리핑에 「미확인」으로 다시 올린다.

## 보고 형식

진행 보고(쉬운 말 · 짧게 · 결론 먼저)를 위에, **`HUMAN_TITLE` 절**을 맨 아래에 둔다. 그 절에는 사람이 결정·승인·수행할 것만 모으고, 항목마다 **무엇을 / 왜 필요한지 / 안 하면 어떻게 되는지** 한두 문장 + 선택지가 여럿이면 장단점 표와 ⭐추천안. 맨 끝은 10절 질문이다. 사람 몫이 0건이면 그 사실 한 줄 + 다음 작업 추천.

## 하지 않는 것

- 브리핑 자체는 읽기 전용이다(결정 확정 기록·평가표 한 줄은 예외 — 커밋은 프로젝트 규칙대로).
- 되돌리기 어려운 실행(기준 갈래 병합·운영 배포·운영 DB·외부 발송·삭제·인증정보)을 하지 않는다. **무엇이 위임됐는지는 프로젝트 CLAUDE.md 를 읽어 판단하고, 위임을 가정하지 않는다.** 위임이 없으면 승인 항목으로 올리기만 한다.
- 결정을 대신 내리기(추천은 하되 확정은 사람 또는 프로젝트가 정한 자율 규칙이 한다).
- **판정 재료가 없는데 GREEN·「이상 없음」·「전량」이라고 쓰기.** 못 센 것은 못 셌다고 적는다.
