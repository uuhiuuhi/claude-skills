# 설치 전 운영 격리 체크리스트 (Codex 5차 D절 · BRIEF 정책 5 잔여 대응 · 2026-09-03)

워커(claude/codex 자식 프로세스)의 **절대경로 git·환경변수 복구 우회**는 프로세스 안 가드만으로 완전 차단이 안 된다(OS 샌드박스 부재). 코드 완화 = PATH shim(git-guard) · fail-closed · 자격증명·helper·askpass·SSH agent 제거 · `GIT_ALLOW_PROTOCOL=none` · 원격 URL 토큰 시작 전 거부 · 원격 ref/reflog 사후 비교. 이 완화가 **accepted residual** 이 되려면 설치 환경에서 아래 중 하나 이상이 강제돼야 한다.

| # | 운영 격리 수단 | 이 PC(jng-os 러너) 현황 | 확인 방법 |
|---|---|---|---|
| A | 러너 워크트리·클론(`C:\Projects\jng-os-auto`)에 **원격 push 권한이 없는 자격증명**만 존재 — 예: 읽기 전용 deploy 토큰 또는 push 권한 없는 GitHub 계정 | ❓ 미확인 — 현재 Windows 자격 증명 관리자에 uuhiuuhi(박사장 본인 · push 가능) 저장 | `git -C C:\Projects\jng-os-auto config --show-origin credential.helper` · 자격 증명 관리자 `git:https://github.com` 항목 |
| B | 러너 계정을 **별도 Windows 사용자**(자격증명 없음)로 분리해 예약 작업이 그 계정으로 실행 | ❌ 현재 박사장 계정으로 실행(Interactive only) | `Get-ScheduledTask BaroOS-auto-slots | Select Principal` |
| C | 워커 실행 중 **네트워크 차단**(방화벽 규칙: node.exe 자식의 github.com 아웃바운드 차단 · 러너 본 프로세스만 허용) | ❌ 없음 | `Get-NetFirewallRule -DisplayName 'BaroOS*'` |
| D | GitHub 측 **브랜치 보호**: main/보호 브랜치 직접 push 금지 + `auto/*` 만 허용 규칙(러너 계정) | ❓ 미확인 | GitHub → Settings → Rules |

**권장 최소 조합** = **A + D**(비용 낮음 · 되돌리기 쉬움): push 권한 없는 토큰으로 러너 클론의 원격을 설정하고, `auto/*` push 는 러너 본 프로세스가 별도 자격증명으로 1회 수행(현재 코드가 이미 「러너 1회 push」 구조). 여기에 D 로 main 직접 push 를 서버에서 막는다.

이 체크리스트가 채워지기 전에는 Codex 5차 판정대로 **BRIEF 정책 5 = PARTIAL** 이며, 엔진 교체는 「운영 격리 미비 상태」임을 알고 결정한다.
