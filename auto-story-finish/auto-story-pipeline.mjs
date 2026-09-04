#!/usr/bin/env node
// auto-story-pipeline.v2.mjs — 헤드리스 BMad 배치 파이프라인 v2 (create → dev → qa게이트 → review)
// 스킬 `auto-story-finish`이 구동하는 결정적 엔진. 단계별 모델은 선택사항 —
// `--*-model` 미지정 시 `--model` 플래그 자체를 생략해 현재 CLI의 기본 모델을 쓴다
// (특정 모델명이 없는 환경(claude·codex 등 어디서든)에서도 모델을 찾아 헤매지 않음).
//
// 전역 정본 (2026-08-08 v3): ~/.claude/skills/auto-story-finish/ 에 스킬과 함께 설치되는
// 프로젝트 중립 엔진. (과거 v1→v2 스왑 절차는 완료되어 폐기.)
//
// v1 → v2 변경 (2026-07-13, A/B 재검토 심사 근거):
//   (U1) state.json 이어하기 — 완료 단계 기록, 재실행 시 자동 skip. --force = dev/review 재실행
//        (재실행되는 단계의 하위 기록 자동 무효화). create는 스토리 파일 존재 시 항상 skip(--force 무시).
//   (U2) 사후조건 검사 — create 후 스토리 파일 존재, dev/review 후 스토리 산출물 갱신(mtime).
//        exit=0 이어도 산출물 무변경이면 no-op 차단(exit 4). exit≠0 이어도 사후조건 통과면
//        "작업 완료 후 비정상 종료"로 경고 후 계속(stream-idle 거짓 실패 방어 — Epic 13 실사례).
//   (U3) 인증 오류 감지 — exit≠0 + 사후조건 실패 + 401/unauthorized 패턴이면 AUTH STOP(exit 3)
//        + "claude 재로그인 후 같은 명령 재실행(=이어하기)" 안내 (2026-07-08 토큰만료 사고 대응).
//   (U4) run-summary.log 누적 append — v1은 배치마다 덮어써 이전 기록이 소실됐음(L105 writeFileSync).
//   (U5) 단계 타임아웃 — 기본 120분(실측 최장 dev 53분의 2배+). 행(hang) 무한대기 방지.
//   (U6) 스토리 경계 인증 프로브 — 각 스토리 시작 전 1콜(수 초)로 인증 확인.
//        기본 = CLI 기본 모델. 저가 모델이 있는 환경이면 --probe-model(또는 PROBE_MODEL env)로 지정 가능.
//        토큰 만료를 스토리 "중간"이 아닌 "경계"에서 감지 = 배치 분할이 주던 안전 효과를 자동화.
//        (전량 skip 될 스토리는 프로브 생략 — 재개 실행에서 헛 호출 방지.)
//   (U7) --wait-auth-min N — 인증 오류 시 즉시 종료(exit 3) 대신 최대 N분 동안 재로그인을
//        폴링 대기(AUTH_POLL_SEC env, 기본 300초)하고, 복구되면 멈췄던 단계부터 자동 재개.
//        ⚠️ 진짜 "토큰 갱신"은 Claude Code CLI 로그인 시스템의 영역이라 엔진이 못/안 한다 —
//        사람이 다른 터미널에서 재로그인하면 이어가는 방식이 실현 가능한 최대치.
//   (U8) 사용량 한도(usage/rate limit) 감지 — 인증 오류와 구분해 처리(2026-08-08).
//        한도 초과는 재로그인이 아니라 "리셋 대기"로 복구되므로, --wait-auth-min 대기 모드에서
//        같은 폴링 루프로 리셋을 기다렸다가 자동 재개한다. 즉시 중단 시 exit 5.
//   (테스트) CLAUDE_BIN env 로 claude 실행 파일 오버라이드 가능(스텁 테스트용, 기본 "claude").
//
// v3 — 다중 프로바이더 하네스 (2026-09-02 · 설계: night-batch-ops/references/multi-provider-design.md):
//   (P1) 워커 프로바이더 계층 providers/{index,claude,codex}.mjs — 모델 스펙 문자열로 고른다.
//        "opus" = claude(종전 그대로) · "codex" · "codex:<model>". 큐·러너 스키마 무변경(하위 호환).
//        codex 는 스펙이 요청됐을 때만 감지(`codex --version` + `login status`)하고, 불가(미설치·미인증·
//        cwd 프라이버시)면 claude 대체 모델로 **폴백 + 경고** — Codex 문제로 배치가 서지 않는다.
//   (P2) Codex 리뷰 = read-only 샌드박스 + 구조화 JSON(--output-schema) → **엔진이** 원장 형식으로
//        스토리 파일에 기재하고 bmad-code-review 와 같은 상태 전이(findings → in-progress · 0건 → done)를
//        스토리 Status + sprint-status.yaml 에 반영. Codex dev/repair = workspace-write(네트워크 옵션).
//   (P3) 한도 사다리 확장 — 같은 프로바이더 차순위 → 다른 프로바이더(허용 역할 · 전환 1회 상한). spend 불변.
//   (P4) 품질 루프 — dev 뒤 테스트 무결성 검사 + qa 게이트 RED 시 자동 수리(--auto-repair N · 같은 원인
//        --repair-same-cause N). 기본 0 = 종전 동작(qa RED 즉시 STOP). 예산 소진 = 종전 STOP + 에스컬레이션 6절.
//   (P5) 검증 매니페스트 auto-pipeline-logs/<story>-verification.json (--no-manifest 로 끔).
//   (P6) 워커 커밋 가드 — dev/repair 워커가 HEAD 를 움직이면(직접 커밋) COMMIT GUARD STOP(exit 6).
//   (P7) 관찰 로그 `[<story>][CLAUDE|CODEX][DEV|REVIEW|REPAIR]` · `[<story>][QUALITY][PASS|FAIL]` —
//        현황판이 읽는 종전 줄(`→ [story] stage (…)` · `exit=`)은 그대로 둔다.
//
// 가드레일 (하드코딩 — 호출자가 끌 수 없음, v1과 동일):
//   · 스토리 순차 처리(호출자가 준 순서 = 의존성 순서)
//   · dev 후 qa 게이트 RED → 배치 즉시 중단(거짓 PASS 차단) — v3: 수리 예산이 있으면 그 안에서만 재시도
//   · nested claude 인스턴스는 git commit/push 절대 안 함 (프롬프트 금지 + pipeline-settings deny)
//   · (U9, 2026-08-17 승인) 엔진 자체의 스토리 단위 커밋·푸시는 **옵트인** — `--commit`(+`--branch auto/<x>` +`--push`).
//     기본(플래그 없음) = 커밋·푸시 0. 켜도 하드 가드: 화이트리스트 pathspec 스테이징 · 금지 경로(.env*, 외부 *.log, scratch-*, *.local.*, 키 파일) 검출 시 STOP ·
//     스테이징 diff 시크릿 패턴 스캔(걸리면 unstage + SECRET STOP exit 6) · 브랜치는 반드시 `auto/` 접두사(main·기타 금지, --push 는 --branch 필수) ·
//     커밋 시점 = 스토리의 마지막 단계 완료 후 1회 · amend·force·태그 0 · 푸시 실패는 경고 후 계속(아침 사람 재시도).
//   · 단계별 로그를 _bmad-output/implementation-artifacts/auto-pipeline-logs/ 에 기록
//
// exit code: 0=완료 / 1=단계·qa 실패 / 2=인자 오류 / 3=인증 오류(재로그인 필요) / 4=no-op(산출물 무변경)
//            / 5=사용량 한도(리셋 후 같은 명령 재실행=이어하기) / 6=커밋 가드 STOP(금지 경로·시크릿 패턴·브랜치 규칙 위반)
//
// 사용 (실행 cwd = 대상 프로젝트 루트):
//   node ~/.claude/skills/auto-story-finish/auto-story-pipeline.mjs \
//     --stories "11-1,11-2,11-3" \
//     --stages create,dev,review \
//     [--create-model X] [--dev-model X] [--review-model X] [--probe-model X]   (X = claude 별칭 | codex | codex:<model>)
//     [--qa "npm run qa"] [--e2e "<배치 종료 후 1회 실행할 e2e 명령>"] [--ntfy-topic X] \
//     [--force] [--stage-timeout-min 120] [--wait-auth-min 0] [--dry-run]
//     [--commit] [--branch auto/<이름>] [--push] [--commit-paths "src,tests,..."]
//     [--auto-repair 0] [--repair-same-cause 3] [--integrity on|auto|off] [--no-manifest] [--defer-push] [--pipeline-settings <경로>]
//     [--providers claude,codex] [--codex-roles review] [--codex-network on|off] [--codex-cwd-marker <파일>] [--no-codex]
//   (모델 플래그 전부 선택사항 — 미지정 = CLI 기본 모델 / 커밋 플래그 전부 옵트인 — 미지정 = 커밋·푸시 0 / v3 플래그 미지정 = 종전 동작)

import { spawnSync } from "node:child_process";
import {
  mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseModelSpec, formatModelSpec, shownSpec, detectProviders, providersLine, resolveWorkerSpec, nextWorkerDown, enforceCrossSpec } from "./providers/index.mjs";
import { buildClaudeCommand, runClaudeWorker } from "./providers/claude.mjs";
import { buildCodexCommand, runCodexWorker, classifyCodexFailure, codexFailureText, inspectCwdForCodex, codexReviewPrompt, codexDevPrompt, codexRepairPrompt, renderReviewFindings, parseReviewJson, validateReviewRun, redactSecrets, isSensitivePath, stripSensitiveFileSections, hideSensitiveFiles, restoreEnvFiles, withCodexSlot, slotStaleMsFor } from "./providers/codex.mjs";
import { createGitGuard, findCredentialRemotes, stripRemoteCredentials } from "./providers/git-guard.mjs";
import { assertSafeModel, assertSafePath, normalizeCommand, spawnSafe } from "./providers/spawn-safe.mjs";
import { safeGitPush } from "./push-guard.mjs";
import { strengthenCompletion } from "./completion-rules.mjs";
import { insertReviewFindings, setStoryStatus, setSprintStatus, appendDeferredWork, appendDecisionsInbox, countOpenFindings } from "./story-writes.mjs";
import { detectGates, parseQaChain, classifyQaFailure, repairDecision, testIntegrityFindings, escalateRepairIntroduced, securityTriggers, performanceTriggers, buildVerificationManifest, escalationReport } from "./quality-rules.mjs";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const CODEX_REVIEW_SCHEMA = join(SKILL_DIR, "providers", "codex-review.schema.json");

// ---- 인자 파싱 ----
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const stories = (opt("stories", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const stages = (opt("stages", "create,dev,review") || "").split(",").map((s) => s.trim()).filter(Boolean);
// 단계 화이트리스트 — mockup(AI 목업 초안)·replan(시니어 재계획)은 자율운전(2026-09-03)에서 추가됐다.
// 모르는 단계 이름은 조용히 아무것도 안 하는 대신 **시작 전에** 거부한다(exit 2).
const KNOWN_STAGES = ["create", "mockup", "replan", "dev", "review"];
{
  const bad = stages.filter((s) => !KNOWN_STAGES.includes(s));
  if (bad.length) {
    console.error(`✖ 알 수 없는 단계: ${bad.join(", ")} — 허용 = ${KNOWN_STAGES.join(",")}`);
    process.exit(2);
  }
}
// 자율운전(--autonomy full · 2026-09-03 👤): 결정을 사람에게 넘기지 않는다 — dev/replan 이 ⭐추천안을 채택하고
// 인박스 「🔵 사후 확인」에 근거를 남긴다. 사람 몫은 되돌릴 수 없는 실행(main 머지·배포·운영 DB·외부 발송)뿐이다.
const autonomy = opt("autonomy", "guarded");
if (!["guarded", "full"].includes(autonomy)) {
  console.error(`✖ --autonomy 는 guarded | full 만 허용: ${JSON.stringify(autonomy)}`);
  process.exit(2);
}
const FULL = autonomy === "full";
const replanHint = opt("replan-hint", ""); // 프롬프트 본문(stdin)에만 실린다 — argv 로 나가지 않는다
const mockupsDir = (opt("mockups-dir", "mockups") || "mockups").replace(/[\\/]+$/, "");
const mockupVerdicts = opt("mockup-verdicts", "tools/dev-status/mockup-verdicts.json") || "tools/dev-status/mockup-verdicts.json";
// 빈 값 = --model 플래그 생략 = 현재 CLI 기본 모델 (환경 불문 안전 기본값)
// v3: 값은 「모델 스펙」이다 — 접두사 없으면 claude 별칭(종전) · "codex" · "codex:<model>".
const models = {
  create: opt("create-model", ""),
  mockup: opt("mockup-model", ""),
  replan: opt("replan-model", ""),
  dev: opt("dev-model", ""),
  review: opt("review-model", ""),
};
const probeModel = opt("probe-model", process.env.PROBE_MODEL || "");
// (2026-09-02 #6/§8) 모델 스펙은 큐·설정 파일에서 온다 — `opus & git push origin HEAD:main` 같은 값이
// 워커 명령줄로 흘러가면 안 된다. 파싱 직후 허용 문자집합 밖이면 **실행 전에** 거부한다(exit 2 · 부작용 0).
for (const [k, v] of [...Object.entries(models), ["probe", probeModel]]) {
  if (!v) continue;
  try { assertSafeModel(v, `--${k}-model`); } catch (e) {
    console.error(`✖ 모델 스펙 거부 — --${k}-model 에 셸 메타문자 또는 허용되지 않은 문자가 있다: ${JSON.stringify(String(v))}`);
    console.error(`   허용 = 영문·숫자와 . _ - : / @ (공백·& | ; 등 금지). 큐·설정의 모델 값을 고친 뒤 재실행하세요. (${e?.code ?? "UNSAFE_ARGUMENT"})`);
    process.exit(2);
  }
}
const shownModel = (m) => shownSpec(m); // 종전 "cli-default" 문구 보존 · codex 는 "codex:default"
const qaCmd = opt("qa", "npm run qa");
const e2eCmd = opt("e2e", ""); // 배치 종료(전 스토리 완주) 후 1회 실행 — 프로젝트가 명령을 지정한 경우에만
// (2026-08-08) 배치 상태 전이 푸시 알림 — ntfy.sh, fire-and-forget. 미설정 = 무음.
function readNtfyTopicFile() {
  try {
    return readFileSync(join(homedir(), ".claude", "ntfy-topic.txt"), "utf8").trim();
  } catch {
    return "";
  }
}
const ntfyTopicRaw = opt("ntfy-topic", process.env.PIPELINE_NTFY_TOPIC || readNtfyTopicFile());
const ntfyTopic = ntfyTopicRaw === "off" ? "" : ntfyTopicRaw; // --ntfy-topic off = 무음
const dryRun = flag("dry-run");
const force = flag("force");
// (U9) 옵트인 커밋·푸시 — 기본 전부 꺼짐
const doCommit = flag("commit") || flag("push");
const doPush = flag("push");
const branchName = opt("branch", "");
const COMMIT_PATHS_DEFAULT = "src,tests,supabase,tools,public,.github,_bmad-output,package.json,package-lock.json,wrangler.jsonc,.env.example,.gitignore,index.html,vite.config.ts,tsconfig.json,tsconfig.app.json,tsconfig.node.json,eslint.config.js,components.json,CLAUDE.md,README.md";
const commitPaths = (opt("commit-paths", COMMIT_PATHS_DEFAULT) || "").split(",").map((s) => s.trim()).filter(Boolean);
if (doPush && !/^auto\//.test(branchName)) {
  console.error("✖ --push 는 --branch auto/<이름> 이 필수(main·기타 브랜치 푸시 금지). 예: --branch auto/2026-08-17");
  process.exit(2);
}
if (branchName && !/^auto\//.test(branchName)) {
  console.error("✖ --branch 는 auto/ 접두사만 허용(정본 main 은 사람 승인 머지로만 바뀐다).");
  process.exit(2);
}
// (N1 · 2026-09-02 2차 리뷰) 순차 경로는 **스토리마다 즉시 push** 했고 배치 e2e 는 전 스토리 처리 뒤에 돌았다 —
// 두 스토리가 각자 qa GREEN 으로 원격에 올라간 뒤 결합 e2e 가 RED 면 프로세스는 exit 1 인데 **원격에는 이미
// RED 조합이 남는다**. 통합 게이트(`--e2e`)가 있으면 스토리별 push 를 보류하고 전부 GREEN 뒤 **한 번만** 민다.
// `--defer-push` = 러너가 자기 통합 게이트를 따로 돌릴 때 쓰는 명시 스위치(엔진 e2e 가 없어도 보류).
const deferPushFlag = flag("defer-push");
const deferPush = doPush && (Boolean(e2eCmd) || deferPushFlag);
let pendingPush = false; // 보류 중인 커밋이 하나라도 있는가(배치 e2e GREEN 뒤 1회 push 의 조건)
const stageTimeoutMs = Number(opt("stage-timeout-min", "120")) * 60 * 1000;
const waitAuthMin = Number(opt("wait-auth-min", "0")); // 0 = 인증(exit 3)·한도(exit 5) 오류 시 즉시 중단. 인증·한도 대기 공용.
const authPollSec = Number(process.env.AUTH_POLL_SEC || "300"); // 대기 모드 폴링 간격

// v3 — 품질 루프·프로바이더 옵션(전부 미지정 = 종전 동작)
const autoRepair = Math.max(0, Number(opt("auto-repair", "0")) || 0); // 총 수리 시도 상한. 0 = 종전(qa RED 즉시 STOP)
const repairSameCause = Math.max(1, Number(opt("repair-same-cause", "3")) || 3);
// (F8/정책 10 · 2026-09-02 2차 리뷰) 기본값을 **on** 으로 올린다 — 종전 기본 `auto` 는 `--auto-repair 0`
// (=기본 직접 실행)에서 검사를 통째로 껐고, 그 경로에서 워커가 새로 만든 `.only`·skip·ts-ignore 가
// 아무 검사도 받지 않았다. `--integrity off` 는 남긴다(명시 옵트아웃) · `auto` = 종전 조건부 동작.
const integrityMode = opt("integrity", "on"); // on(기본) · auto(autoRepair>0 일 때만) · off
const integrityEnabled = integrityMode === "on" || (integrityMode === "auto" && autoRepair > 0);
const writeManifest = !flag("no-manifest");
const noCodex = flag("no-codex");
const providersOpt = (opt("providers", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const codexRoles = (opt("codex-roles", "review") || "").split(",").map((s) => s.trim()).filter(Boolean);
const codexNetwork = opt("codex-network", "off") === "on"; // 기본 닫힘 — 열면 workspace-write 세션이 push·외부 전송을 할 수 있다(옵트인)
const codexMax = Math.max(1, Number(opt("codex-max", "1")) || 1); // 머신 전역 codex 동시 실행 상한(같은 auth.json 동시 사용 금지 — 기본 1)
const codexCwdMarker = opt("codex-cwd-marker", "");
const codexBin = process.env.CODEX_BIN || "codex";

if (stories.length === 0) {
  console.error('✖ --stories 가 비어 있음. 예: --stories "11-1,11-2,11-3"');
  process.exit(2);
}

// permission-mode = acceptEdits (파일 편집만 자동 승인).
// ⚠️ 권한 우회(bypassPermissions)는 의도적으로 미지원 — 무인 bash가 프롬프트로 멈추면
//    사용자가 .claude/settings.json 에 필요한 명령(npm·node·claude 등) 허용 규칙을 직접 추가한다.
//    (블랭킷 권한 우회를 도구에 박지 않는다 = 프로젝트 유형 무관 전역 안전 정책.)
const permMode = "acceptEdits";
const claudeBin = process.env.CLAUDE_BIN || "claude"; // 테스트 스텁 오버라이드용

// pipeline-settings(nested 인스턴스 commit/push deny) 해석 — 전역 설치 대응:
// 프로젝트(.claude) 우선 → 전역(~/.claude) 폴백 → 둘 다 없으면 생략(경고, GUARD 프롬프트만으로 방어)
// (N2 2026-09-02) 해석 순서를 **명시 지정 → 프로젝트 → 전역** 으로 고정한다. 러너·워크트리 배선용으로
// `--pipeline-settings <경로>` 와 `PIPELINE_SETTINGS_PATH` 를 최우선에 둔다(둘 다 없으면 종전 2단 폴백 그대로).
// 명시 지정했는데 그 파일이 없으면 조용히 폴백하지 않는다 — 아래 fail-closed 검사가 그대로 STOP 시킨다.
const settingsOverride = opt("pipeline-settings", process.env.PIPELINE_SETTINGS_PATH || "");
const settingsPath = settingsOverride
  ? (existsSync(resolve(settingsOverride)) ? resolve(settingsOverride) : null)
  : ([resolve(".claude/pipeline-settings.json"), join(homedir(), ".claude", "pipeline-settings.json")]
      .find((p) => existsSync(p)) || null);

const artDir = resolve("_bmad-output/implementation-artifacts");
const logDir = resolve(artDir, "auto-pipeline-logs");
mkdirSync(logDir, { recursive: true });
const runLog = resolve(logDir, "run-summary.log");
const stateFile = resolve(logDir, "state.json");
const sprintStatusFile = resolve(artDir, "sprint-status.yaml");
const deferredWorkFile = resolve(artDir, "deferred-work.md");
const decisionsInboxFile = resolve(artDir, "DECISIONS-INBOX.md");
const exitInfoFile = resolve(logDir, "exit-info.json"); // 러너가 읽는 마지막 STOP 사유(프로바이더·종류) — 성공 종료 시 없음
const stamp = () => new Date().toISOString();
const today = () => stamp().slice(0, 10);
const note = (msg) => {
  console.log(msg);
  appendFileSync(runLog, `[${stamp()}] ${msg}\n`);
};
// 푸시 알림(화이트리스트 이벤트 전용: WAIT 진입·각종 STOP·qa RED·E2E RED·배치 완주).
// (M5 · 2026-09-02 3차 리뷰) 종전에는 `curl … https://ntfy.sh/${ntfyTopic}` **셸 문자열**이었다 —
// 토픽 값 한 줄이 명령 사슬이 될 수 있었고 curl 이 없는 머신에서는 알림이 조용히 증발했다.
// 이제 러너와 같은 `fetch` 경로를 쓴다(전송은 notify-push.mjs 자식 프로세스 · argv 분리 · 셸 없음).
// 제목은 헤더가 아니라 본문 첫 줄로 보낸다 — HTTP 헤더는 한글을 그대로 싣지 못한다(러너와 동일).
const NOTIFY_BIN = join(SKILL_DIR, "notify-push.mjs");
function push(title, body) {
  if (!ntfyTopic) return;
  try {
    const bodyFile = resolve(logDir, "ntfy-body.txt");
    writeFileSync(bodyFile, redactSecrets(`[auto-batch] ${title}\n${String(body ?? "")}`)); // 밖으로 나가는 본문은 마스킹(정책 2)
    spawnSafe(process.execPath, [NOTIFY_BIN, `https://ntfy.sh/${ntfyTopic}`, bodyFile], { timeout: 15000, encoding: "utf8" });
    note(`   🔔 push: ${title}`);
  } catch {
    /* 알림 실패·형식 거부는 무시 — fire-and-forget(배치에 영향 없음) */
  }
}

// ---- (U1) state.json: 완료 단계 기록/skip ----
function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    return parsed && typeof parsed.done === "object" && parsed.done !== null ? parsed : { done: {} };
  } catch {
    return { done: {} }; // 없거나 손상 → 빈 상태(전량 실행)로 안전 폴백
  }
}
const state = loadState();
const key = (story, stage) => `${story}::${stage}`;
const isDone = (story, stage) => Boolean(state.done[key(story, stage)]);
function markDone(story, stage) {
  state.done[key(story, stage)] = stamp();
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
function invalidate(story, ...downstream) {
  for (const st of downstream) delete state.done[key(story, st)];
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ---- (U2) 사후조건: 스토리 산출물 확인 ----
// 스토리 파일 = artDir/{story}.md (전체 키 권장). 짧은 키는 prefix 매칭(최단 파일명 = 스토리 본문).
function findStoryFile(story) {
  const exact = join(artDir, `${story}.md`);
  if (existsSync(exact)) return exact;
  try {
    const cands = readdirSync(artDir).filter((f) => f.startsWith(story) && f.endsWith(".md"));
    if (cands.length === 0) return null;
    cands.sort((a, b) => a.length - b.length);
    return join(artDir, cands[0]);
  } catch {
    return null;
  }
}
// ---- (U1-b) 허수 완주 방지 — 기록이 「완료」인데 산출물이 없으면 기록을 믿지 않는다 ----
// 2026-08-30 실사고(👤 승인 (a)): 11-3·4-1 이 08-28 저녁 **5분 만에** create·dev·qa·review 를
//   전부 「완료」로 기록했는데 스토리에는 완료 Task 0 · 미완 7/33 이었다(개발 0줄). 그 뒤 모든
//   라운드가 3단계를 전부 skip 하고 로그 1개만 커밋한 뒤 **「완주」로 보고**했다 — 하루 상한 한
//   칸을 먹고, 스토리 md 를 안 만져 진전 기록이 없어 규칙 9 스트릭까지 쌓였다. 두 스토리가
//   며칠간 무진전이던 실제 원인이 에픽 순서 규칙이 아니라 이 거짓 기록이었다.
// 판정: 완료 체크박스 0 **이면서** 미완 1+ 면 「개발이 하나도 안 됐다」로 본다.
//   · 둘 다 0(체크박스를 안 쓰는 스토리)은 대상이 아니다 — 오탐을 만들지 않는다
//   · 미완 0(전부 완료)도 대상이 아니다
//   · dev 에만 적용한다 — dev 가 실제로 돌면 invalidate 가 qa·review 기록을 함께 지운다
function hasNoCompletedWork(story) {
  const file = findStoryFile(story);
  if (!file) return false; // 파일이 없으면 이 판정의 대상이 아니다(create 가 먼저다)
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false; // 못 읽으면 판정하지 않는다 — 의심만으로 재실행하지 않는다
  }
  const doneN = (text.match(/^[ \t]*- \[x\] /gm) || []).length;
  const openN = (text.match(/^[ \t]*- \[ \] /gm) || []).length;
  return doneN === 0 && openN > 0;
}

// dev/review 는 스토리 파일 또는 부속 산출물({story}*-findings.md 등) 갱신을 인정.
// ⚠️ 시각 비교("단계 시작 이후")가 아닌 단계 전/후 mtime 스냅샷 비교 — 직전 단계(create)가
//    파일을 쓴 수 ms 뒤에 다음 단계가 빠르게 실패(401은 수 초 내 실패)하면 시각 비교는
//    허용오차 안에서 오판한다(v2 테스트 T3에서 실증된 결함).
function storyArtifactsMaxMtime(story) {
  try {
    let max = 0;
    for (const f of readdirSync(artDir)) {
      if (!f.startsWith(story) || !f.endsWith(".md")) continue;
      const m = statSync(join(artDir, f)).mtimeMs;
      if (m > max) max = m;
    }
    return max;
  } catch {
    return 0;
  }
}
function postconditionOk(stage, story, beforeMaxMtime) {
  if (stage === "create") return findStoryFile(story) !== null;
  // replan: md 가 전진했고 **실제로 계획이 바뀌었다**(결정 닫힘 · Task 증가 · 사람 질문 표식 · Replan 절) — 둘 다여야 한다.
  if (stage === "replan") {
    if (!(storyArtifactsMaxMtime(story) > beforeMaxMtime)) return false;
    const a = stageSnapshot ?? replanSignals(story), b = replanSignals(story);
    return b.openDecisions < a.openDecisions || b.openTasks > a.openTasks || (b.blocked && !a.blocked) || b.replanNotes > a.replanNotes;
  }
  // mockup: 판정 장부에 이 스토리 접두 항목이 늘었는가(파일만 있고 장부에 없으면 편성기가 못 본다)
  if (stage === "mockup") return mockupKeys(story).length > (stageSnapshot?.mockups ?? 0);
  // dev/review: 단계 실행 전 스냅샷보다 산출물 mtime이 실제로 전진했는지
  return storyArtifactsMaxMtime(story) > beforeMaxMtime;
}
let stageSnapshot = null; // 단계 실행 직전 스냅샷(replan/mockup 사후조건 재료) — runClaude 가 채운다
function replanSignals(story) {
  const file = findStoryFile(story);
  let text = "";
  try { text = file ? readFileSync(file, "utf8") : ""; } catch { text = ""; }
  const tasks = /## Tasks[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(text)?.[1] ?? "";
  return {
    openDecisions: countOpenFindings(text, "Decision"),
    openTasks: (tasks.match(/^[ \t]*- \[ \] /gm) ?? []).length,
    blocked: /^BLOCKED-ON-HUMAN:/m.test(text), // 줄머리(0열)만 — 편성기(story-ledger)와 같은 잣대
    replanNotes: (text.match(/^#{2,4} Replan /gm) ?? []).length,
  };
}
function mockupKeys(story) {
  try {
    const items = JSON.parse(readFileSync(resolve(mockupVerdicts), "utf8"))?.items ?? {};
    const prefix = `${mockupsDir}/story-${story.split("-").slice(0, 2).join("-")}-`;
    return Object.keys(items).filter((k) => k.startsWith(prefix));
  } catch { return []; }
}

// ---- (U3) 인증 오류 패턴 ----
const AUTH_RE = /(\b401\b|unauthorized|failed to authenticate|invalid.{0,3}api.{0,3}key|invalid authentication|authentication.{0,3}(error|failed)|token.{0,30}expired|oauth.{0,20}(error|expired))/i;
// ---- (U8) 사용량 한도 패턴 — 인증(재로그인 필요)과 구분: 한도는 리셋 대기만으로 복구 ----
// "monthly spend limit"(월 지출 한도 — 2026-08-28 실측: 이 문구가 기존 패턴에 안 걸려 STOP 으로
// 오분류돼 차단기에 카운트됐다) 포함. 월 한도는 대기로 안 풀린다 — 모델 전환이 답(큐 모델 장부).
// 2026-09-04 실측 추가 — **모델별 한도** 문구는 어순이 반대라 종전 패턴에 안 걸렸다:
//   "You've reached your Fable 5 limit. Switch to another model, or manage usage credits at …"
// → `other` 로 오분류돼 exit 1 STOP · 사다리(fable→opus)가 돌지 않았고 같은 서명 2회로 밤 창이 통째로 차단됐다.
// 이 문구의 처방은 대기가 아니라 **모델 전환**이고, 그게 limit 갈래의 사다리다(spend 와 달리 다른 모델은 산다).
const LIMIT_RE = /(usage.?limit|rate.?limit|\b429\b|quota exceeded|limit (reached|exceeded|will reset)|reached your [^.\n]{0,40}limit|switch to another model|too many requests)/i;
// ---- (U8-b) **월 지출 한도**는 사용량 한도와 다른 갈래다 (2026-08-30 반복 종결) ----
// 2026-08-28 에 이 문구를 LIMIT_RE 에 **넣기만** 하고 같은 갈래로 묶었다. 그때 주석에는
// 「월 한도는 대기로 안 풀린다」고 정확히 적어 놓고 **대기하는 갈래에 분류**했다 — 진단은
// 맞았는데 처방이 반대로 들어갔고, 그날은 fable 만 걸려 사다리가 opus 로 넘겨 피해가 0이라
// 아무도 밟지 않았다. 2026-08-30 전 모델이 걸리자 처음으로 드러났다(수 시간 정지 · 슬롯마다 반복).
//   실측(2026-08-30 17:2x · 👤 사용량 화면 + 3모델 직접 프로브): 주간 모든 모델 57% · 세션 5% 로
//   **사용량은 여유**인데 opus·sonnet·fable 전부 「You've hit your monthly spend limit」.
//   → 사용량 지갑과 지출(크레딧) 지갑은 **다른 지갑**이고, 지출 한도는 **기다려도 안 풀린다**.
// 규율: SPEND_RE 는 LIMIT_RE 보다 **먼저** 판정한다(둘 다 걸리는 문구가 있다).
const SPEND_RE = /(spend(ing)?.?limit)/i;
// 오류 종류별 메시지·exit code (auth=재로그인 / limit=리셋 대기 / spend=사람이 설정을 바꿔야 함)
const KIND = {
  auth: { tag: "AUTH", what: "CLI 인증 오류(401/토큰 만료)", fix: "다른 터미널에서 CLI를 대화형으로 열어 재로그인하세요", exit: 3 },
  limit: { tag: "LIMIT", what: "사용량 한도 초과(usage/rate limit)", fix: "한도가 리셋되면 자동 복구됩니다 — 재로그인 불필요(급하면 요금제·한도 확인)", exit: 5 },
  spend: {
    tag: "SPEND",
    what: "월 지출 한도 초과(구독 몫 소진 — 사용량 한도가 아니다)",
    // ⚠️ 여기서 「기다리면 된다」고 말하면 안 된다 — 그 오안내가 2026-08-30 에 수 시간을 버렸다.
    fix: "기다려도 풀리지 않습니다. 사람이 claude.ai/settings/usage 에서 「사용 크레딧」을 켜거나 지출 한도를 올려야 합니다(👤 정책: 기본은 구독 한도까지만 · 크레딧은 박사장 판단). 모델을 바꿔도 소용없습니다 — 계정 전체 지갑입니다",
    exit: 5,
  },
};
/** 실패 문구 분류 — auth > spend > limit 순. 순서가 규율이다(spend 가 limit 보다 먼저). */
function classifyFailure(out) {
  if (AUTH_RE.test(out)) return "auth";
  if (SPEND_RE.test(out)) return "spend";
  if (LIMIT_RE.test(out)) return "limit";
  return "other";
}

// ---- (P1) 프로바이더 능력 감지 — 게으르게, 요청됐을 때만 ----
const anyCodexSpec = () => Object.values(models).some((m) => parseModelSpec(m).provider === "codex");
const wantProviders = () => {
  const set = new Set(["claude"]);
  for (const p of providersOpt) set.add(p);
  if (anyCodexSpec()) set.add("codex");
  if (noCodex) set.delete("codex");
  return [...set];
};
let availabilityCache = null;
function providerAvailability() {
  if (availabilityCache) return availabilityCache;
  const want = wantProviders();
  availabilityCache = detectProviders({ want, env: process.env });
  if (noCodex) availabilityCache.codex = { wanted: true, available: false, version: "", reason: "--no-codex 지정(Claude 전용 강제)" };
  if (want.includes("codex") || noCodex) note(providersLine(availabilityCache));
  return availabilityCache;
}
let codexCwdCache = null;
function codexCwdInfo() {
  if (!codexCwdCache) codexCwdCache = inspectCwdForCodex(process.cwd(), { env: process.env, extraMarker: codexCwdMarker });
  return codexCwdCache;
}
/** 이 단계에서 한도 전환이 허용되는 프로바이더 목록 — codex 는 --codex-roles 의 역할일 때만 */
function allowedProvidersFor(stage) {
  const out = ["claude"];
  if (!noCodex && wantProviders().includes("codex") && codexRoles.includes(stage)) out.push("codex");
  return out;
}
const switchesUsed = {}; // story → 프로바이더 전환 횟수(**스토리당** 상한 1 — 두 벤더 왕복 금지 · 👤 2026-08-29 §5-3)
/** 프로바이더가 실제로 바뀐 전환만 센다 — 한도 사다리 · 가용성 폴백 · 빈 diff 전환 셋 다 같은 장부에 든다.
 *  dev 단계였다면 이어받기 금지(부분 산출물 폐기)까지 여기서 한다(👤 2026-08-29 §5-3). */
function countProviderSwitch(story, stage, nextSpec, why) {
  const from = parseModelSpec(models[stage]).provider;
  const to = (typeof nextSpec === "string" ? parseModelSpec(nextSpec) : nextSpec).provider;
  if (from === to) return false;
  switchesUsed[story] = (switchesUsed[story] ?? 0) + 1;
  note(`   (프로바이더 전환 ${switchesUsed[story]}회째 — ${from}→${to} · ${why} · 스토리당 상한 1)`);
  discardPartialWork(stage, story);
  return true;
}
const hash8 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
const rel = (p) => p.replace(/\\/g, "/").replace(process.cwd().replace(/\\/g, "/") + "/", "");
/** 러너 소비용 STOP 부기 — 어느 프로바이더가 어떤 사유로 멈췄는지(F36: exit 5 만으로는 레인을 모른다) */
function writeExitInfo(info) {
  try { writeFileSync(exitInfoFile, JSON.stringify({ ...info, at: stamp() }, null, 2)); } catch { /* 부기 실패는 배치에 영향 없음 */ }
}

// ---- (U6/U7) 인증 프로브 + 재로그인 대기 ----
const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));

/** 1콜로 인증·한도 상태 확인(--probe-model 지정 시 그 모델, 미지정 = CLI 기본 모델).
 *  "ok" | "auth"(401류) | "limit"(사용량 한도) | "other"(네트워크 등 — 배치를 막지 않음) */
function authProbe() {
  // 프로브 모델 = 명시값 > dev 모델 > CLI 기본. CLI 기본으로만 찌르면 "기본 모델만 한도이고
  // 배치 모델은 멀쩡한" 상황에서 영원히 미복구로 읽는다(2026-08-28 실사고: fable 만 월 한도,
  // dev=opus 는 정상인데 probe=limit 무한 대기).
  // v3: 프로브는 **claude 전용**이다 — dev 가 codex 스펙이면 claude 스펙을 가진 첫 단계 모델(없으면 CLI 기본)로
  //     찌른다("codex" 문자열이 `claude --model` 로 새면 안 된다). codex 인증은 능력 감지(login status)가 본다.
  const claudeModelOf = (m) => { const p = parseModelSpec(m); return p.provider === "claude" ? p.model : null; };
  const effectiveProbeModel = probeModel || claudeModelOf(models.dev) || claudeModelOf(models.review) || claudeModelOf(models.create) || "";
  // (F6/정책 8 · 2026-09-02 2차 리뷰) 종전에는 여기만 `${claudeBin} …` 문자열 + shell:true 였다 —
  // 공백이 든 `C:\Program Files\…\claude.cmd` 는 프로브가 아예 실행되지 않았고, CLAUDE_BIN 주입 경로도 남았다.
  // 실행파일과 argv 를 분리한다(.cmd 심은 spawn-safe 의 전용 cmd.exe 경로 · 메타문자는 실행 전에 거부).
  let res;
  try {
    const file = assertSafePath(claudeBin, "CLAUDE_BIN");
    const argvProbe = ["-p", ...(effectiveProbeModel ? ["--model", assertSafeModel(effectiveProbeModel, "probe 모델")] : [])];
    res = spawnSafe(file, argvProbe, { input: "ok", encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120000 });
  } catch (e) {
    note(`⚠ 인증 프로브를 실행하지 못했다(${e?.code ?? e?.message}) — 배치는 계속 진행(실패 시 단계에서 판정).`);
    return "other";
  }
  if (res.status === 0) return "ok";
  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  return classifyFailure(out); // (U8/U8-b) auth | spend | limit | other
}

/** (U7/U8) 복구 폴링 대기(kind: "auth"|"limit"). 복구되면 true, 시한 초과면 false. */
function waitForRecovery(kind, context) {
  if (waitAuthMin <= 0) return false;
  const k = KIND[kind];
  const deadline = Date.now() + waitAuthMin * 60 * 1000;
  note(`⏸ ${k.tag} WAIT — ${context}: ${k.what}. 최대 ${waitAuthMin}분 동안 ${authPollSec}초 간격으로 복구를 기다립니다.`);
  note(`   조치: ${k.fix} — 복구가 확인되면 멈춘 지점부터 자동 재개합니다.`);
  push(`${k.tag} WAIT`, `${context} — ${k.what}. 최대 ${waitAuthMin}분 대기. ${k.fix}`);
  while (Date.now() < deadline) {
    sleepSync(Math.min(authPollSec * 1000, deadline - Date.now()));
    const p = authProbe();
    if (p === "ok") {
      note(`▶ ${k.tag} RECOVERED — 복구 확인. 배치를 재개합니다.`);
      return true;
    }
    note(`   … 아직 미복구 상태(probe=${p}) (다음 확인까지 ${authPollSec}초)`);
  }
  return false;
}

/** 인증·한도 실패 공통 처리: 대기 모드면 복구 시 true(재시도), 아니면 안내 후 exit(3|5). */
function handleFailure(kind, context, logFile, pollable = true) {
  // (U8-b) 지출 한도는 **기다리지 않는다** — 사람이 설정을 바꿔야 풀리므로 폴링은 순수 낭비다.
  // 2026-08-30 실사고: 슬롯마다 30분씩 헛기다리고 STOP 하기를 반복했다.
  // v3(F3): 복구 프로브는 claude 전용이다 — codex 실패를 claude 프로브로 「복구됨」이라 오판하면 5회 헛돈다.
  //   codex 실패는 pollable=false 로 들어와 대기 없이 STOP 한다(러너가 다음 슬롯에 재시도 · 한도 = 레인 전환 신호).
  if (pollable && kind !== "spend" && waitForRecovery(kind, context)) return true;
  const k = KIND[kind];
  if (!pollable) note(`   (codex 는 프로브 대기 없이 STOP — Claude 프로브로 codex 복구를 판정할 수 없다 · 러너가 다음 슬롯에 재시도)`);
  note(`✖ ${k.tag} STOP — ${context}: ${k.what}로 배치를 중단합니다.`);
  note(`   조치: ① ${k.fix} → ② 같은 명령을 그대로 재실행하면 완료 단계는 자동 skip(이어하기).${logFile ? ` log=${logFile}` : ""}`);
  note(`   (다음부터 밤샘 무인 배치는 --wait-auth-min 480 처럼 대기 모드를 켜면 복구만으로 자동 재개됩니다.)`);
  push(`${k.tag} STOP`, `${context} — ${k.what}. ${k.fix} 후 같은 명령 재실행(이어하기).`);
  process.exit(k.exit);
}

// ---- (U9) 스토리 단위 커밋·푸시 (옵트인 · 하드 가드) ----
function git(args, opts = {}) {
  const res = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: res.status ?? 1, out: `${res.stdout || ""}`, err: `${res.stderr || ""}` };
}
const headSha = () => { const r = git(["rev-parse", "HEAD"]); return r.code === 0 ? r.out.trim() : ""; };
const currentBranch = () => git(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
const stashCount = () => git(["stash", "list"]).out.split("\n").filter((l) => l.trim()).length;
/** 워킹트리 지문 — 수리 워커의 사후조건(코드만 고쳐도 「일했다」 · F31) */
const treeFingerprint = () => createHash("sha1").update(git(["diff", "HEAD", "--"]).out + "\n" + git(["ls-files", "--others", "--exclude-standard"]).out).digest("hex");
/** (정책 2) 로그·프롬프트에 실리는 모든 명령 출력의 자격증명 **값**을 가린다 — QA·Claude·Codex·repair 공용.
 *  이름(키)은 남긴다(무엇이 새려 했는지는 사람이 알아야 한다). 종전엔 codex 로그에만 걸려 있었다. */
const scrubLog = (t) => redactSecrets(t);
/** (#3 2차 방어 · N2 강화) 원격 ref 스냅샷 — **모든 remote** 의 heads 를 본다.
 *  origin 만 보면 워커가 `git remote add sneak … && git push sneak` 로 빠져나간다. 원격이 없으면 빈 문자열
 *  (비교는 항상 같음 = skip). 조회 실패도 비교 대상 아님(네트워크 없는 밤도 있다) — 다만 실패/성공이
 *  전후로 뒤바뀌면 그 자체가 변화로 잡히지 않게 실패는 그 remote 를 건너뛴다. */
function remoteHeads() {
  const names = git(["remote"]).out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!names.length) return "";
  const parts = [];
  for (const n of names) {
    const r = git(["ls-remote", "--heads", n], { timeout: 20000 });
    if (r.code === 0) parts.push(`${n}\n${r.out.trim()}`);
  }
  return parts.join("\n");
}
/** (N2) 로컬 git 이동의 흔적 — HEAD reflog 엔트리 수 + 모든 로컬 ref.
 *  절대경로 git 우회로 `commit → reset` 을 해도 **reflog 는 자란다**(HEAD 값은 원상복구돼도 기록은 남는다).
 *  shim 을 지나친 조작을 사후에 반드시 알아채기 위한 두 번째 눈이다. 저장소가 아니면 빈 문자열. */
function localGitFingerprint() {
  const reflog = git(["reflog", "show", "--format=%H", "HEAD"]);
  const refs = git(["show-ref"]);
  const n = reflog.code === 0 ? reflog.out.split("\n").filter((l) => l.trim()).length : -1;
  return `reflog=${n}\n${refs.code === 0 ? refs.out.trim() : ""}`;
}
/** git-guard 의 shim PATH 에 Windows 셸 고정을 더한 워커 env.
 *  Git for Windows 의 `Git\bin\bash.exe` 래퍼는 시작할 때 `/mingw64/bin:/usr/bin` 을 PATH 앞에 끼워 넣어 shim 을
 *  지나친다(2026-09-02 실측). PATH 순서를 지키는 `Git\usr\bin\bash.exe` 로 워커 셸을 못 박는다. */
function workerEnvWithGuard(guard) {
  // (H3 · 2026-09-02 3차 리뷰) 절대경로 git 은 shim 을 지나친다 — 그래서 **원격에 인증할 수단 자체**를 없앤다.
  //   GIT_CONFIG_* 로 credential.helper/core.askpass/http.proxy 무효화 · GIT_ASKPASS·SSH_AUTH_SOCK·
  //   GIT_SSH_COMMAND·GH_TOKEN·`*_TOKEN`/`*_SECRET`·프록시 제거 · SSH 는 BatchMode+IdentitiesOnly+없는 키.
  //   GIT_ALLOW_PROTOCOL=none · GIT_TERMINAL_PROMPT=0 은 그대로 유지된다(stripRemoteCredentials 가 다시 심는다).
  const stripped = stripRemoteCredentials(guard.env);
  const env = { ...stripped.env };
  if (stripped.removed.length) note(`   🔒 워커 env 에서 원격 인증 수단 ${stripped.removed.length}건 제거(${stripped.removed.slice(0, 6).join(", ")}${stripped.removed.length > 6 ? " …" : ""})`);
  if (process.platform === "win32" && guard.realGit) {
    let d = dirname(guard.realGit);
    for (let i = 0; i < 3 && d && d !== dirname(d); i++) {
      const bash = join(d, "usr", "bin", "bash.exe");
      if (existsSync(bash)) { env.SHELL = bash; env.CLAUDE_CODE_GIT_BASH_PATH = bash; break; }
      d = dirname(d);
    }
  }
  return env;
}
let treeWasClean = false; // ensureBranch 의 dirty 검사를 통과했을 때만 true — 벤더 전환 시 부분 산출물 폐기의 전제
/** 벤더 전환 시 부분 산출물 폐기(👤 2026-08-29 §5-3 「이어받기 금지」) — 시작 트리가 clean 이었을 때만 되돌린다.
 *  수동 실행(커밋 없음)은 사람의 변경이 섞여 있을 수 있어 건드리지 않는다(사유를 남긴다). */
function discardPartialWork(stage, story) {
  if (stage !== "dev") return;
  if (!treeWasClean) { note(`   (부분 산출물 폐기 생략 — 시작 트리 clean 검증 없음(수동 실행) · 다음 워커가 현재 트리 위에서 시작)`); return; }
  git(["checkout", "--", "."]);
  git(["clean", "-fdq", "-e", "_bmad-output/implementation-artifacts/auto-pipeline-logs"]);
  note(`   ↺ [${story}] 벤더 전환 — 이전 워커의 부분 산출물 폐기(HEAD 로 되돌림 · 이어받기 금지)`);
}
// 커밋 금지 경로(스테이징 후 검출 → 전체 unstage + STOP). auto-pipeline-logs/ 의 .log 는 정식 산출물이라 허용.
const DENY_PATH_RE = /(^|\/)(\.env(\..*)?$|.*\.local\.[^/]+$|scratch-[^/]*$|.*\.(pem|key|p12|pfx)$|.*secrets?\.(json|ya?ml)$)/i;
const DENY_LOG_RE = /\.log$/i;
// 스테이징 diff 추가 줄의 시크릿 패턴(값이 실제로 붙은 형태만 — 이름·정규식 정의는 통과)
const SECRET_RES = [
  /sb_secret_[A-Za-z0-9_-]{8,}/,
  // sb_publishable_ 는 공개 키(VITE_ 공개값)라 시크릿이 아니다 — 2026-08-17 밤샘 배치에서 스토리 문서의 뮤테이션 예시값에 오탐 STOP(1.5h 손실) → 제외
  /(CLOUDFLARE_API_TOKEN|CF_API_TOKEN|OPENAI_API_KEY|SUPABASE_ACCESS_TOKEN|SUPABASE_SERVICE_ROLE_KEY|OUTBOX_DISPATCH_SECRET|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?[A-Za-z0-9_\-\/+.]{16,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /sk-[A-Za-z0-9]{24,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
// 엔진 자신의 로그(auto-pipeline-logs/)는 이전 배치의 마지막 줄이 미커밋으로 남는 것이 정상 — dirty 판정에서 제외
function trackedDirty() {
  return git(["status", "--porcelain", "--untracked-files=no"]).out
    .split("\n").filter((l) => l.trim() && !l.includes("auto-pipeline-logs/")).join("\n").trim();
}
/** (#4) 무인 커밋이 허용되는 자리인가 — detached HEAD(러너 워크트리 landing) 또는 `auto/*` 브랜치.
 *  main·일반 브랜치에 무인 배치가 직접 커밋하는 경로는 없다(정본은 사람 머지). */
const COMMIT_PLACE_MSG = "무인 커밋은 auto/* 또는 detached worktree 에서만";
function commitPlaceOk(cur) {
  return cur === "HEAD" || /^auto\//.test(cur) || (branchName && cur === branchName);
}
function ensureBranch() {
  if (dryRun) return;
  const dirty = trackedDirty();
  if (!doCommit) {
    // 수동(커밋 없음) 실행도 시작 트리가 clean 이면 벤더 전환 시 부분 산출물을 폐기한다(검증표 #2 보완).
    // 사람의 미커밋 변경이 섞여 있으면 종전대로 건드리지 않는다.
    treeWasClean = !dirty;
    return;
  }
  if (dirty) {
    note("✖ COMMIT GUARD STOP — --commit 은 시작 시점 작업 트리가 clean 이어야 한다(추적 파일 변경 존재 → 이전 작업이 스토리 커밋에 섞인다). 먼저 사람이 커밋/정리.");
    push("COMMIT GUARD STOP", "시작 시 작업 트리 dirty — 사람 정리 후 재실행");
    process.exit(6);
  }
  treeWasClean = true;
  const cur = git(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  if (!branchName) {
    // `--commit` 만 주면 종전에는 **현재 브랜치**(main 포함)에 그대로 커밋했다(codex-review-r1 #4).
    if (!commitPlaceOk(cur)) {
      note(`✖ COMMIT GUARD STOP — ${COMMIT_PLACE_MSG}. 현재 위치=${cur} · --branch auto/<이름> 을 주거나 러너의 detached 워크트리에서 실행하세요.`);
      push("COMMIT GUARD STOP", `${COMMIT_PLACE_MSG} — 현재 ${cur}`);
      process.exit(6);
    }
    note(`ℹ --commit: ${cur === "HEAD" ? "detached HEAD(워크트리 landing 모드)" : `현재 브랜치(${cur})`}에 스토리 단위 커밋(푸시 없음).`);
    return;
  }
  if (cur === branchName) { note(`ℹ 브랜치 ${branchName} (현재)`); return; }
  // 엔진 자기 로그(auto-pipeline-logs/) 의 미커밋 churn 이 브랜치 이동(switch/-C)을 통째로 막는다 —
  // 실사고: 이 실패로 워크트리가 낡은 커밋에 갇혀 옛 코드로 편성이 돌았다. 로그는 버려도 되는 churn.
  git(["checkout", "--", "_bmad-output/implementation-artifacts/auto-pipeline-logs"]);
  const exists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`]).code === 0;
  // 기존 브랜치 팁이 이미 HEAD 의 조상(=전부 머지됨)이면 낡은 팁을 버리고 HEAD 에서 다시 딴다 —
  // 실사고: 저녁에 main 으로 머지된 auto/<날짜> 의 낡은 로컬 팁을 그대로 switch 해, 밤 배치가
  // 그 뒤의 사람 확정 커밋이 없는 어제 트리 위에서 돌았다. 미머지 커밋이 있으면 종전대로 보존 전환.
  const mergedIn = exists && git(["merge-base", "--is-ancestor", branchName, "HEAD"]).code === 0;
  const r = exists && !mergedIn ? git(["switch", branchName]) : git(["switch", "-C", branchName]);
  if (r.code !== 0) { note(`✖ COMMIT GUARD STOP — 브랜치 전환 실패: ${r.err.trim()}`); process.exit(6); }
  note(`ℹ 브랜치 ${exists ? (mergedIn ? "재기점(HEAD)" : "전환") : "생성"}: ${branchName} (base=${cur})`);
}
/** (2026-09-03 👤 「무료 운영 안전장치 ②」) 엔진의 **유일한** push 경로 — ref 를 push 직전에 다시 검사한다.
 *  main·보호 이름·refspec(`HEAD:main`)·현재 브랜치 불일치 = 즉시 exit 6(밀지 않는다). 인자 파싱 시점의
 *  `--branch auto/…` 검사는 그 뒤의 브랜치 전환·설정 오류를 못 잡는다 — GitHub Free 는 서버가 main 을 보호하지
 *  못하므로(2026-09-03 실측 · 룰셋 API 403) 여기가 마지막 문이다. 반환값 = push 성공 여부. */
function enginePush(label) {
  const r = safeGitPush({ ref: branchName });
  if (r.verdict) {
    note(`✖ PUSH GUARD STOP — ${label}${r.verdict}. 정본 main 은 사람 승인 머지로만 바뀐다.`);
    push("PUSH GUARD STOP", `${label}${r.verdict}`);
    process.exit(6);
  }
  if (!r.ok) {
    note(`⚠ ${label}git push 실패(계속): ${r.out.trim().split("\n").slice(-1)[0]}`);
    push("PUSH FAILED", `${label}push 실패 — 아침에 사람 재시도`);
    return false;
  }
  return true;
}
function commitStory(story, stagesDone) {
  if (!doCommit) return null;
  if (dryRun) { note(`   (dry-run) commit [${story}] paths=${commitPaths.length} push=${doPush}`); return null; }
  // (#4) 커밋 시점에도 자리를 다시 본다 — 시작 후 위치가 바뀌었으면(워커 조작·외부 개입) 커밋하지 않는다.
  const place = git(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  if (!commitPlaceOk(place)) {
    note(`✖ COMMIT GUARD STOP — [${story}] ${COMMIT_PLACE_MSG}. 커밋 시점 위치=${place} — 커밋·푸시 취소.`);
    push("COMMIT GUARD STOP", `[${story}] ${COMMIT_PLACE_MSG} — 현재 ${place}`);
    process.exit(6);
  }
  git(["reset", "-q"]);
  // 존재하지 않는 pathspec 이 하나라도 있으면 git add 전체가 중단되므로 실존 경로만 넘긴다
  const paths = commitPaths.filter((p) => existsSync(p));
  if (paths.length === 0) { note(`ℹ [${story}] 커밋 화이트리스트 경로가 하나도 없음 — 커밋 생략.`); return null; }
  const add = git(["add", "-A", "--", ...paths]);
  if (add.code !== 0) note(`⚠ [${story}] git add 경고: ${add.err.trim().split("\n")[0]}`);
  const staged = git(["diff", "--cached", "--name-only"]).out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (staged.length === 0) { note(`ℹ [${story}] 커밋할 변경 없음(스테이징 0).`); return null; }
  const denied = staged.filter((f) => DENY_PATH_RE.test(f) || (DENY_LOG_RE.test(f) && !f.includes("auto-pipeline-logs/")));
  if (denied.length) {
    git(["reset", "-q"]);
    note(`✖ COMMIT GUARD STOP — [${story}] 금지 경로가 스테이징됨: ${denied.join(", ")} (커밋·푸시 취소, 사람 확인 필요)`);
    push("COMMIT GUARD STOP", `[${story}] 금지 경로 ${denied.length}건 — 사람 확인 필요`);
    process.exit(6);
  }
  const diff = git(["diff", "--cached", "--unified=0"]).out;
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const hits = [];
  for (const line of added) for (const re of SECRET_RES) if (re.test(line)) { hits.push(line.slice(0, 80)); break; }
  if (hits.length) {
    git(["reset", "-q"]);
    note(`✖ SECRET STOP — [${story}] 스테이징 diff 에 시크릿 패턴 ${hits.length}건(첫 줄: ${hits[0].replace(/[A-Za-z0-9_\-]{12,}/g, "***")}). 커밋·푸시 취소. 사람이 값 제거·키 폐기 여부 판단.`);
    push("SECRET STOP", `[${story}] 스테이징에 시크릿 패턴 — 커밋 취소, 사람 확인 필요`);
    process.exit(6);
  }
  const msg = `auto(${story}): ${stagesDone.join("+")} 완료 — qa GREEN · 리뷰 findings 는 스토리 파일 참조\n\n[auto-story-pipeline] 무인 배치 커밋(스토리 단위). 정본 반영은 사람 머지.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`;
  const c = git(["commit", "-q", "-m", msg]);
  if (c.code !== 0) { note(`⚠ [${story}] git commit 실패: ${c.err.trim().split("\n")[0]} — 계속 진행(사람 확인)`); return null; }
  const sha = git(["rev-parse", "--short", "HEAD"]).out.trim();
  note(`   ✔ commit ${sha} (${staged.length} files)`);
  if (doPush && deferPush) {
    // (N1) 통합 게이트가 남아 있다 — 지금 밀면 RED 조합이 원격에 남는다. 커밋은 로컬 auto/* 에만 둔다.
    pendingPush = true;
    note(`   ⏸ push 보류 — 배치 ${e2eCmd ? "e2e" : "통합 게이트"} 통과 후 1회만 민다(로컬 ${branchName} 에는 커밋됨).`);
  } else if (doPush) {
    if (enginePush(`[${story}] `)) note(`   ✔ push origin/${branchName}`);
  }
  return sha;
}
/** (N1) 배치 통합 게이트 GREEN 뒤의 **단 한 번**의 push. RED 면 절대 불리지 않는다(호출부가 그 전에 exit 1). */
function pushDeferred() {
  if (!deferPush || !pendingPush || dryRun) return;
  if (enginePush("보류했던 ")) note(`   ✔ push origin/${branchName} (배치 게이트 GREEN 뒤 1회 · 스토리별 push 없음)`);
  pendingPush = false;
}

// ---- 단계별 프롬프트 (비대화형 + 가드레일 명시) ----
// GUARD는 프로젝트 중립 — 프로젝트 특화 제약(법정 보수성·보호 파일 등)은 실행 cwd의
// 프로젝트 CLAUDE.md가 nested 인스턴스에 자동 로드되어 주입된다(계층화 원칙, 2026-08-08).
const GUARD = "[비대화형] 승인/질문 없이 합리적 기본값으로 끝까지 진행하라. ⚠️ git commit·push 절대 금지. 프로젝트 CLAUDE.md에 명시된 절대 제약(보호 파일·보수성 규칙)을 최우선 준수하라. 임시 파일(diff 덤프·qa 로그 등)은 저장소 루트가 아니라 _bmad-output/implementation-artifacts/auto-pipeline-logs/ 아래에만 써라 — 루트 스크래치는 다음 배치를 dirty STOP 시킨다(실사고 반복).";
// 자율운전 문단 — dev/review 에 덧붙는다(guarded 에서는 빈 문자열 = 종전 프롬프트 바이트 동일).
// 결정은 「대기」가 아니라 「추천안 채택 + 근거 기록」이고, 사람은 인박스 「🔵 사후 확인」에서 되돌릴 수 있다.
const AUTO_DEV = FULL ? " [자율운전] 열린 [Review][Decision] 이 있으면 결정 대기로 멈추지 말고 ⭐/추천 표시가 있는 안을(없으면 되돌리기 가장 싼 안을) 채택해 구현하고, 그 줄을 `- [x] ~~원문~~ — ✅ AI 결정(YYYY-MM-DD · 선택 · 사후 확인)` 로 닫은 뒤 _bmad-output/implementation-artifacts/DECISIONS-INBOX.md 의 H1 바로 아래에 `## 🔵 사후 확인 — AI 결정 <스토리 짧은키> (<날짜>)` 절로 무엇/선택/근거/대안/되돌리는 방법을 적어라(사람이 사후 확인한다). 사람 게이트(「사람 게이트」·「박사장」·👤 표기) Task 는 그대로 두고 나머지를 전부 끝내라." : "";
const AUTO_REVIEW = FULL ? " [자율운전] Decision 을 남길 때는 각 Decision 에 ⭐추천안과 되돌리는 비용을 함께 적어라 — 다음 라운드(replan/dev)가 추천안을 채택하고 사람은 사후 확인한다." : "";
const prompts = {
  create: (s) => `/bmad-create-story ${s}\n\n${GUARD} 스토리 스펙(AC·파일 그라운딩)을 작성·저장하고 종료.`,
  dev: (s) => `/bmad-dev-story ${s}\n\n${GUARD} 구현 후 검증까지 자동 실행.${AUTO_DEV}`,
  review: (s) => `/bmad-code-review ${s}\n\n${GUARD} 다른 LLM 관점에서 적대적으로. findings 리포트만 작성(코드 자동수정·commit 금지). ⚠️ 판정은 발견 0건·재오픈 불요 결론이어도 **반드시 스토리 파일의 Review Findings 절에 라운드 기록으로 기재**하라 — stdout 채팅 보고만 하고 파일을 안 쓰면 엔진이 산출물 부재(NO-OP exit 4)로 실패 처리한다(실사고 3회).${AUTO_REVIEW}`,
  // replan — 시니어 개발 기획자 재계획(자율운전 · 2026-09-03). 스토리 md·인박스·sprint-status 만 쓴다(코드 0줄).
  replan: (s) => [
    `[REPLAN] 스토리 ${s} 재계획 — 너는 시니어 개발 기획자다. 결정이 필요한 항목은 스스로 판단해 기록하고(사람은 인박스에서 사후 확인한다) 스토리 파일(_bmad-output/implementation-artifacts/${s}*.md)을 갱신하라. 코드는 고치지 않는다.`,
    "",
    GUARD,
    "",
    "절차:",
    "1) 스토리 파일 · epics.md 의 해당 절 · 열린 [Review][Patch]/[Review][Decision] · Dev Agent Record · Status 를 읽는다.",
    "2) 열린 `- [ ] [Review][Decision]` 마다: ⭐/추천 표시가 있는 안을, 없으면 되돌리기 가장 싼 안을 고른다. 그 줄을 `- [x] ~~<원문>~~ — ✅ AI 결정(<YYYY-MM-DD> · <선택> · 사후 확인)` 로 바꾸고, _bmad-output/implementation-artifacts/DECISIONS-INBOX.md 의 H1 바로 아래에 `## 🔵 사후 확인 — AI 결정 <스토리 짧은키 예 2.16> (<날짜>)` 절을 추가해 결정마다 「무엇 / 선택 / 근거 / 대안 / 되돌리는 방법」을 적는다.",
    "3) 열린 `- [ ] [Review][Patch]` 가 있는데 Tasks/Subtasks 절에 미완 기계 Task 가 없으면, Tasks 절 끝에 `### 회수 라운드 <날짜>` 소제목과 각 Patch 를 고치는 구체적 `- [ ] ` Task 를 적는다(「사람 게이트」·「박사장」·👤 표기는 쓰지 않는다 — 그 표기는 사람만 풀 수 있다는 뜻이다).",
    "4) 「재투입 금지」·「마지막 구현 라운드」 표기나 아래 힌트가 있으면 같은 방법을 반복하지 말고 접근을 바꾼다(스토리를 더 작은 Task 로 쪼개기 · 단순화 · 다른 구현 경로) — `### Replan <날짜>` 절에 무엇을 왜 바꿨는지 적는다.",
    "5) 사람만 풀 수 있는 것(자격증명·시크릿 · 운영 DB 적용 · 외부 승인 · epics/PRD 가 답하지 않는 제품 범위)이 남은 일의 **전부**일 때만, 제목 바로 아래에 한 줄 `BLOCKED-ON-HUMAN: <정확한 질문 하나> — 풀리는 조건: <무엇이 풀리면 되는지>` 를 적고 Task 를 지어내지 않는다.",
    "6) Task 를 추가했으면 `Status: in-progress`, 남은 일이 리뷰뿐이면 `Status: review` 로 두고 sprint-status.yaml 의 같은 키도 맞춘다.",
    "7) 바꾼 것이 없으면 안 된다 — 위 2~5 중 하나는 반드시 파일에 남아야 한다(그렇지 않으면 엔진이 무변경으로 실패 처리한다).",
    replanHint ? `\n힌트(러너): ${replanHint}` : "",
  ].join("\n"),
  // mockup — AI 목업 초안(자율운전). 사람은 사후에 approved/rejected 만 정한다.
  mockup: (s) => [
    `[MOCKUP] 스토리 ${s} 새 화면 목업 초안 — /baro-design 스킬을 사용해 이 스토리의 AC 가 요구하는 새 화면마다 목업 HTML 을 만든다.`,
    "",
    GUARD,
    "",
    `- 파일: ${mockupsDir}/story-<에픽>-<번호>-<화면-slug>.html (확정 디자인 시스템 DESIGN.md·EXPERIENCE.md 준수 · 스토리 파일의 AC·Dev Notes 근거).`,
    `- 만든 파일마다 ${mockupVerdicts} 의 items 에 항목을 추가한다: { "verdict": "pending", "story": "<에픽>.<번호>", "note": "AI 초안(<날짜> · 사후 확인 — 사람이 approved/rejected 로 바꾼다)" } — 기존 항목은 보존하고 유효한 JSON 을 유지한다(이 장부에 없는 목업은 편성기가 보지 못한다).`,
    "- 스토리 파일 Dev Notes 에 목업 파일 경로를 한 줄 적는다.",
  ].join("\n"),
};

// ---- (P2) Codex 리뷰 재료 — 이번 라운드 diff 를 파일로 만든다(대상: 워킹트리 vs HEAD · 비면 baseline..HEAD) ----
// 미추적 파일을 unified diff 로 만든다(텍스트만 · 1MB 상한 · 바이너리 제외 · Windows `NUL` 함정 없음).
// 리뷰 diff 와 무결성 diff(#8) 가 같은 재료를 쓴다 — 새로 만든 테스트 파일의 `.only` 를 둘 다 본다.
const UNTRACKED_MAX_BYTES = 1024 * 1024;
function untrackedUnifiedDiff(p) {
  let buf;
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > UNTRACKED_MAX_BYTES) return "";
    buf = readFileSync(p);
  } catch { return ""; }
  if (buf.includes(0)) return ""; // 바이너리
  const lines = buf.toString("utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return "";
  return [
    `diff --git a/${p} b/${p}`, "new file mode 100644", "--- /dev/null", `+++ b/${p}`,
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), "",
  ].join("\n");
}
const splitLines = (s) => String(s).split("\n").map((l) => l.trim()).filter(Boolean);
/** 민감 경로를 **pathspec 단계에서** 제외한 tracked diff — 이름 목록은 호출부가 준다(#1). */
function trackedDiffExcludingSensitive(names, ref) {
  const excl = names.filter(isSensitivePath).map((f) => `:(exclude,top)${f}`);
  const base = ref ? [ref] : ["HEAD"];
  return excl.length
    ? git(["diff", ...base, "--", ":(top)", ...excl]).out
    : git(["diff", ...base, "--"]).out;
}

function prepareReviewDiff(story) {
  const storyFile = findStoryFile(story);
  const diffFile = resolve(logDir, `codex-${hash8(story)}-review-diff.txt`);
  // 리뷰 diff 에 자격증명이 실리면 그대로 외부 벤더로 나간다 — gitignore·추적 여부와 무관하게 env·키·시크릿
  // 파일은 ① pathspec 제외 ② unified diff 에서 파일 섹션째 제거 ③ 최종 확정 후 값 마스킹, 셋을 모두 건다
  // (2026-09-02 codex-review-r1 #1: 종전에는 `git diff HEAD` 본문에 추적된 `.env.production` 이 그대로 실렸다).
  let names = splitLines(git(["diff", "--name-only", "HEAD", "--"]).out);
  let diff = trackedDiffExcludingSensitive(names);
  let files = names.filter((f) => !isSensitivePath(f));
  const untracked = splitLines(git(["ls-files", "--others", "--exclude-standard"]).out)
    .filter((f) => !f.includes("auto-pipeline-logs/") && !isSensitivePath(f));
  for (const f of untracked) {
    const d = untrackedUnifiedDiff(f);
    if (d) { diff += `\n${d}`; files.push(f); }
  }
  let targetRef = `워킹트리 vs HEAD(${headSha().slice(0, 7)})`;
  if (!diff.trim() && storyFile) {
    // 이미 커밋된 라운드(재검수 등) — 스토리 frontmatter 의 baseline_commit 부터 HEAD 까지. 폴백 경로도 같은 규율이다
    // (종전에는 여기서 마스킹 **이후**에 원문 diff 로 덮어써 `sk-…`·URL 자격증명이 그대로 나갔다).
    const base = /^baseline_commit:\s*([0-9a-f]{7,40})/m.exec(readFileSync(storyFile, "utf8"))?.[1];
    if (base && git(["cat-file", "-e", `${base}^{commit}`]).code === 0) {
      names = splitLines(git(["diff", "--name-only", `${base}..HEAD`, "--"]).out);
      diff = trackedDiffExcludingSensitive(names, `${base}..HEAD`);
      files = names.filter((f) => !isSensitivePath(f));
      targetRef = `${base.slice(0, 7)}..HEAD`;
    }
  }
  files = files.filter((f) => !f.includes("auto-pipeline-logs/"));
  diff = redactSecrets(stripSensitiveFileSections(diff));
  const MAX = 400_000;
  if (diff.length > MAX) diff = diff.slice(0, MAX) + `\n\n[… diff ${diff.length} bytes 중 ${MAX} 까지만 실음 — 나머지 파일은 직접 열어 확인하라: ${files.join(", ")}]\n`;
  diff = redactSecrets(diff); // 최종 확정본에 한 번 더(자름·표식 삽입 뒤 남은 값 0 을 보장)
  const empty = !diff.trim();
  writeFileSync(diffFile, diff || "(변경 없음)\n");
  return { diffFile, files, targetRef, empty };
}
const reviewRoundOf = (md) => (String(md).match(/^### Review Findings/gm) || []).length;

/** (#13) 인박스가 없을 때 만드는 안전한 기본 형식 — 사람이 읽는 단일 창구의 최소 골격.
 *  절 제목은 현행 관례(「결정 대기」·「사후 확인」)를 따른다 — 편성기·브리핑이 이 문자열을 본다. */
const INBOX_TEMPLATE = () => [
  "# 결정 인박스 (DECISIONS-INBOX)",
  "",
  `> 무인 배치가 ${today()} 에 자동 생성했다(파일이 없었다). 결정 대기의 **단일 창구**다 — 스토리 파일 안에만 있는 결정은 며칠씩 정체한다.`,
  "",
  ...(FULL ? ["## 🔵 사후 확인 (AI 결정 — 자율운전)", "", "(replan/dev 가 채택한 결정을 근거와 함께 등재한다 · 사람이 사후 확인하고 되돌릴 수 있다)", ""] : []),
  "## 🟠 결정 대기",
  "",
  "(아래에 배치가 등재한다)",
  "",
  "## 🔵 사후 확인 (무인 기본값으로 진행함)",
  "",
  "",
].join("\n");

/** Codex 리뷰 JSON → 스토리 파일·sprint-status·deferred-work 기재(bmad-code-review step-04 와 같은 자리·전이). */
const reviewResults = {}; // story → 매니페스트용 요약
function applyCodexReview(story, res, w) {
  const json = parseReviewJson(res.lastMessage) ?? parseReviewJson(res.events?.lastMessage ?? "");
  // (#12) 「파일을 하나도 안 읽고 clean」을 가려내려면 열람 증거 재료를 반드시 넘겨야 한다 — 안 넘기면
  // validateReviewRun 이 명령 개수만으로 통과시키고 경고만 남긴다(호출부 배선 누락).
  const ri = w.reviewInputs ?? {};
  const v = validateReviewRun({ json, events: res.events, diffEmpty: false, storyFile: ri.storyFile ?? "", diffFile: ri.diffFile ?? "", changedFiles: ri.changedFiles ?? [] });
  if (!v.ok) return { ok: false, why: v.why };
  for (const msg of v.warnings) note(`⚠ [${story}] Codex 리뷰: ${msg}`);
  const storyFile = findStoryFile(story);
  if (!storyFile) return { ok: false, why: "스토리 파일 없음" };
  const storyKey = basename(storyFile, ".md");
  const md = readFileSync(storyFile, "utf8");
  const r = renderReviewFindings({ story: storyKey, model: w.spec.model, date: today(), targetRef: w.targetRef, round: reviewRoundOf(md) + 1, result: json });
  let next = insertReviewFindings(md, r.block);
  // (F30) 이번 라운드 0건이어도 **이전 라운드의 열린 Patch/Decision** 이 남아 있으면 done 이 아니다
  let newStatus = r.newStatus;
  const openLeft = countOpenFindings(next, "Patch") + countOpenFindings(next, "Decision");
  if (newStatus === "done" && openLeft > 0) {
    newStatus = "in-progress";
    note(`[${story}][CODEX][REVIEW] 이번 라운드 0건 — 그러나 이전 라운드 열린 findings ${openLeft}건 잔존 ⇒ in-progress 유지(done 아님)`);
  }
  const st = setStoryStatus(next, newStatus);
  next = st.text;

  // ── (N8 · 2026-09-02 2차 리뷰) 트랜잭션형 적용 ────────────────────────────────────────
  // 종전에는 스토리·sprint 를 **먼저 쓰고** 인박스를 나중에 썼다. 인박스가 디렉터리이거나 쓰기 불가면
  // exit 4 로 멈추는데 스토리에는 이미 열린 Decision 과 바뀐 Status 가 남는다(부분 적용). 이제
  // ① 모든 결과 문자열을 메모리에서 만들고 ② `.tmp` 에 기록한 뒤 ③ **인박스를 먼저 확정**하고
  // ④ 나머지를 rename 한다. 어느 단계든 실패하면 **어떤 파일도 바뀌지 않는다**.
  const writes = []; // { path, text, label }  — 확정 순서(인박스 먼저)
  let sprintNote = "sprint-status 없음";
  let inboxCreated = false;
  if (r.decisions.length) {
    let base = INBOX_TEMPLATE();
    if (existsSync(decisionsInboxFile)) {
      try { base = readFileSync(decisionsInboxFile, "utf8"); } catch (e) {
        return { ok: false, why: `Decision ${r.decisions.length}건을 인박스(${rel(decisionsInboxFile)})에 등재하지 못했다: 기존 내용을 읽을 수 없다(${e?.code ?? e?.message}) — 단일 창구가 비면 사람이 결정을 못 본다(스토리·sprint 는 원상 유지)` };
      }
    } else inboxCreated = true;
    writes.push({ path: decisionsInboxFile, text: appendDecisionsInbox(base, { storyKey, date: today(), decisions: r.decisions, mode: FULL ? "post-hoc" : "wait" }), label: "인박스" });
  }
  writes.push({ path: storyFile, text: next, label: "스토리" });
  if (existsSync(sprintStatusFile)) {
    const s = setSprintStatus(readFileSync(sprintStatusFile, "utf8"), storyKey, newStatus, today());
    if (s.changed) { writes.push({ path: sprintStatusFile, text: s.text, label: "sprint-status" }); sprintNote = `sprint-status ${storyKey}=${newStatus}`; }
    else sprintNote = `⚠ sprint-status 에 키 ${storyKey} 없음 — 스토리 파일만 갱신`;
  }
  if (r.deferred.length && existsSync(deferredWorkFile)) {
    writes.push({ path: deferredWorkFile, text: appendDeferredWork(readFileSync(deferredWorkFile, "utf8"), `Deferred from: Codex code review of ${storyKey} (${today()} · codex exec)`, r.deferred), label: "deferred-work" });
  }
  const tmps = [];
  const cleanupTmps = () => { for (const t of tmps) { try { unlinkSync(t); } catch { /* 이미 없음 */ } } };
  try {
    for (const w2 of writes) {
      const tmp = `${w2.path}.auto-tmp-${process.pid}`;
      mkdirSync(dirname(w2.path), { recursive: true });
      writeFileSync(tmp, w2.text);
      tmps.push(tmp);
      w2.tmp = tmp;
    }
  } catch (e) {
    cleanupTmps();
    return { ok: false, why: `리뷰 결과를 임시 파일에 쓰지 못했다(${e?.code ?? e?.message}) — 원본 파일은 하나도 바뀌지 않았다` };
  }
  for (const w2 of writes) {
    try { renameSync(w2.tmp, w2.path); } catch (e) {
      cleanupTmps();
      // 인박스가 첫 확정 대상이라, 여기서 실패하면 스토리·sprint 는 **아직 원본 그대로**다.
      if (w2.label === "인박스") {
        return { ok: false, why: `Decision ${r.decisions.length}건을 인박스(${rel(w2.path)})에 등재하지 못했다: 확정(rename) 실패 ${e?.code ?? e?.message} — 단일 창구가 비면 사람이 결정을 못 본다(스토리·sprint 는 원상 유지)` };
      }
      return { ok: false, why: `${w2.label}(${rel(w2.path)}) 확정 실패: ${e?.code ?? e?.message}` };
    }
  }
  if (inboxCreated) note(`[${story}][CODEX][REVIEW] DECISIONS-INBOX.md 가 없어 기본 형식으로 생성했다: ${rel(decisionsInboxFile)}`);
  if (r.decisions.length) note(`[${story}][CODEX][REVIEW] 결정 대기 ${r.decisions.length}건 인박스 등재(단일 창구)`);
  reviewResults[story] = { provider: "codex", model: w.spec.model || "default", result: newStatus === "done" ? "clean" : "findings", counts: r.counts, status: newStatus, warnings: v.warnings };
  note(`[${story}][CODEX][REVIEW] 기재 완료 — decision ${r.counts.decision} · patch ${r.counts.patch}(high ${r.counts.high}${r.counts.promoted ? ` · 5범주 승격 ${r.counts.promoted}` : ""}) · defer ${r.counts.defer} · optional ${r.counts.optional} → status=${newStatus} · ${sprintNote}${st.changed ? "" : " · ⚠ 스토리 Status 줄 없음"}`);
  return { ok: true };
}

// ---- (P1) 워커 준비 — 프로바이더 분기는 여기서만 ----
function prepareWorker(stage, story, variant) {
  const role = variant?.role ?? stage; // dev | review | create | repair | replan | mockup
  const avoid = stage === "review" && stages.includes("dev") ? models.dev : null;
  if ((stage === "replan" || stage === "mockup") && parseModelSpec(models[stage]).provider === "codex") {
    note(`⇄ [${story}] ${stage}: codex 는 이 단계를 돌릴 수 없다(파일 쓰기·프로젝트 스킬 필요) → claude 기본 모델`);
    models[stage] = "";
  }
  const wantsCodex = parseModelSpec(models[stage]).provider === "codex";
  const resolved = resolveWorkerSpec({ spec: models[stage], availability: wantsCodex ? providerAvailability() : {}, avoid, codexCwd: wantsCodex ? codexCwdInfo() : { ok: true } });
  if (resolved.fallback) {
    note(`⇄ [${story}] ${stage}: ${resolved.why}`);
    // (검증표 #2) 가용성 폴백도 **프로바이더 전환**이다 — 스토리당 1회 상한에 함께 센다(종전엔 한도 사다리만 셌다).
    countProviderSwitch(story, stage, resolved.spec, "가용성 폴백");
    models[stage] = formatModelSpec(resolved.spec);
  }
  const spec = resolved.spec;
  const storyFile = findStoryFile(story);
  const storyRel = storyFile ? rel(storyFile) : `_bmad-output/implementation-artifacts/${story}.md`;
  const guardCommit = role === "dev" || role === "repair" || role === "replan" || role === "mockup"; // 워커가 HEAD 를 움직이면 안 된다(replan/mockup 도 사후 HEAD·브랜치·stash 검사)
  if (spec.provider === "codex") {
    const outFile = resolve(logDir, `codex-${hash8(story)}-${role}.last.txt`);
    let prompt, targetRef = "", schemaPath = null, reviewInputs = null;
    const transient = [outFile];
    if (role === "review") {
      const d = prepareReviewDiff(story);
      if (d.empty) {
        // (F10/F18) 볼 diff 가 없는 Codex 리뷰는 「0건 → done」 거짓 완료를 만든다 — claude 리뷰(bmad-code-review 가 대상을 스스로 정한다)로 넘긴다
        try { unlinkSync(d.diffFile); } catch { /* 없음 */ }
        const alt = MODEL_LADDER.find((m) => m !== parseModelSpec(models.dev).model) ?? "";
        note(`⇄ [${story}] review: 리뷰 대상 diff 가 비어 Codex 리뷰 무의미 → claude/${alt || "cli-default"} 로 전환`);
        countProviderSwitch(story, "review", alt, "빈 diff"); // (검증표 #2) 이 전환도 스토리당 상한에 든다
        models.review = alt;
        return prepareWorker(stage, story, variant);
      }
      targetRef = d.targetRef;
      schemaPath = CODEX_REVIEW_SCHEMA;
      transient.push(d.diffFile);
      reviewInputs = { storyFile: storyRel, diffFile: rel(d.diffFile), changedFiles: d.files };
      prompt = codexReviewPrompt({ story, storyFile: storyRel, diffFile: rel(d.diffFile), changedFiles: d.files, targetRef });
    } else if (role === "repair") {
      prompt = codexRepairPrompt({ story, storyFile: storyRel, qaCmd, attempt: variant.attempt, maxAttempts: variant.maxAttempts, failure: variant.failure, integrity: variant.integrity ?? [], guard: GUARD });
    } else {
      prompt = codexDevPrompt({ story, storyFile: storyRel, sprintStatusFile: rel(sprintStatusFile), qaCmd, guard: GUARD });
    }
    // build*Command 는 **문자열이 아니라** `{ file, argv, display, sandbox }` 를 돌려준다(셸 결합 제거 · #6).
    // 실행에는 객체를 통째로 넘기고 로그에는 display 만 쓴다.
    const built = buildCodexCommand({ bin: codexBin, role, cwd: process.cwd(), model: spec.model, schemaPath, outFile, networkAccess: codexNetwork });
    return {
      provider: "codex", spec, role, prompt, cmd: built, display: built.display, targetRef, guardCommit, transient, reviewInputs,
      perm: `sandbox:${built.sandbox}`, stageLabel: role === "repair" ? "dev-repair" : stage,
      // (F17/F28) 머신 전역 슬롯 — 같은 auth.json 을 쓰는 codex 워커는 동시에 codexMax 개까지(기본 1)
      run: (env) => withCodexSlot({ max: codexMax, waitMs: stageTimeoutMs, staleMs: slotStaleMsFor(stageTimeoutMs), note: (m) => note(`[${story}]${m}`) }, () => runCodexWorker({ cmd: built, prompt, timeoutMs: stageTimeoutMs, outFile, env })),
      // (F21) 도구 출력 속 401/429 오판 방지 — 오류 이벤트 + stderr 우선
      classify: (_text, res) => classifyCodexFailure(codexFailureText(res)),
    };
  }
  const prompt = role === "repair"
    ? codexRepairPrompt({ story, storyFile: storyRel, qaCmd, attempt: variant.attempt, maxAttempts: variant.maxAttempts, failure: variant.failure, integrity: variant.integrity ?? [], guard: GUARD })
    : prompts[stage](story);
  // --settings pipeline-settings.json = nested 인스턴스에만 commit/push/파괴 deny 적용
  // (사람의 settings.json은 deny-free → 대화형 커밋 자유). 엔진 no-commit 가드레일 이중 방어.
  const built = buildClaudeCommand({ bin: claudeBin, model: spec.model, permMode, settingsPath });
  return {
    provider: "claude", spec, role, prompt, cmd: built, display: built.display, targetRef: "", guardCommit, transient: [], reviewInputs: null,
    perm: permMode, stageLabel: role === "repair" ? "dev-repair" : stage,
    run: (env) => runClaudeWorker({ cmd: built, prompt, timeoutMs: stageTimeoutMs, env }),
    classify: (text) => classifyFailure(text),
  };
}

// 반환: "ok" | "stop" (사유는 내부에서 note + exit) | "auth"|"limit"|"spend"(호출부 runStage 가 대기·사다리 판단)
function runClaude(stage, story, variant = null) {
  const w = prepareWorker(stage, story, variant);
  const model = w.spec.provider === "codex" ? formatModelSpec(w.spec) : w.spec.model;
  // ⚠️ 아래 두 줄(`→ [story] stage (…)` · `exit=`)은 현황판(dev-status)이 읽는 형식 — 바꾸지 않는다.
  note(`→ [${story}] ${w.stageLabel} (model=${shownModel(model)}, perm=${w.perm})`);
  note(`[${story}][${w.provider.toUpperCase()}][${w.role.toUpperCase()}] start model=${shownModel(model)} cwd=${process.cwd()}${w.targetRef ? ` target=${w.targetRef}` : ""}`);
  if (dryRun) {
    note(`   (dry-run) ${w.display}  <<< ${w.prompt.split("\n")[0]}`);
    for (const f of w.transient) { try { unlinkSync(f); } catch { /* 없음 */ } }
    return "ok";
  }
  const beforeMaxMtime = storyArtifactsMaxMtime(story); // 사후조건용 전-스냅샷
  stageSnapshot = stage === "replan" ? replanSignals(story) : stage === "mockup" ? { mockups: mockupKeys(story).length } : null;
  const headBefore = w.guardCommit ? headSha() : "";
  const branchBefore = w.guardCommit ? currentBranch() : "";
  const stashBefore = w.guardCommit ? stashCount() : 0;
  const fpBefore = w.role === "repair" ? treeFingerprint() : "";
  const remoteBefore = remoteHeads(); // (#3 2차 방어) 사후 비교로 push 를 되돌릴 수는 없지만, 일어난 사실은 반드시 안다
  const localBefore = localGitFingerprint(); // (N2) 절대경로 git 우회의 흔적 — reflog 는 원상복구돼도 자란다
  // (#3) 워커 프로세스의 git 을 **실행 단계에서** 막는다 — PATH shim(읽기 전용 허용 목록) + GIT_ALLOW_PROTOCOL=none.
  //      사후 HEAD/브랜치/stash 비교는 아래에 2차 방어로 남는다(push·commit→reset 은 사후 비교로 안 잡힌다).
  // (N2 · 2026-09-02 2차 리뷰) 종전에는 shim 생성 실패를 **경고 후 계속**으로 넘겼다 — 차단이 필요한 바로
  // 그 순간에 차단이 없는 채로 워커가 돈다(fail-open). 이제 만들지 못하면 워커를 아예 띄우지 않는다.
  let guard = null;
  try { guard = createGitGuard({ baseEnv: process.env }); } catch (e) {
    note(`✖ COMMIT GUARD STOP — [${story}] ${w.stageLabel}: git 차단 shim 을 만들지 못했다(${e?.code ?? e?.message}). 차단 없이 워커를 실행하지 않는다(fail-closed) — git 설치·PATH·임시 폴더 권한을 확인하세요.`);
    push("GIT GUARD STOP", `[${story}] git 차단 shim 생성 실패 — 워커 미실행(사람 확인 필요)`);
    writeExitInfo({ code: 6, kind: "git-guard-init", provider: w.provider, story, stage, why: String(e?.code ?? e?.message ?? "GIT_GUARD_INIT_FAILED") });
    process.exit(6);
  }
  const workerEnv = guard ? workerEnvWithGuard(guard) : undefined;
  // (F19/필수 결정 3) codex 실행 동안 `.env*` 를 작업 루트 밖으로 — 배치 워크트리에도 실자격증명 사본이 있다.
  // 하나라도 못 옮기면 **실행하지 않는다**(fail-closed · exit 6). 복원 실패도 exit 6.
  // (N4/N5) 대상은 `.env*` 만이 아니라 **isSensitivePath 전부**(pem·auth.json·service-account*.json·*secret*…) —
  // diff 에서 뺀 파일을 Codex 가 작업 디렉터리에서 그냥 `cat` 하면 제외가 무의미하다. 탐색 실패도 fail-closed.
  let hold = { moved: [], holdDir: null };
  if (w.provider === "codex") {
    try { hold = hideSensitiveFiles(process.cwd()); } catch (e) {
      guard?.cleanup();
      note(`✖ COMMIT GUARD STOP — [${story}] ${w.stageLabel}: ${e?.message ?? e}`);
      push("ENV ISOLATION STOP", `[${story}] 민감 파일 격리 실패 — Codex 실행 중단(사람 확인 필요)`);
      writeExitInfo({ code: 6, kind: "env-isolation", provider: "codex", story, stage, why: String(e?.code ?? "ENV_ISOLATION_FAILED") });
      process.exit(6);
    }
  }
  if (hold.moved.length) note(`[${story}][CODEX][${w.role.toUpperCase()}] 민감 파일 격리 ${hold.moved.length}건(실행 동안만 · 종료 후 복원)`);
  let res, restoreFailure = null;
  try {
    res = w.run(workerEnv);
  } finally {
    if (hold.moved.length) {
      // finally 안에서 던지면 원 오류(워커 실패)를 가린다 — 사유만 담아 두고 아래에서 판정한다.
      try { restoreEnvFiles(process.cwd(), hold); } catch (e) { restoreFailure = e; }
    }
    guard?.cleanup();
  }
  if (restoreFailure) {
    note(`✖ COMMIT GUARD STOP — [${story}] ${w.stageLabel}: ${restoreFailure?.message ?? restoreFailure}`);
    push("ENV RESTORE STOP", `[${story}] .env 복원 실패 — 보관 폴더에서 사람이 되돌려야 한다`);
    writeExitInfo({ code: 6, kind: "env-restore", provider: w.provider, story, stage, why: String(restoreFailure?.code ?? "ENV_RESTORE_FAILED") });
    process.exit(6);
  }
  const logFile = resolve(logDir, `${story}-${w.stageLabel}${variant?.attempt ? `-${variant.attempt}` : ""}.log`);
  // (정책 2) 워커 출력에는 QA 로그·파일 내용이 섞여 들어온다 — 프로바이더를 가리지 않고 값 마스킹한다.
  // ⚠️ 로그 기록 실패가 **가드 검사를 건너뛰게 하면 안 된다**(2026-09-02 실측: 워커가 `git add -A` 로 엔진 로그를
  //   커밋에 쓸어 담고 `reset --hard` 하면 로그 폴더가 통째로 사라진다 → 종전 코드는 여기서 던져 exit 1 로 죽었고
  //   아래 git 가드는 아예 돌지 않았다 = 우회 성립). 폴더를 다시 만들고, 그래도 못 쓰면 경고만 남기고 계속한다.
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(logFile, `# ${w.display}\n# provider=${w.provider} role=${w.role}\n# prompt:\n${scrubLog(w.prompt)}\n\n## stdout\n${scrubLog(res.stdout || "")}\n\n## stderr\n${scrubLog(res.stderr || "")}\n${res.lastMessage ? `\n## last message\n${scrubLog(res.lastMessage)}\n` : ""}`);
  } catch (e) {
    note(`⚠ [${story}] 워커 로그를 쓰지 못했다(${e?.code ?? e?.message}) — 가드 검사는 그대로 진행한다.`);
  }
  for (const f of w.transient) { try { unlinkSync(f); } catch { /* 없음 */ } }
  const code = res.code;
  const timedOut = res.timedOut;
  note(`   exit=${code}${timedOut ? " (TIMEOUT)" : ""} log=${logFile}`);
  if (res.events?.usage) note(`[${story}][CODEX][${w.role.toUpperCase()}] usage in=${res.events.usage.input_tokens ?? "?"} out=${res.events.usage.output_tokens ?? "?"} cmds=${res.events.commands} files=${res.events.fileChanges}`);

  // (#3) ① 실행 단계 차단이 걸렸는가(shim 이 exit 86 + `[GIT-GUARD] blocked:` 를 남긴다) ② 원격 ref 가 움직였는가.
  //      둘 중 하나라도면 워커가 git 상태를 바꾸려 했다는 뜻이다 — 사람 게이트.
  //      ③ (N2) 로컬 reflog·ref 지문이 달라졌는가 — 절대경로 git 으로 `commit → reset` 을 해도 reflog 는 자란다.
  const guardBlocked = Boolean(guard) && (code === guard.exitCode || `${res.stderr || ""}\n${res.stdout || ""}`.includes(guard.blockedPrefix));
  const remoteAfter = remoteHeads();
  const localAfter = localGitFingerprint();
  if (guardBlocked || remoteBefore !== remoteAfter || localBefore !== localAfter) {
    const why = [
      guardBlocked ? `워커가 금지된 git 명령을 실행하려다 차단됨(${guard.blockedPrefix} · exit ${guard.exitCode})` : "",
      remoteBefore !== remoteAfter ? "원격 ref 가 실행 전후로 달라졌다(push 의심 — 절대경로 git 우회)" : "",
      localBefore !== localAfter ? "로컬 reflog/ref 지문이 달라졌다(commit·reset·branch 우회 의심 — HEAD 가 원상복구돼도 reflog 는 남는다)" : "",
    ].filter(Boolean).join(" · ");
    note(`✖ COMMIT GUARD STOP — [${story}] ${w.stageLabel}: ${why}. 워커의 commit/push/stash/reset 은 금지다(엔진만 커밋한다) — **사람 확인 후 재개**. log=${logFile}`);
    push("COMMIT GUARD STOP", `[${story}] 워커 git 조작 차단 — 사람 확인 필요`);
    writeExitInfo({ code: 6, kind: "git-guard", provider: w.provider, story, stage, why });
    process.exit(6);
  }

  // (P6/F4) 워커 커밋 가드(2차 방어) — dev/repair 워커가 HEAD·브랜치·stash 를 움직였으면 즉시 STOP
  if (w.guardCommit && headBefore) {
    const moved = [];
    if (headSha() !== headBefore) moved.push(`HEAD ${headBefore.slice(0, 7)} → ${headSha().slice(0, 7)}`);
    if (currentBranch() !== branchBefore) moved.push(`브랜치 ${branchBefore} → ${currentBranch()}`);
    if (stashCount() !== stashBefore) moved.push(`stash ${stashBefore} → ${stashCount()}`);
    if (moved.length) {
      note(`✖ COMMIT GUARD STOP — [${story}] ${w.stageLabel}: 워커(${w.provider})가 git 상태를 움직였다(${moved.join(" · ")}). 워커의 직접 commit/branch/stash 는 금지 — 사람 확인 필요. log=${logFile}`);
      push("COMMIT GUARD STOP", `[${story}] 워커 git 상태 변경 감지(${moved.join(" · ")}) — 사람 확인 필요`);
      process.exit(6);
    }
  }

  // (F31) 수리 워커는 코드만 고쳐도 일한 것이다 — 스토리 md mtime 또는 워킹트리 지문 변화 중 하나면 사후조건 충족
  let postOk = postconditionOk(stage, story, beforeMaxMtime) || (w.role === "repair" && treeFingerprint() !== fpBefore);
  // (P2) Codex 리뷰는 read-only 라 파일을 못 쓴다 — JSON 을 엔진이 기재한 것이 사후조건이다
  if (w.provider === "codex" && w.role === "review" && code === 0 && !timedOut) {
    const applied = applyCodexReview(story, res, w);
    if (!applied.ok) {
      note(`✖ NO-OP STOP — [${story}] ${stage}: Codex 리뷰 exit=0 이지만 ${applied.why}. 로그를 확인하세요: ${logFile}`);
      push("NO-OP STOP", `[${story}] ${stage} — Codex 리뷰 결과를 기재하지 못함. 로그 확인 필요.`);
      process.exit(4);
    }
    postOk = true;
  }

  if (code === 0 && postOk) return "ok";
  if (code === 0 && !postOk) {
    // (U2) no-op 차단: CLI가 오류를 삼키고 exit 0 — 산출물 무변경이면 성공 아님
    note(`✖ NO-OP STOP — [${story}] ${stage}: exit=0 이지만 스토리 산출물이 갱신되지 않음. 로그를 확인하세요: ${logFile}`);
    push("NO-OP STOP", `[${story}] ${stage} — exit 0인데 산출물 무변경. 로그 확인 필요.`);
    process.exit(4);
  }
  if (code !== 0 && postOk) {
    // (U2) 작업 완료 후 비정상 종료(stream-idle 류) → 경고 후 계속
    note(`⚠ [${story}] ${stage}: 산출물은 완성됐으나 프로세스가 비정상 종료(exit=${code}). "작업 완료 후 비정상 종료"로 간주하고 계속.`);
    return "ok";
  }
  // code !== 0 && !postOk
  const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
  {
    const kind = w.classify(combined, res);
    // (U3/U7/U8/U8-b) 인증·지출 한도·사용량 한도 — 호출부(runStage)가 대기/중단 판단
    if (kind !== "other") return kind;
  }
  if (timedOut) {
    note(`✖ STOP — [${story}] ${stage} 타임아웃(${stageTimeoutMs / 60000}분 초과). 배치 중단. log=${logFile}`);
  } else {
    note(`✖ STOP — [${story}] ${stage} 실패(exit=${code}). 배치 중단. log=${logFile}`);
  }
  // 2026-08-28 진단 보강(2026-08-27 밤 2-3 실사고): 세션 stdout 이 「완료」 보고인데 스토리
  // 산출물 mtime 이 전진하지 않은 경우 — 보고가 실물과 다르다(거짓 완료 보고). 아침 분석이
  // 로그 대조 없이 원인을 즉시 알 수 있게 STOP 사유에 명시한다. 판정 자체는 종전(실측 우선).
  if (/완료|완주/.test((res.stdout || "").slice(-3000))) {
    note(`   ⚠ 보고·실물 불일치 — 세션 stdout 은 완료를 보고하나 스토리 산출물(md) mtime 미전진. 세션 보고를 신뢰하지 말고 파일 실물로 판단할 것.`);
  }
  note(escalationReport({
    story, stage, situation: `${w.provider} 워커가 ${timedOut ? "타임아웃" : `exit=${code}`}로 끝났고 스토리 산출물이 갱신되지 않았다`,
    cause: `분류 other(인증·한도 아님) — 로그 확인: ${logFile}`,
    tried: [`${w.provider} 워커 1회(모델 ${shownModel(model)})`],
    options: ["로그의 마지막 오류를 보고 같은 명령 재실행(완료 단계 자동 skip)", "스토리 스펙·환경(권한 allow 규칙·의존성)을 고친 뒤 재실행", `해당 단계 모델/프로바이더를 바꿔 재실행(--${stage}-model)`],
    recommendation: "로그 확인 후 같은 명령 재실행", risk: "낮음(산출물 무변경 · 커밋 0)",
  }));
  push("BATCH STOP", `[${story}] ${stage} ${timedOut ? "타임아웃" : `실패(exit=${code})`} — 로그 확인 필요.`);
  process.exit(1);
}

/** 단계 실행 + 인증·한도 오류 시 (U7/U8) 대기·자동 재시도. 성공 외에는 내부에서 exit. */
const MAX_AUTH_RETRY_PER_STAGE = 5; // 프로브만 통과하고 단계는 계속 실패하는 병리 케이스의 무한루프 방지

// 모델 품질 사다리(👤 2026-08-28 운영 원칙): 최상위 모델을 우선 쓰되, **그 모델만 한도**에 걸리면
// 대기하지 말고 차순위로 자동 전환해 계속 일한다(월 지출 한도는 대기로 안 풀린다 — 같은 날 실사고:
// fable 만 차단·opus 정상인데 배치 전체가 한도 대기로 공전). 전환은 그 단계·그 배치에 한정된다.
// 👤 2026-08-29 개정: AUTO_MODEL_LADDER 환경변수로 사다리를 좁힐 수 있다(예: "fable" 단일 =
// 타 모델 자동 강등 금지 — 정보 오류 사유. 한도 시 전환 대신 waitAuthMin 리셋 대기로 떨어진다).
// v3: 사다리 끝에서 **다른 프로바이더**로 넘어갈 수 있다(--codex-roles 의 역할 · 가용 · 전환 1회 상한).
const MODEL_LADDER = (process.env.AUTO_MODEL_LADDER || "fable,opus,sonnet")
  .split(",").map((s) => s.trim()).filter(Boolean);
// avoid = 교차검증 회피 대상(리뷰가 dev 와 같은 모델로 떨어지지 않게 건너뛴다 — 👤 2026-08-28:
// 같은 모델의 자기 검증은 같은 맹점을 공유한다).
function nextModelDown(model, avoid) {
  const r = nextWorkerDown({ current: model, avoid, ladder: MODEL_LADDER, availability: {}, allowedProviders: ["claude"] });
  return r ? formatModelSpec(r.next) : null;
}
/** v3 — 프로바이더까지 포함한 사다리. 반환 { spec, switched } 또는 null. 전환 횟수는 **스토리당** 1회(F33). */
function nextWorkerSpec(stage, story, avoid) {
  const allowed = allowedProvidersFor(stage);
  const availability = allowed.includes("codex") ? providerAvailability() : {};
  const r = nextWorkerDown({ current: models[stage], avoid, ladder: MODEL_LADDER, availability, allowedProviders: allowed, switchesUsed: switchesUsed[story] ?? 0, maxSwitches: 1 });
  if (!r) return null;
  if (r.switched) switchesUsed[story] = (switchesUsed[story] ?? 0) + 1;
  return { spec: formatModelSpec(r.next), switched: r.switched };
}

// 교차검증 강제(👤 2026-08-28) — 같은 배치에서 dev 가 실제로 쓴 모델과 review 모델이 같아지면
// (장부가 같거나, dev 가 사다리로 강등돼 우연히 겹친 경우) review 를 「dev 와 다른 모델 중
// 최상위」로 바꾼다: dev=opus → review=fable(상위 교차 우선), fable 한도면 사다리가 sonnet(하위
// 교차)으로. sonnet 리뷰는 범위 고정 회수 diff 에는 충분하고, 신규 구현 리뷰가 sonnet 까지
// 떨어지는 조합은 이 순서상 발생하지 않는다(신규 dev=fable → review 는 opus 부터).
// v3: 프로바이더 차원까지 본다(codex↔codex 면 claude 최상위) — 자동으로 codex 로 옮기지는 않는다(비용은 편성기 몫).
function enforceCrossModel(stage) {
  if (stage !== "review" || !stages.includes("dev")) return;
  const r = enforceCrossSpec({ dev: models.dev, review: models.review, ladder: MODEL_LADDER });
  if (r.changed) {
    const alt = formatModelSpec(r.review);
    note(`⇄ review 모델 교차검증 조정: dev 와 동일(${shownModel(models.dev)}) → ${shownModel(alt)} (같은 모델 자기 검증 방지)`);
    models.review = alt;
  }
}

function runStage(stage, story, variant = null) {
  enforceCrossModel(stage);
  for (let authRetry = 0; ; authRetry++) {
    const r = runClaude(stage, story, variant); // "ok" | "auth" | "limit" | "spend"
    if (r === "ok") return;
    const avoid = stage === "review" && stages.includes("dev") ? models.dev : null;
    // (U8-b) spend 는 사다리를 타지 않는다 — 계정 전체 지갑이라 어떤 모델로 바꿔도 같다.
    if (r === "limit") {
      const down = nextWorkerSpec(stage, story, avoid);
      if (down) {
        note(`↘ [${story}] ${stage}: ${shownModel(models[stage])} 한도 — ${shownModel(down.spec)} 로 자동 전환(${down.switched ? "프로바이더 전환 · 스토리당 1회" : "품질 사다리 차순위"} · 대기 없음)`);
        push("MODEL FALLBACK", `[${story}] ${stage} — ${shownModel(models[stage])} 한도로 ${shownModel(down.spec)} 전환(자동)`);
        if (down.switched) discardPartialWork(stage, story); // 이어받기 금지 — 다른 벤더는 처음부터
        models[stage] = down.spec;
        continue; // 전환 즉시 재시도(사다리는 최대 2단 + 프로바이더 전환 1회 — 재시도 상한 5 안에서 충분)
      }
    }
    // v3: codex 인증 오류는 밤에 사람이 풀 수 없다 — 다른 프로바이더가 있으면 그쪽으로(전환 1회 상한)
    if (r === "auth" && parseModelSpec(models[stage]).provider === "codex") {
      const down = nextWorkerSpec(stage, story, avoid);
      if (down) {
        note(`↘ [${story}] ${stage}: codex 인증 불가 — ${shownModel(down.spec)} 로 전환(대기 없음)`);
        if (down.switched) discardPartialWork(stage, story);
        models[stage] = down.spec;
        continue;
      }
    }
    const failedProvider = parseModelSpec(models[stage]).provider;
    // 대기 모드면 복구 후 같은 단계 재실행, 아니면 handleFailure가 exit(3|5)
    if (authRetry >= MAX_AUTH_RETRY_PER_STAGE) {
      note(`✖ ${KIND[r].tag} STOP — [${story}] ${stage}: 복구 후에도 ${MAX_AUTH_RETRY_PER_STAGE}회 연속 ${KIND[r].what}. 환경 점검 필요(재로그인 계정·CLAUDE_BIN·네트워크·한도). 배치 중단.`);
      push(`${KIND[r].tag} STOP`, `[${story}] ${stage} — ${MAX_AUTH_RETRY_PER_STAGE}회 연속 ${KIND[r].what}. 환경 점검 필요.`);
      writeExitInfo({ code: KIND[r].exit, kind: r, provider: failedProvider, story, stage, why: `${MAX_AUTH_RETRY_PER_STAGE}회 연속` });
      process.exit(KIND[r].exit);
    }
    writeExitInfo({ code: KIND[r].exit, kind: r, provider: failedProvider, story, stage, why: KIND[r].what });
    // (F3) codex 실패는 claude 프로브로 복구를 판정할 수 없다 — 대기 없이 STOP(pollable=false)
    handleFailure(r, `[${story}] ${stage}`, resolve(logDir, `${story}-${stage}.log`), failedProvider !== "codex");
    note(`↻ [${story}] ${stage} 재시도 (복구 후, ${authRetry + 1}/${MAX_AUTH_RETRY_PER_STAGE})`);
  }
}

/** (M5 · 2026-09-02 3차 리뷰) 설정에 적힌 자유형 명령 한 줄 → 실행파일 + argv.
 *  종전에는 qa·조건부 게이트·배치 e2e 가 전부 `spawnSync(cmd, { shell:true })` 였다 — 저장소 안 설정
 *  한 줄이 `npm run qa & git push …` 이면 두 번째 명령이 그대로 돌았다. 이제 셸을 거치지 않는다.
 *  형식이 규율을 벗어나면(셸 연산자·따옴표 불균형) **실행 전에** 멈춘다 — 없는 검사를 통과로 세지 않기 위해
 *  RED 가 아니라 fail-closed STOP(exit 6)이다(설정 오류를 코드 결함으로 오진하지 않는다). */
function planCommand(label, cmd) {
  try {
    return normalizeCommand(cmd);
  } catch (e) {
    note(`✖ COMMAND FORMAT STOP — ${label}: ${e?.message ?? e}`);
    note(`   형식: \`<실행파일> <인자>…\`(공백 구분 · 따옴표 허용). \`&&\`·\`|\`·\`;\`·리디렉션 같은 셸 연산자는 쓸 수 없다 — 사슬은 npm script 안에 두세요.`);
    push("COMMAND FORMAT STOP", `${label} 명령 형식 거부 — 셸 연산자·메타문자는 실행하지 않는다`);
    writeExitInfo({ code: 6, kind: "command-format", provider: "n/a", story: "", stage: label, why: String(e?.code ?? e?.message ?? "UNSAFE_COMMAND") });
    process.exit(6);
  }
}

function runQaGate(story) {
  note(`→ [${story}] qa-gate: ${qaCmd}`);
  if (dryRun) {
    note(`   (dry-run) skip qa`);
    return { code: 0, out: "" };
  }
  const plan = planCommand("qa 게이트(--qa)", qaCmd);
  const res = spawnSafe(plan.file, plan.argv, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: stageTimeoutMs,
  });
  const logFile = resolve(logDir, `${story}-qa.log`);
  // (정책 2) qa 로그는 stdout/stderr 를 그대로 적었다 — 토큰·URL 자격증명이 출력되면 로그와 repair 프롬프트에 남는다.
  const out = scrubLog(`${res.stdout || ""}\n${res.stderr || ""}`);
  writeFileSync(logFile, `# ${qaCmd}\n\n## stdout\n${scrubLog(res.stdout || "")}\n\n## stderr\n${scrubLog(res.stderr || "")}\n`);
  note(`   qa exit=${res.status} log=${logFile}`);
  return { code: res.status ?? 1, out };
}

/** (#10) 조건부 게이트 실제 실행 — 트리거가 켜지고 package.json 에 대응 스크립트가 있으면 **돌린다**.
 *  종전에는 「있으면 사람 확인」 로그만 남기고 매니페스트에 not-run 을 적었다(탐지만 하고 실행 안 함).
 *  반환 { script, cmd, exit, result } · 실패는 품질 루프의 RED 로 전파된다(수리 루프 대상). */
function runConditionalGate(story, name, gate) {
  note(`→ [${story}] ${name}-gate: ${gate.cmd}`);
  if (dryRun) { note(`   (dry-run) skip ${name}`); return { script: gate.script, cmd: gate.cmd, exit: 0, result: "skipped(dry-run)" }; }
  const plan = planCommand(`${name} 게이트(package.json scripts.${gate.script})`, gate.cmd);
  const res = spawnSafe(plan.file, plan.argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: stageTimeoutMs });
  const logFile = resolve(logDir, `${story}-${name}.log`);
  const out = scrubLog(`${res.stdout || ""}\n${res.stderr || ""}`);
  writeFileSync(logFile, `# ${gate.cmd}\n\n## stdout\n${scrubLog(res.stdout || "")}\n\n## stderr\n${scrubLog(res.stderr || "")}\n`);
  const exit = res.status ?? 1;
  note(`   ${name} exit=${exit} log=${logFile}`);
  return { script: gate.script, cmd: gate.cmd, exit, result: exit === 0 ? "pass" : "fail", out, logFile };
}

// ---- (P4) 품질 루프 — 무결성 검사 → qa 게이트 → (RED 면 예산 안에서 수리 → 재검증) ----
const pkgScripts = (() => { try { return JSON.parse(readFileSync(resolve("package.json"), "utf8")).scripts ?? {}; } catch { return {}; } })();
const gates = detectGates(pkgScripts);
const qaChain = parseQaChain(pkgScripts.qa ?? "");
const qualityLog = {}; // story → { attempts, signatures, integrity, qaExit, failureKind, escalation }
function workingTreeChanges() {
  const changes = git(["diff", "--name-status", "HEAD", "--"]).out.split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [status, ...rest] = l.split(/\t/); return { status, path: rest[rest.length - 1] }; });
  let diff = git(["diff", "HEAD", "--"]).out;
  // (#8) 미추적 **신규** 파일은 종전에 이름만 changes 에 들어가고 내용은 어떤 검사도 받지 않았다 —
  // 수리 워커가 `tests/new.test.ts` 를 새로 만들며 `describe.only` 를 넣으면 qa 는 일부만 돌고 무결성도 통과했다.
  // 이제 미추적 파일 본문을 무결성 diff 에 넣는다(텍스트 · 1MB 상한 · 바이너리 제외 · 민감 경로 제외).
  for (const f of splitLines(git(["ls-files", "--others", "--exclude-standard"]).out)) {
    changes.push({ status: "A", path: f });
    if (f.includes("auto-pipeline-logs/") || isSensitivePath(f)) continue;
    const d = untrackedUnifiedDiff(f);
    if (d) diff += `\n${d}`;
  }
  return { changes, diff, files: changes.map((c) => c.path) };
}
/** (#10) 트리거된 조건부 게이트를 실제로 실행한다. 실패면 품질 루프가 쓰는 failure 객체를 돌려준다(= RED).
 *  스크립트가 없으면 종전대로 정직하게 기록만 한다(매니페스트 required-missing) — 없는 검사를 통과로 세지 않는다. */
function runTriggeredGates(story, q) {
  for (const name of ["security", "performance"]) {
    const trig = q[name];
    const gate = gates[name];
    if (!trig?.required) continue;
    if (!gate?.available) {
      note(`[${story}][QUALITY] ${name === "security" ? "보안" : "성능"} 트리거 ${trig.reasons.length}건 — 프로젝트에 대응 스크립트 없음(매니페스트 required-missing · 사람 확인)`);
      continue;
    }
    note(`[${story}][QUALITY] ${name === "security" ? "보안" : "성능"} 트리거 ${trig.reasons.length}건 — 게이트 ${gate.cmd} 실행`);
    const r = runConditionalGate(story, name, gate);
    q[name] = { ...trig, script: r.script, exit: r.exit, result: r.result };
    if (r.exit !== 0) {
      const c = classifyQaFailure(r.out ?? "");
      note(`[${story}][QUALITY][FAIL] ${name} 게이트 RED(exit ${r.exit}) — ${gate.cmd}`);
      return { kind: name, signature: `${name}:${r.script}:${c.signature}`, excerpt: c.excerpt || String(r.out ?? "").slice(-4000) };
    }
  }
  return null;
}

function runQualityLoop(story) {
  const q = (qualityLog[story] ??= { attempts: 0, signatures: [], integrity: [], qaExit: null, failureKind: "unknown", escalation: null, security: { required: false, reasons: [] }, performance: { required: false, reasons: [] } });
  for (;;) {
    let integ = [];
    if (!dryRun) {
      const wt = workingTreeChanges();
      q.diff = wt.diff; // 완료 판정기(T2 새 테스트 계수)가 이번 변경분을 본다
      // 조건부 게이트 트리거는 무결성 검사와 무관하게 본다 — 트리거가 켜지고 스크립트가 있으면 실제로 돌린다(#10).
      q.security = securityTriggers({ files: wt.files, diff: wt.diff });
      q.performance = performanceTriggers({ files: wt.files, diff: wt.diff });
      if (integrityEnabled) {
        const storyFile = findStoryFile(story);
        integ = testIntegrityFindings({ changes: wt.changes, diff: wt.diff, storyText: storyFile ? readFileSync(storyFile, "utf8") : "" });
        // (F5/F32) 수리 라운드가 새로 만든 skip/ts-ignore/eslint-disable/게이트 설정 변경은 경고가 아니라 차단
        if (q.baselineIntegrity == null) q.baselineIntegrity = integ;
        else integ = escalateRepairIntroduced(q.baselineIntegrity, integ);
        q.integrity = integ;
        for (const f of integ) note(`[${story}][INTEGRITY][${f.level.toUpperCase()}] ${f.rule} ${f.file}${f.line ? ":" + f.line : ""} — ${f.detail}`);
      }
    }
    const blocks = integ.filter((f) => f.level === "block");
    let failure = null;
    if (blocks.length === 0) {
      const qa = runQaGate(story);
      q.qaExit = qa.code;
      if (qa.code === 0) {
        // qa GREEN 이어도 트리거된 조건부 게이트가 남아 있다 — 실행하고, 실패면 품질 루프 RED 다.
        const cg = runTriggeredGates(story, q);
        if (!cg) {
          note(`[${story}][QUALITY][PASS] qa GREEN${q.attempts ? ` (수리 ${q.attempts}회 후)` : ""}${integ.length ? ` · 무결성 경고 ${integ.length}건` : ""}`);
          return;
        }
        failure = cg;
        q.failureKind = failure.kind;
      } else {
        failure = classifyQaFailure(qa.out);
        q.failureKind = failure.kind;
      }
    } else {
      failure = { kind: "integrity", signature: "integrity:" + blocks.map((b) => `${b.rule}:${b.file}`).sort().join("|"), excerpt: blocks.map((b) => `${b.rule} ${b.file}${b.line ? ":" + b.line : ""} — ${b.detail}`).join("\n") };
      q.failureKind = "integrity";
    }
    q.signatures.push(failure.signature);
    note(`[${story}][QUALITY][FAIL] kind=${failure.kind} sig=${failure.signature}`);
    const d = repairDecision({ attempts: q.attempts, signatures: q.signatures, cfg: { totalRepairAttempts: autoRepair, sameRootCauseMaxRetries: repairSameCause } });
    if (!d.repair) {
      // 종전 STOP 문구 그대로(현황판·브리핑이 읽는다) + 에스컬레이션 6절
      const gateFail = failure.kind === "security" || failure.kind === "performance";
      const exitCode = gateFail ? (q[failure.kind]?.exit ?? 1) : (q.qaExit ?? 1);
      if (gateFail) note(`✖ STOP — [${story}] ${failure.kind} 게이트 RED(exit=${exitCode}). 거짓 PASS 차단 → 배치 중단. (사람 개입 필요)`);
      else if (blocks.length === 0) note(`✖ STOP — [${story}] qa RED(exit=${exitCode}). 거짓 PASS 차단 → 배치 중단. (사람 개입 필요)`);
      else note(`✖ STOP — [${story}] 테스트 무결성 차단 ${blocks.length}건(${blocks.map((b) => b.rule).join(", ")}). 거짓 PASS 차단 → 배치 중단. (사람 개입 필요)`);
      q.escalation = escalationReport({
        story, stage: gateFail ? failure.kind : blocks.length ? "integrity" : "qa",
        situation: gateFail ? `${failure.kind} 게이트 RED(exit ${exitCode}) — qa 는 GREEN 이지만 트리거된 조건부 게이트가 실패했다`
          : blocks.length ? `테스트 무결성 차단 ${blocks.length}건` : `qa 게이트 RED(exit ${exitCode}) · 분류 ${failure.kind}`,
        cause: failure.signature,
        tried: q.attempts ? q.signatures.slice(0, -1).map((s, i) => `자동 수리 ${i + 1}차 후 실패: ${s}`) : [autoRepair > 0 ? "자동 수리 예산 판정: " + d.why : "자동 수리 꺼짐(--auto-repair 0)"],
        options: ["로그의 첫 오류를 사람이 고친 뒤 같은 명령 재실행(dev 완료 기록은 유지 · qa 부터 재개)", "스토리 스펙이 틀렸다면 스토리 파일을 고치고 --force 로 dev 재실행", "테스트 자체가 틀렸다면 사유를 스토리 Dev Agent Record 에 적고 테스트 수정"],
        recommendation: d.why, risk: "중간(산출물은 워킹트리에 남음 · 커밋 0)",
      });
      note(q.escalation);
      push("QA RED", `[${story}] qa 게이트 RED — 사람 개입 필요.`);
      finalizeManifest(story, null);
      writeExitInfo({ code: 1, kind: "qa", provider: parseModelSpec(models.dev).provider, story, stage: blocks.length ? "integrity" : "qa", why: failure.signature });
      process.exit(1);
    }
    q.attempts++;
    note(`[${story}][REPAIR] ${d.why} — kind=${failure.kind}`);
    runStage("dev", story, { role: "repair", attempt: q.attempts, maxAttempts: autoRepair, failure, integrity: integ });
  }
}

// ---- (P5) 검증 매니페스트 ----
function finalizeManifest(story, commitSha) {
  if (!writeManifest || dryRun) return;
  try {
    const q = qualityLog[story] ?? {};
    const workers = {};
    for (const st of stages) {
      const p = parseModelSpec(models[st]);
      workers[st] = { provider: p.provider, model: p.model || (p.provider === "codex" ? "default" : "cli-default") };
    }
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
    const m = buildVerificationManifest({
      story, generatedAt: stamp(), branch, commit: commitSha ?? headSha().slice(0, 12),
      workers, gates, qa: { chain: qaChain, exit: q.qaExit ?? (isDone(story, "qa") ? 0 : null), failureKind: q.failureKind ?? "unknown" },
      integrity: q.integrity ?? [], repair: { attempts: q.attempts ?? 0, signatures: q.signatures ?? [], exhausted: Boolean(q.escalation) },
      review: reviewResults[story] ?? (stages.includes("review") ? { provider: workers.review?.provider ?? "claude", model: workers.review?.model ?? "", result: isDone(story, "review") ? "written-by-worker(스토리 파일 참조)" : "not-run" } : null),
      security: q.security ?? { required: false, reasons: [] }, performance: q.performance ?? { required: false, reasons: [] },
      escalation: q.escalation ?? null, notes: [`stages=${stages.join(",")}`, `autoRepair=${autoRepair}`, `integrity=${integrityEnabled ? "on" : "off"}`],
    });
    // (완료 판정 강화) 매니페스트 **형태는 그대로 두고** `completion` 필드만 더한다 — 「없는 검사」를 통과로
    // 세지 않고 not-verified 로 남기는 판정기(completion-rules.mjs)를 여기 한 곳에서만 부른다.
    const sf = findStoryFile(story);
    m.completion = strengthenCompletion({ manifest: m, storyText: sf ? readFileSync(sf, "utf8") : "", diff: q.diff ?? "" });
    // (M2 · 3차 리뷰) T2 의 「정상·실패·경계」 판정 근거를 매니페스트에 **구조화**해 남긴다 — 판정 문장만
    // 남기면 다음 라운드가 근거를 다시 못 센다. `checks.unit` 은 pass/fail 문자열 계약이라 형을 바꾸지 않고
    // 옆에 `checks.unitKinds` 로 붙인다(readiness·현황판이 `String(checks.unit)` 으로 읽는다).
    m.checks.unitKinds = m.completion.evidence?.newTests?.kinds ?? null;
    writeFileSync(resolve(logDir, `${story}-verification.json`), JSON.stringify(m, null, 2) + "\n");
  } catch (e) {
    note(`⚠ [${story}] 매니페스트 기록 실패(계속): ${e?.message ?? e}`);
  }
}

// ---- (#7) 이 스토리에서 **Claude 로 resolve 되는 단계**가 하나라도 있는지 ----
// 종전에는 실행할 단계가 있으면 무조건 `claude -p` 프로브를 먼저 찔렀다. dev·review 가 전부 codex 면
// Claude 로그인이 만료됐다는 이유만으로 배치가 exit 3(또는 한도 대기)로 서 버린다(codex-review-r1 #7).
// codex 스펙이라도 **불가해서 claude 로 폴백될 단계**는 claude 가 필요하다 — 그때는 종전대로 프로브한다.
function storyNeedsClaude(story) {
  for (const stage of stages) {
    const willRun = stage === "create" ? !findStoryFile(story) : (!isDone(story, stage) || force);
    if (!willRun) continue;
    if (parseModelSpec(models[stage]).provider !== "codex") return true;
    const r = resolveWorkerSpec({ spec: models[stage], availability: providerAvailability(), avoid: null, codexCwd: codexCwdInfo() });
    if (r.spec.provider === "claude") return true;
  }
  return false;
}

// ---- (U6) 이 스토리에서 실제 실행될 단계가 있는지 (전량 skip이면 프로브 생략) ----
function storyNeedsWork(story) {
  for (const stage of stages) {
    if (stage === "create") {
      if (!findStoryFile(story)) return true;
    } else if (!isDone(story, stage) || force) {
      return true;
    }
    if (stage === "dev" && !isDone(story, "qa")) return true; // qa 게이트 재실행 필요
  }
  return false;
}

// ---- 메인 루프 (순차 = 의존성 순서) ----
// (U4) append — 이전 배치 기록 보존. 배치 경계는 구분선으로.
const modelsShown = Object.fromEntries(Object.entries(models).map(([k, v]) => [k, shownModel(v)]));
appendFileSync(runLog, `\n${"=".repeat(70)}\n[${stamp()}] BATCH START stories=[${stories.join(", ")}] stages=[${stages.join(", ")}] models=${JSON.stringify(modelsShown)} perm=${permMode} dryRun=${dryRun} force=${force} waitAuthMin=${waitAuthMin} e2e=${e2eCmd || "-"} ntfy=${ntfyTopic ? "on" : "off"} commit=${doCommit} branch=${branchName || "-"} push=${doPush} autoRepair=${autoRepair} integrity=${integrityEnabled ? "on" : "off"} codexRoles=${codexRoles.join(",") || "-"} autonomy=${autonomy}\n`);
note(`=== auto-story-pipeline v2: ${stories.length} 스토리 × [${stages.join(", ")}] ===`);
// (N2 · 2026-09-02 2차 리뷰) 종전에는 경고만 남기고 계속했다 — nested 인스턴스의 commit/push deny 가
// 통째로 빠진 채 무인 배치가 돌았다는 뜻이다(fail-open). 이제 없으면 시작하지 않는다.
if (!settingsPath) {
  note(`✖ SETTINGS STOP — pipeline-settings.json 미발견(${settingsOverride ? `명시 지정 ${settingsOverride}` : "프로젝트 .claude/·전역 ~/.claude/ 모두"}). nested 워커의 commit/push deny 설정 없이는 배치를 시작하지 않는다(fail-closed).`);
  note(`   조치: ① 프로젝트 \`.claude/pipeline-settings.json\`(워크트리에서 돌리려면 **커밋돼 있어야 한다**) ② 전역 \`~/.claude/pipeline-settings.json\` ③ \`--pipeline-settings <경로>\` 또는 \`PIPELINE_SETTINGS_PATH\` — 셋 중 하나에 deny 규칙(Bash(git commit…)·Bash(git push…) 등)을 두고 다시 실행하세요.`);
  push("SETTINGS STOP", "pipeline-settings.json 미발견 — nested deny 없이 배치를 시작하지 않는다");
  writeExitInfo({ code: 6, kind: "settings-missing", provider: "n/a", story: stories[0] ?? "", stage: "startup", why: "pipeline-settings.json not found" });
  process.exit(6);
}
// (H3 · 3차 리뷰) 워커 env 에서 자격증명을 지워도 **원격 URL 에 토큰이 박혀 있으면** 무의미하다
// (`https://x:ghp_…@github.com/…` 는 env 없이도 push 가 된다). 워커를 띄우기 **전에** 잡고 멈춘다.
// URL 값은 로그에 남기지 않는다(원격 이름만) — 로그가 토큰의 새 유출 경로가 되면 안 된다.
{
  const credRemotes = findCredentialRemotes(git(["remote", "-v"]).out);
  if (credRemotes.length) {
    note(`✖ REMOTE CREDENTIAL STOP — 원격 URL 에 자격증명이 박혀 있다(${credRemotes.join(", ")}). 워커 env 에서 인증 수단을 지워도 이 URL 하나로 push 가 되므로 배치를 시작하지 않는다(fail-closed).`);
    note(`   조치: \`git remote set-url ${credRemotes[0]} https://호스트/소유자/저장소.git\` 로 토큰을 빼고, 자격증명은 credential helper 에 두세요.`);
    push("REMOTE CREDENTIAL STOP", `원격 URL 에 자격증명(${credRemotes.join(", ")}) — 배치 미시작`);
    writeExitInfo({ code: 6, kind: "remote-credential", provider: "n/a", story: stories[0] ?? "", stage: "startup", why: `remote url embeds credentials: ${credRemotes.join(",")}` });
    process.exit(6);
  }
}
if (wantProviders().includes("codex") || noCodex) providerAvailability(); // (P1) 요청됐을 때만 감지 · 한 줄 기록
try { unlinkSync(exitInfoFile); } catch { /* 이전 배치 부기 없음 */ } // 러너가 낡은 STOP 사유를 읽지 않게

ensureBranch();

for (const story of stories) {
  note(`──────── STORY ${story} ────────`);

  // ---- (U6) 스토리 경계 인증·한도 프로브 — 만료를 스토리 중간이 아닌 경계에서 감지 ----
  if (!dryRun && storyNeedsWork(story) && !storyNeedsClaude(story)) {
    note(`↷ [${story}] Claude 인증 프로브 생략 — 이 스토리의 남은 단계가 전부 codex 다(실제 실행할 프로바이더만 검사).`);
  } else if (!dryRun && storyNeedsWork(story)) {
    for (;;) {
      const p = authProbe(); // "ok" | "auth" | "limit" | "other"
      if (p === "ok") break;
      if (p === "other") {
        note(`⚠ [${story}] 프로브가 비인증·비한도 사유로 실패 — 배치는 계속 진행(실패 시 단계에서 판정).`);
        break;
      }
      // 프로브 경로에도 품질 사다리를 적용한다(2026-08-28 잔여 봉합: runStage 만 고치고 이 경로를
      // 빠뜨려, dev=fable 큐가 스토리 경계 프로브에서 30분 한도 대기로 빠졌다). 프로브는 dev 모델을
      // 찌르므로(effectiveProbeModel) dev 를 강등하면 다음 프로브가 그 모델로 재판정한다.
      // (U8-b) spend 는 여기서도 사다리를 안 탄다 — 아래 handleFailure 가 즉시 안내하고 멈춘다.
      if (p === "limit") {
        // v3: dev 가 codex 스펙이면 프로브는 다른 claude 단계 모델을 찔렀다 — 그 경우 강등 대상은 dev 가 아니다(그대로 대기 경로).
        const down = parseModelSpec(models.dev).provider === "claude" ? nextModelDown(models.dev, null) : null;
        if (down) {
          note(`↘ [${story}] 경계 프로브 한도 — dev 모델 사다리 강등 ${shownModel(models.dev)} → ${shownModel(down)} (대기 없음)`);
          push("MODEL FALLBACK", `[${story}] 경계 프로브 — dev ${shownModel(models.dev)} 한도로 ${shownModel(down)} 전환(자동)`);
          models.dev = down;
          continue;
        }
      }
      writeExitInfo({ code: KIND[p].exit, kind: p, provider: "claude", story, stage: "probe", why: KIND[p].what });
      handleFailure(p, `[${story}] 시작 전 프로브`, null); // 대기 모드면 복구 후 재프로브
    }
  }

  for (const stage of stages) {
    // ---- (U1) skip 판정 ----
    if (stage === "create") {
      // create: 유효한 스토리 파일이 이미 있으면 항상 skip(--force 로도 재실행 불가 — dev가 갱신한
      // 스펙·Dev Notes 보호). 재생성하려면 스토리 파일을 직접 삭제 후 실행.
      if (findStoryFile(story)) {
        note(`↷ [${story}] create skip — 스토리 파일이 이미 존재 (--force 무시, 재생성=파일 삭제 후).`);
        if (!isDone(story, "create")) markDone(story, "create");
        continue;
      }
    } else if (isDone(story, stage) && !force && stage === "dev" && hasNoCompletedWork(story)) {
      // (U1-b) 허수 완주 방지 — 기록을 믿지 않고 실제로 돌린다(👤 2026-08-30 승인 (a)).
      note(`⚠ [${story}] dev 완료 기록을 무시한다 — 스토리에 완료 Task 0건 · 미완 1건 이상(허수 완주 방지). 실제로 실행한다.`);
      invalidate(story, "dev", "qa", "review");
    } else if (isDone(story, stage) && !force) {
      note(`↷ [${story}] ${stage} skip — state.json 완료 기록 (재실행=--force).`);
      // dev가 skip이면 qa도 이미 통과한 기록이 있을 때만 skip (아래 qa 블록에서 판정)
      if (stage === "dev" && !isDone(story, "qa")) {
        runQualityLoop(story); // RED 면 내부에서 STOP(exit 1) — 수리 예산이 있으면 그 안에서만 재시도
        markDone(story, "qa");
      }
      continue;
    }

    // ---- 실행 전 하위 단계 기록 무효화 (재실행 정합) ----
    if (stage === "create") invalidate(story, "dev", "qa", "review");
    if (stage === "replan" || stage === "mockup") invalidate(story, "dev", "qa", "review"); // 계획·화면이 바뀌면 구현부터 다시
    if (stage === "dev") invalidate(story, "qa", "review");

    runStage(stage, story); // 실패 시 내부에서 exit (인증 오류는 대기 모드 시 자동 재시도)
    markDone(story, stage);
    // replan 이 「남은 일은 전부 사람 몫」(BLOCKED-ON-HUMAN)이라고 선언했으면 dev/review 를 돌리지 않는다 —
    // 돌려 봐야 산출물이 없어 NO-OP exit 4 로 차단기만 누적한다. 커밋은 아래에서 그대로 한다(표식이 원장에 남아야 편성기가 뺀다).
    if (stage === "replan" && replanSignals(story).blocked) {
      note(`↷ [${story}] replan 이 사람 질문(BLOCKED-ON-HUMAN)을 남겼다 — 남은 단계(${stages.slice(stages.indexOf(stage) + 1).join(",") || "없음"})는 건너뛴다.`);
      break;
    }

    // dev 직후 qa 게이트 (stages에 dev가 있을 때만)
    if (stage === "dev") {
      runQualityLoop(story); // qa RED → (예산 안 수리) → 그래도 RED 면 STOP(exit 1)
      markDone(story, "qa");
    }
  }
  finalizeManifest(story, null);
  const sha = commitStory(story, stages);
  if (sha) finalizeManifest(story, sha);
  note(`✔ [${story}] 완료 (review 상태까지).${doCommit ? ` 스토리 커밋${doPush ? "+푸시(" + branchName + ")" : ""} 수행 — 정본 main 반영은 사람 머지.` : " 커밋/푸시는 사람 게이트 — 미실행."}`);
}

// ---- (2026-08-08) 배치 종료 e2e 스모크 — 프로젝트가 --e2e 로 명령을 지정한 경우에만, 전 스토리 완주 후 1회 ----
if (e2eCmd) {
  note(`→ batch-e2e (전 스토리 완주 후 1회): ${e2eCmd}`);
  if (dryRun) {
    note(`   (dry-run) skip e2e`);
  } else {
    const e2ePlan = planCommand("배치 e2e(--e2e)", e2eCmd);
    const res = spawnSafe(e2ePlan.file, e2ePlan.argv, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: stageTimeoutMs,
    });
    const e2eLog = resolve(logDir, "batch-e2e.log");
    // (정책 2/N3) 종전에 이 로그만 stdout/stderr 를 **원문** 기록했다 — e2e 가 토큰·DB URL 을 찍으면 그대로 남는다.
    writeFileSync(e2eLog, `# ${e2eCmd}\n\n## stdout\n${scrubLog(res.stdout || "")}\n\n## stderr\n${scrubLog(res.stderr || "")}\n`);
    note(`   e2e exit=${res.status} log=${e2eLog}`);
    if ((res.status ?? 1) !== 0) {
      note(`✖ E2E RED — 스토리 산출물은 완료됐지만 배치 종료 e2e 스모크가 실패. 커밋 전 원인 확인 필요. log=${e2eLog}`);
      // (N1) 보류했던 push 는 **하지 않는다** — 로컬 auto/* 에만 커밋이 남고 원격은 불변이다.
      if (pendingPush) note(`   ⛔ 보류했던 push 를 취소한다(원격 불변 · 로컬 ${branchName} 의 커밋은 사람이 확인 후 처리).`);
      push("E2E RED", `스토리 ${stories.length}건 산출물은 완료 — 단 e2e 스모크 RED. push 0건(원격 불변).`);
      process.exit(1);
    }
    note(`   ✅ e2e 스모크 통과`);
    pushDeferred(); // (N1) 전 스토리 + 배치 e2e 가 GREEN 인 지금, 한 번만 민다
  }
}
// `--defer-push` 만 켜고 `--e2e` 가 없으면(러너가 자기 통합 게이트를 돌리는 편성) 여기서 밀지 않는다 —
// 러너가 게이트 GREEN 뒤에 직접 push 한다. 그 사실을 로그에 남겨 「push 가 왜 없나」를 아침에 헤매지 않게 한다.
if (deferPush && pendingPush && !e2eCmd) {
  note(`ℹ --defer-push: 스토리 커밋은 로컬 ${branchName} 에만 있다 — 통합 게이트 GREEN 뒤 러너가 push 한다(엔진 push 0건).`);
}

note(`=== 배치 완료: ${stories.length} 스토리. ${doCommit ? `스토리 단위 커밋${doPush ? "+푸시(" + branchName + ")" : ""} 수행 — main 머지는 사람 승인.` : "커밋/푸시 안 함 — diff·리뷰 리포트 검토 후 수동 진행하세요."} ===`);
push("BATCH DONE", `${stories.length} 스토리 완료${e2eCmd && !dryRun ? " + e2e 스모크 통과" : ""} — diff·리뷰 검토 후 커밋은 수동.`);
process.exit(0);
