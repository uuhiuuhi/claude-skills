# 설치 전 운영 격리 체크리스트 (Codex 5차 D절 · BRIEF 정책 5 잔여 대응 · 2026-09-03)

워커(claude/codex 자식 프로세스)의 **절대경로 git·환경변수 복구 우회**는 프로세스 안 가드만으로 완전 차단이 안 된다(OS 샌드박스 부재). 코드 완화 = PATH shim(git-guard) · fail-closed · 자격증명·helper·askpass·SSH agent 제거 · `GIT_ALLOW_PROTOCOL=none` · 원격 URL 토큰 시작 전 거부 · 원격 ref/reflog 사후 비교. 이 완화가 **accepted residual** 이 되려면 설치 환경에서 아래 중 하나 이상이 강제돼야 한다.

| # | 운영 격리 수단 | 이 PC(jng-os 러너) 현황 | 확인 방법 |
|---|---|---|---|
| A | 러너 워크트리·클론(`C:\Projects\jng-os-auto`)에 **원격 push 권한이 없는 자격증명**만 존재 — 예: 읽기 전용 deploy 토큰 또는 push 권한 없는 GitHub 계정 | ❓ 미확인 — 현재 Windows 자격 증명 관리자에 uuhiuuhi(박사장 본인 · push 가능) 저장 | `git -C C:\Projects\jng-os-auto config --show-origin credential.helper` · 자격 증명 관리자 `git:https://github.com` 항목 |
| B | 러너 계정을 **별도 Windows 사용자**(자격증명 없음)로 분리해 예약 작업이 그 계정으로 실행 | ❌ 현재 박사장 계정으로 실행(Interactive only) | `Get-ScheduledTask BaroOS-auto-slots | Select Principal` |
| C | 워커 실행 중 **네트워크 차단**(방화벽 규칙: node.exe 자식의 github.com 아웃바운드 차단 · 러너 본 프로세스만 허용) | ❌ 없음 | `Get-NetFirewallRule -DisplayName 'BaroOS*'` |
| D | GitHub 측 **브랜치 보호**: main/보호 브랜치 직접 push 금지 + `auto/*` 만 허용 규칙(러너 계정) | ❓ 미확인 | GitHub → Settings → Rules |

**권장 최소 조합** = **A + D**(비용 낮음 · 되돌리기 쉬움): push 권한 없는 토큰으로 러너 클론의 원격을 설정하고, `auto/*` push 는 러너 본 프로세스가 별도 자격증명으로 1회 수행(현재 코드가 이미 「러너 1회 push」 구조). 여기에 D 로 main 직접 push 를 서버에서 막는다.

~~이 체크리스트가 채워지기 전에는 Codex 5차 판정대로 **BRIEF 정책 5 = PARTIAL** 이며, 엔진 교체는 「운영 격리 미비 상태」임을 알고 결정한다.~~
→ **개정(2026-09-03 👤)**: A+D 는 **팀 개발 단계 전환 작업**으로 미루고, 그때까지는 아래 「무료 운영 안전장치 ①~⑥」 + 잔여 위험 한시 수용으로 간다.

## 2026-09-03 👤 확정 — **A+D 는 지금 적용하지 않는다**

박사장 결정: **현재 단계는 「박사장 + AI」 단둘이다.** A(러너 전용 push 불가 자격증명)·D(main 서버 측 보호)는
GitHub Team 플랜 전환과 기계 계정 생성을 요구하는데, 지금 그 비용·계정을 들일 이유가 없다. 대신 **무료 운영
안전장치**를 코드로 갖추고 잔여 위험을 **한시 수용**한다. 정본 문구는 jng-os `CLAUDE.md` 의
「개발·머지·배포 운영 방식 (2026-09-03 👤 확정)」 절이다.

### 지금 적용하는 것 — 무료 운영 안전장치 ①~⑥
| # | 안전장치 | 어디에 |
|---|---|---|
| ① | 무인 작업·야간 배치는 `auto/*` 에만 push | 엔진 `--branch auto/` 강제 · 러너 `BRANCH=auto/<날짜>` |
| ② | 무인 엔진의 `main` 직접 push 를 **코드로 차단**(push 직전 최종 게이트) | `auto-story-finish/push-guard.mjs` = `night-batch-ops/engine/push-guard.mjs`(바이트 동일) · 엔진 `enginePush()` exit 6 · 러너 `pushBranchOnce()` PUSH GUARD STOP |
| ③ | 대화형 AI 는 사람의 명시 지시가 있을 때만 `main` 변경 | jng-os `tools/auto/merge-main.mjs`(절차 정본) |
| ④ | push 전 4종 검사 — 테스트 · 변경 파일 · 금지 경로 · 인증정보 노출 | 엔진: qa 게이트 + 화이트리스트 스테이징 + `DENY_PATH_RE` + `SECRET_RES` / 러너: 통합 게이트(`skipPush`) + `prePushScan()` |
| ⑤ | `main` 변경·운영 배포 기록 | jng-os `_bmad-output/implementation-artifacts/RELEASE-LOG.md` |
| ⑥ | 배포 실패·중대 문제 시 추가 변경 정지 + 복구 방안 우선 보고 | `merge-main.mjs` 실패 출력(멈춘 단계 + 되돌리기 명령) |

증거(테스트): `auto-story-finish/push-guard.test.mjs`(실제 bare origin — 거부 시 원격 ref 불변 · 정상 auto/* 만 1회 push) ·
`auto-story-finish/engine-e2e.test.mjs` `[push-guard]` 절 · `night-batch-ops/engine/worker-pool.test.mjs`(러너에 날 push 0개) ·
jng-os `tools/auto/merge-main.test.mjs`.

### 잔여 위험(한시 수용)
서버 측 보호가 없으므로 **설정 오류·인증정보 유출 시 `main` 이 변경될 수 있다.** 박사장+AI 만 쓰는 초기 개발
단계에서 한시 수용하고, `main` 변경은 전부 RELEASE-LOG 에 남긴다. 위 표의 차단은 **우리 코드가 미는 경로**에만
걸린다 — 사람이 직접 치는 `git push origin main` 은 막지 않는다(그건 승인 절차의 몫이다).

### A+D 도입 시점 — 조건 5개를 **모두** 만족한 뒤, 팀 개발 단계 전환과 함께
① BaroOS MVP 완료 ② 계획된 주요 추가 기능 구현 ③ 직원이 운영 환경에서 1개월 이상 사용 ④ 직원이 사용 경험
기반 개선 아이디어를 내기 시작 ⑤ 각 팀이 자기 GitHub 계정으로 저장소에 접근할 필요가 실제로 생김.
**1개월 경과만으로 자동 전환하지 않는다.** 아래 「실측 추기」의 ①~⑥ 순서는 그때 쓰는 **팀 개발 단계 전환 작업**
목록이며, 지금의 설치·엔진 교체를 막는 조건이 아니다(Codex 5~8차의 「must fix before install」 판정은 이 결정으로
**팀 개발 단계 전환 작업**으로 재분류한다).

### 엔진 교체 조건(개정)
종전: 「A+D 적용 증거」 → **개정: 「무료 운영 안전장치 ①~⑥ 실측 GREEN」** + 러너 유휴(lock 없음) 시점 +
첫 야간은 `providers.codex.roles=["review"]` · 오케스트레이터 꺼짐 · autofinish `--diagnose-only`.

## 2026-09-03 실측 추기 (👤 「A+D 하자」 승인 후 실행 시도)
- **D 차단**: `gh api repos/jngsystem-corp/baro/rulesets` · `branches/main/protection` → HTTP 403 「Upgrade to GitHub Pro or make this repository public」. 비공개 저장소의 브랜치 보호·룰셋은 **조직 Team 플랜(또는 Pro)** 이 필요하다. 저장소 공개는 고객 정보 마스킹 제약상 불가.
- **A 전제**: 러너 클론 `jng-os-auto` 의 자격증명은 시스템 gitconfig `credential.helper=manager`(박사장 본인 계정 uuhiuuhi · admin). 별도 push 제한 자격증명 = **기계 계정(machine user)** 이 필요하며 계정 생성·토큰 발급은 사람이 한다(클로드는 계정·비밀정보를 만들지 않는다).
- 순서: ① 조직 플랜 Team 전환(D 가능해짐) ② 기계 계정 `jngsystem-bot` 생성 → baro 저장소 Write 초대 ③ 그 계정의 fine-grained PAT(Contents: Read/Write · baro 한정) 발급 ④ 러너 클론 원격을 그 계정으로(`git credential-manager` 에 별도 항목 · 클론 `credential.useHttpPath=true` 로 분리) ⑤ 룰셋: main 「직접 push 금지 · PR 필수」 bypass = 조직 admin(uuhiuuhi)만, `auto/**` 는 허용 ⑥ 클로드가 실측(러너 계정으로 main push 시도 → 거부) 후 엔진 교체.
