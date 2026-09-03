# claude-skills

Claude Code 스킬 백업. 네 개가 들어 있다.

| 스킬 | 하는 일 |
|---|---|
| [`auto-story-finish`](auto-story-finish/) | BMad 스토리 배치를 create → dev → review 순으로 무인 완료한다(헤드리스 엔진). 단계별 모델 자동 선택, 인증 만료·사용량 한도 감지와 복구 대기, qa RED 시 중단, 옵트인 커밋·푸시(가드 하에). **v3(2026-09-02)**: 워커 프로바이더 계층 — `claude -p` 와 **`codex exec`** 를 모델 스펙(`"opus"` / `"codex"` / `"codex:<model>"`)으로 고른다 · Codex 리뷰는 read-only + 구조화 JSON → 엔진이 원장 기재 · 한도 시 프로바이더 전환(스토리당 1회) · 자동 수리 루프(`--auto-repair`) · 테스트 무결성 검사 · 검증 매니페스트. 플래그 없으면 종전 동작. |
| [`dev-status`](dev-status/) | BMad v6 프로젝트의 **읽기 전용** 개발 현황판. `epics.md`·`sprint-status.yaml`·스토리 md·배치 로그를 규칙만으로 판정해 진행률·단계 배지·파일 겹침·불일치·다음 할 일을 로컬 HTML 한 장으로 낸다. 외부 의존성 0, LLM 호출 0. |
| [`night-batch-ops`](night-batch-ops/) | **프로젝트 설치형** 24시간 **무정지** 무인 배치 체계 — 30분 반복 예약 **1개**(무기한 · 창 구분 없음) · 심박 lock(죽은 프로세스는 자동 탈취, 판정 불능은 6시간 심박으로 가름) · **선형 승계**(미머지 `auto/*` 가 있으면 쉬지 않고 그 브랜치를 이어 쌓는다 — 「미머지면 휴면」 폐지) · **공회전 가드**(엔진 로그 말고 바뀐 게 없는 라운드면 연속 루프를 끝내고 다음 정시 실행에 넘긴다) · 라운드마다 **하향 동기**(`origin/main` 병합 · 충돌은 해소/보류/중단 3처분) · 큐 자동 편성(규칙 10종, LLM 0)에 **무진전 연속 상한**(같은 스토리가 진전 없이 반복될 때만 제외) · **한도 대기(exit 5) 원장 환불** · 병렬 실행(File List 서로소 2폭, 워크트리 분리 + cherry-pick landing) · 중요도별 모델 배정 · 텔레그램 원격 명령(`/status` `/merge` `/resume` `/extend N` — 코드 되묻기) · 알림. `auto-story-finish` 를 엔진으로 쓴다. **원장 해석 단일 소스**(`story-ledger.mjs` — 굵게·인용·부정문 표기 흔들림 흡수) · **지출 한도 차단 알림**(원인을 이름으로 · 반복 억제) · **소진 모델 짝 단위 회피**. 프로젝트 고유값은 설치되는 `auto.config.json` 이 소유. |

**2026-09-02 통합**: 종전의 4시간 슬롯판(`night-batch-ops-4h-slots`)과 무정지판을 **`night-batch-ops`
하나로 합쳤다.** 4시간 슬롯판은 시계가 밤에만 열려 있어 낮 산출물을 이어받지 못했고, 그 문제를
무정지판이 러너 쪽에서 풀었기 때문에 두 갈래를 유지할 이유가 없어졌다. 옛 판에서 올라오는
경로는 `night-batch-ops/SKILL.md` 의 「종전 4시간 슬롯판에서 올라올 때」 절에 있다.

## 설치

`~/.claude/skills/` 아래에 폴더째 두면 된다.

```bash
git clone https://github.com/uuhiuuhi/claude-skills.git
SKILLS="$PWD/claude-skills"                 # 클론 절대경로 — 아래에서 계속 쓴다
cp -r "$SKILLS/dev-status"        ~/.claude/skills/
cp -r "$SKILLS/auto-story-finish" ~/.claude/skills/

# 야간 배치 체계는 전역 스킬이 아니라 **대상 프로젝트에** 설치한다(아래 「쓰는 법」).
# install.mjs 는 "현재 폴더"를 대상 프로젝트로 보므로, 반드시 그 루트로 옮겨서 실행한다 —
# 클론 폴더에서 그냥 치면 엉뚱한 곳에 설치되거나 package.json 이 없어 멈춘다.
cd /path/to/my-project                      # package.json 이 있는 폴더
node "$SKILLS/night-batch-ops/install.mjs"
```

Windows PowerShell:

```powershell
git clone https://github.com/uuhiuuhi/claude-skills.git
$Skills = (Resolve-Path .\claude-skills).Path   # 클론 절대경로
Copy-Item -Recurse "$Skills\dev-status"        "$env:USERPROFILE\.claude\skills\"
Copy-Item -Recurse "$Skills\auto-story-finish" "$env:USERPROFILE\.claude\skills\"

# 야간 배치 체계는 전역 스킬이 아니라 **대상 프로젝트에** 설치한다(아래 「쓰는 법」).
# install.mjs 는 "현재 폴더"를 대상 프로젝트로 보므로, 반드시 그 루트로 옮겨서 실행한다.
Set-Location C:\path\to\my-project              # package.json 이 있는 폴더
node "$Skills\night-batch-ops\install.mjs"
```

## 쓰는 법

- **현황판**: 프로젝트 폴더에서 "개발 현황판 열어줘" 라고 하거나, 직접
  `node ~/.claude/skills/dev-status/serve.mjs` (Windows: `node "$env:USERPROFILE\.claude\skills\dev-status\serve.mjs"`).
  BMad v6 산출물이 없으면 빈 화면을 그리지 않고 확인한 경로를 나열하며 종료한다.
- **배치**: "S-J 부터 S-M 까지 마무리" 처럼 스토리 범위를 말하면 된다. 자세한 계약은 각 `SKILL.md`.
- **야간 배치 체계**: 대상 프로젝트 루트에서 `node <클론>/night-batch-ops/install.mjs` →
  `auto.config.json` 의 `epicOrder` 를 채우고 → (승인 후) `--register-tasks` 로 예약 등록.
  Claude 에게는 "이 프로젝트에 야간 배치 적용해줘" 라고 하면 된다. 계약 전문은
  `night-batch-ops/SKILL.md`.
  상태·로그·심박·알림 자격증명은 저장소 밖 `~/.claude-auto/<프로젝트>` 에 둔다
  (환경변수 `AUTO_BATCH_STATE_DIR` 로 바꿀 수 있다).

네 스킬 모두 Node 20 이상. 외부 npm 의존성 없음.

## 표현 중립화 완료 (2026-08-27)

내부 운영 맥락이던 표현들 — 정책 승인자 호칭, 다른 프로젝트 이름과 그 성격, 실측 예시의
저장소명·경로 — 을 전부 중립 표현("승인", "한 프로젝트", "내부 프로젝트")으로 바꿨다.
실측 수치와 날짜는 근거 가치가 있어 그대로 두었다(출처만 익명화).

새 프로젝트에 받아 써도 특정 프로젝트를 가리키는 지시가 없다. **저장소는 공개(public)다**
(2026-09-02 확인·유지 결정). 회사명·고객명·금액·시크릿은 싣지 않되, 주석의 실사고 서술
(무엇이 왜 깨졌는지)은 남긴다 — 그것이 이 규칙들이 존재하는 이유이기 때문이다.

이후 무정지판을 같은 중립 기준으로 추가했고, 2026-09-02 에 4시간 슬롯판을 접어
`night-batch-ops` 하나로 통합했다(중립 기준은 통합본에도 그대로 적용된다).

## 가드 테스트 (2026-08-30 신설)

```bash
node auto-story-finish/failure-classify.test.mjs
```

의존성 0 · 단독 실행. 엔진 소스를 직접 읽어 **실패 문구 분류 규율**을 문다.

왜 생겼나: 「모델 한도」 주제가 다섯 번 반복됐고, 다섯 번째의 진짜 원인은 사다리도
사용량도 아니라 **월 지출 한도(monthly spend limit)를 사용량 한도와 같은 갈래로 묶어
「기다리면 풀린다」고 안내한 것**이었다. 앞선 라운드에서 그 문구를 패턴에 넣으면서
주석에는 「월 한도는 대기로 안 풀린다」고 정확히 적어 놓고도 **대기하는 갈래에 분류**했다 —
진단은 맞고 처방이 반대였다. 그때는 한 모델만 걸려 사다리가 넘겨 피해가 0이라 아무도
밟지 않았고, 전 모델이 걸린 날 슬롯마다 30분씩 헛기다리며 수 시간을 버렸다.

교훈은 하나다 — **규정이 주석에만 있으면 반복된다.** 그래서 이 테스트가 규율을 집행한다:
spend 는 limit 과 다른 갈래 · spend 안내에 「기다리」 금지 · spend 는 대기·사다리를 타지
않음 · 패턴 재오염 금지. 엔진을 고칠 때 이 테스트를 먼저 돌린다.

## 테스트 전체 (2026-09-02 · `node --test`)

```bash
node --test --test-concurrency=2 $(git ls-files -co --exclude-standard | grep '\.test\.mjs$')
# 저장소 루트 — 의존성 0 · LLM 호출 0 · 실 알림 0 · 실제 git·실제 프로세스 사용(종단 3종: engine-e2e · e2e-parallel · autofinish-e2e)
# ⚠ 2026-09-03: Windows 에서 기본 동시성(CPU 수)으로 돌리면 종단 3종이 서로 프로세스를 뺏어 0xC0000142(STATUS_DLL_INIT_FAILED)로
#   간헐 실패한다(같은 커밋에서 48건→76건으로 실행마다 달랐다). 로직 결함이 아니므로 동시성 2 로 고정한다. 2026-09-03 실측: 702/702 GREEN.
```

| 묶음 | 내용 |
|---|---|
| `night-batch-ops/engine/{runner-rules,plan-queue,telegram-rules}.test.mjs` | 원 프로젝트의 vitest 79종을 이식한 **기준선**(엔진 변경 전에 GREEN 확인 후 확장) |
| `night-batch-ops/engine/worker-pool.test.mjs` | 다중 프로바이더 설정 정규화 · 병렬 폭/위험 · 배정 · 풀 스케줄 · 통합 게이트 판정 · 편성기 Codex 리뷰 배정 · 러너 배선 앵커 |
| `night-batch-ops/engine/e2e-parallel.test.mjs` | **종단 6 시나리오** — 스텁 claude/codex(.cmd · `CLAUDE_BIN`/`CODEX_BIN`) + 실제 git: 병렬 풀 → 엔진 → landing → 통합 게이트 PASS / RED 되돌림 / Codex 한도 폴백 / 워커 실패 격리 / dry-run 무실행 / Claude 전용 하위 호환 |
| `auto-story-finish/{providers,quality-rules,story-writes,engine-guards}.test.mjs` | 프로바이더 계층 · 품질 규칙 · 원장 쓰기 · 엔진 소스 앵커(현황판 로그 줄 형식·가드 보존) |

## Codex 워커 (2026-09-02)

`night-batch-ops` 는 이제 **Claude + Codex 를 독립 워커**로 쓸 수 있다(설정 `providers.codex.enabled`). 없으면 Claude 전용으로
그대로 돈다. 계약·안전선·로그·한계는 `night-batch-ops/SKILL.md` 의 「다중 프로바이더 하네스」 절과
`night-batch-ops/references/multi-provider-design.md`(설계 · 적대 검토 40건 · 실측)에 있다.
