# 격리 실행 환경 5줄 (Windows · Git Bash + PowerShell)

```bash
# 1) 대상 커밋을 별도 워크트리로(본 창·다른 창의 작업 트리 무접촉)
git -C C:/Projects/jng-os worktree add "<scratchpad>/e2e-wt" <sha> --detach
cp C:/Projects/jng-os/.env.local "<scratchpad>/e2e-wt/.env.local"      # QA 계정은 이 파일에서 스크립트가 읽는다
```
```powershell
# 2) node_modules 는 junction(복사 0)
New-Item -ItemType Junction -Path "<scratchpad>\e2e-wt\node_modules" -Target 'C:\Projects\jng-os\node_modules' | Out-Null
```
```bash
# 3) dev 서버 — 본 창 미리보기(5173)와 분리 · 백그라운드
cd "<scratchpad>/e2e-wt" && npx vite --port 5174 --strictPort --host 127.0.0.1 > "<scratchpad>/vite-5174.log" 2>&1 &
# 4) playwright-core 는 저장소 밖에만
mkdir -p "<scratchpad>/e2e-tools" && cd "<scratchpad>/e2e-tools" && npm init -y >/dev/null && npm i playwright-core --no-audit --no-fund
# 5) 실행
node check-<story>.mjs
```

정리:
```powershell
(Get-Item "<scratchpad>\e2e-wt\node_modules").Delete()   # 링크만 삭제 — 실 node_modules 무손상
```
```bash
git -C C:/Projects/jng-os worktree remove --force "<scratchpad>/e2e-wt"
```
vite 종료: 포트 5174 의 PID 를 `netstat -ano | findstr :5174` 로 찾아 `taskkill /PID <pid> /F`.
