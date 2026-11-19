# 다른 PC 에 러너 설치하기 — 한 장 안내서 (2026-10-16)

> 대상: 이 스킬(batch-24-multiAG)을 **새 컴퓨터**에서 처음 돌릴 때. 엔진은 git 에 있어 범용이고, 아래 「PC 마다 손으로」 항목만 따로 한다.
> 규칙 하나: **한 프로젝트의 러너는 한 PC 에서만** 돌린다(두 PC 가 같은 작업 갈래에 밀어 넣으면 충돌). 다른 PC 는 대화형 작업만.

## 0. 준비물(설치·로그인 — git 으로 안 옴)
| 무엇 | 왜 | 확인 명령 |
|---|---|---|
| Node 20 이상 | 엔진 실행 | `node -v` |
| Claude Code CLI + 로그인 | 구현·리뷰 실행기 | `claude auth status`(email 보임) |
| Codex CLI + 로그인 | 교차 리뷰(astra)·강등 구현(sol) | `codex --version` |
| Edge 브라우저 | 실화면 확인(screen-check) · 설명서 촬영 | — |
| git 저장소 접근권 | 프로젝트 clone · auto/* 푸시 | `git ls-remote <repo>` |

## 1. 스킬 받기 → 전역 폴더에 복사
```powershell
git clone https://github.com/uuhiuuhi/claude-skills.git C:\Projects\claude-skills
Copy-Item -Recurse C:\Projects\claude-skills\batch-24-multiAG "$env:USERPROFILE\.claude\skills\"
```
(갱신할 때는 `git pull` 뒤 같은 복사를 다시 한다 — 삭제 없이 덮어쓰기.)

## 2. 프로젝트 두 벌 — 사람용 · 러너용
```powershell
git clone <프로젝트 repo> C:\Projects\<프로젝트>          # 사람이 쓰는 폴더
git clone <프로젝트 repo> C:\Projects\<프로젝트>-runner   # 러너 전용 복사본(필수 · 같은 폴더에서 돌리면 서로 변경을 쓸어 담는다)
```
러너 복사본에 `npm install` 과 비밀값 파일(`.env.local` 의 QA 계정 등)을 **수동으로** 둔다(git 에 없음).

## 3. 엔진 설치 + 설정
러너 복사본 루트에서:
```powershell
node "$env:USERPROFILE\.claude\skills\batch-24-multiAG\install.mjs" --force
```
→ `tools/auto/` 에 엔진이 깔린다. `tools/auto/auto.config.json` 에 `project` · `stateDir`(예 `C:/Users/<이름>/.baroos-auto`) · `epicOrder` 를 적는다(기존 PC 의 설정 파일을 그대로 가져와도 된다 — 경로만 고친다). 상태 폴더는 저장소 **밖**이다.

## 4. 계정 풀(자동 전환) — PC 마다 다시 등록
로그인 열쇠는 보안상 git 에 올리지 않으므로 새 PC 에서 다시 만든다. 러너 복사본 루트에서:
```powershell
claude auth login      # 계정 A 로 로그인(브라우저)
node tools\auto\runtime\account-pool.mjs save <라벨A>
claude auth login      # 계정 B 로 로그인
node tools\auto\runtime\account-pool.mjs save <라벨B>
node tools\auto\runtime\account-pool.mjs status   # 두 계정 사용량 표가 보이면 성공
```
그 뒤 `auto.config.json` 의 `accounts.enabled` 를 `true` 로. **`claude auth logout` 은 쓰지 않는다**(보관한 열쇠가 무효가 된다). 자세한 동작은 [SKILL.md](SKILL.md) 「계정 풀(자동 전환)」.

## 5. 예약 작업(윈도우 전용) — 30분 슬롯 · 감시자 · (선택) 개발 DB 동기화
`ops/run-hidden.ps1` 로 숨은 창에서 돌리는 예약 작업을 등록한다([ops/README.md](ops/README.md) 「새 프로젝트에 붙이는 순서」 4번):
- `<프로젝트>-auto-slots` — 30분 반복 · `run-night.mjs --auto-plan`
- `<프로젝트>-watchdog` — 30분 반복 · 슬롯과 엇갈리게(:20/:50) · `watchdog.mjs`
- (Supabase 프로젝트면) `<프로젝트>-dev-sync` — 10분 반복 · 새 마이그레이션을 개발 DB 에 적용
세 작업 모두 「배터리 전원이면 시작 안 함」·「배터리로 바뀌면 중지」를 **끈다**. 맥·리눅스는 같은 명령을 cron 에 건다(`run-hidden.ps1` 대신 `nohup node … &`).

## 6. 첫 기동과 확인
`runner-start` 스킬(「지금 기동 → 첫 편성 실측」)을 따르거나, 수동으로 `Start-ScheduledTask <프로젝트>-auto-slots` 뒤 `<stateDir>/slots.log` 에 `# 편성 …` 줄과 `[USAGE]` 줄이 찍히는지 본다. 대화 창에서 지켜볼 때는 `ops/watch-current.sh` 를 Monitor 로 띄운다(백그라운드 표기 규칙은 SKILL.md).

## 체크리스트(끝났는지)
- [ ] `claude auth status` 에 계정 이메일 · `codex --version` 응답
- [ ] 러너 복사본에 `tools/auto/` · `auto.config.json`(stateDir 경로가 이 PC 것)
- [ ] `account-pool.mjs status` 에 계정 2개 · `accounts.enabled true`
- [ ] 예약 작업 2~3개 Ready · 배터리 옵션 끔
- [ ] 첫 슬롯 `slots.log` 에 편성 줄 · 핀 오류(exit 3) 없음
- [ ] 이전 PC 의 러너 예약 작업은 **끔**(한 프로젝트 = 러너 한 대)
