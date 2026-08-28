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
// 가드레일 (하드코딩 — 호출자가 끌 수 없음, v1과 동일):
//   · 스토리 순차 처리(호출자가 준 순서 = 의존성 순서)
//   · dev 후 qa 게이트 RED → 배치 즉시 중단(거짓 PASS 차단)
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
//     [--create-model X] [--dev-model X] [--review-model X] [--probe-model X] \
//     [--qa "npm run qa"] [--e2e "<배치 종료 후 1회 실행할 e2e 명령>"] [--ntfy-topic X] \
//     [--force] [--stage-timeout-min 120] [--wait-auth-min 0] [--dry-run]
//     [--commit] [--branch auto/<이름>] [--push] [--commit-paths "src,tests,..."]
//   (모델 플래그 전부 선택사항 — 미지정 = CLI 기본 모델 / 커밋 플래그 전부 옵트인 — 미지정 = 커밋·푸시 0)

import { spawnSync } from "node:child_process";
import {
  mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync, statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// ---- 인자 파싱 ----
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const stories = (opt("stories", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const stages = (opt("stages", "create,dev,review") || "").split(",").map((s) => s.trim()).filter(Boolean);
// 빈 값 = --model 플래그 생략 = 현재 CLI 기본 모델 (환경 불문 안전 기본값)
const models = {
  create: opt("create-model", ""),
  dev: opt("dev-model", ""),
  review: opt("review-model", ""),
};
const probeModel = opt("probe-model", process.env.PROBE_MODEL || "");
const shownModel = (m) => m || "cli-default";
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
const stageTimeoutMs = Number(opt("stage-timeout-min", "120")) * 60 * 1000;
const waitAuthMin = Number(opt("wait-auth-min", "0")); // 0 = 인증(exit 3)·한도(exit 5) 오류 시 즉시 중단. 인증·한도 대기 공용.
const authPollSec = Number(process.env.AUTH_POLL_SEC || "300"); // 대기 모드 폴링 간격

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
const settingsPath =
  [resolve(".claude/pipeline-settings.json"), join(homedir(), ".claude", "pipeline-settings.json")]
    .find((p) => existsSync(p)) || null;

const artDir = resolve("_bmad-output/implementation-artifacts");
const logDir = resolve(artDir, "auto-pipeline-logs");
mkdirSync(logDir, { recursive: true });
const runLog = resolve(logDir, "run-summary.log");
const stateFile = resolve(logDir, "state.json");
const stamp = () => new Date().toISOString();
const note = (msg) => {
  console.log(msg);
  appendFileSync(runLog, `[${stamp()}] ${msg}\n`);
};
// 푸시 알림(화이트리스트 이벤트 전용: WAIT 진입·각종 STOP·qa RED·E2E RED·배치 완주).
// 본문은 UTF-8 파일 경유(-d @file)로 전송해 cmd.exe 코드페이지 mojibake 회피. 실패=배치 무영향.
function push(title, body) {
  if (!ntfyTopic) return;
  try {
    const bodyFile = resolve(logDir, "ntfy-body.txt");
    writeFileSync(bodyFile, body);
    spawnSync(`curl -s -m 10 -H "Title: [auto-batch] ${title}" -d @"${bodyFile}" https://ntfy.sh/${ntfyTopic}`, {
      shell: true,
      timeout: 15000,
    });
    note(`   🔔 push: ${title}`);
  } catch {
    /* 알림 실패는 무시 — fire-and-forget */
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
  // dev/review: 단계 실행 전 스냅샷보다 산출물 mtime이 실제로 전진했는지
  return storyArtifactsMaxMtime(story) > beforeMaxMtime;
}

// ---- (U3) 인증 오류 패턴 ----
const AUTH_RE = /(\b401\b|unauthorized|failed to authenticate|invalid.{0,3}api.{0,3}key|invalid authentication|authentication.{0,3}(error|failed)|token.{0,30}expired|oauth.{0,20}(error|expired))/i;
// ---- (U8) 사용량 한도 패턴 — 인증(재로그인 필요)과 구분: 한도는 리셋 대기만으로 복구 ----
const LIMIT_RE = /(usage.?limit|rate.?limit|\b429\b|quota exceeded|limit (reached|exceeded|will reset)|too many requests)/i;
// 오류 종류별 메시지·exit code (auth=재로그인 / limit=리셋 대기)
const KIND = {
  auth: { tag: "AUTH", what: "CLI 인증 오류(401/토큰 만료)", fix: "다른 터미널에서 CLI를 대화형으로 열어 재로그인하세요", exit: 3 },
  limit: { tag: "LIMIT", what: "사용량 한도 초과(usage/rate limit)", fix: "한도가 리셋되면 자동 복구됩니다 — 재로그인 불필요(급하면 요금제·한도 확인)", exit: 5 },
};

// ---- (U6/U7) 인증 프로브 + 재로그인 대기 ----
const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));

/** 1콜로 인증·한도 상태 확인(--probe-model 지정 시 그 모델, 미지정 = CLI 기본 모델).
 *  "ok" | "auth"(401류) | "limit"(사용량 한도) | "other"(네트워크 등 — 배치를 막지 않음) */
function authProbe() {
  const res = spawnSync(`${claudeBin} -p${probeModel ? ` --model ${probeModel}` : ""}`, {
    shell: true,
    input: "ok",
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 120000,
  });
  if (res.status === 0) return "ok";
  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  if (AUTH_RE.test(out)) return "auth";
  if (LIMIT_RE.test(out)) return "limit"; // (U8)
  return "other";
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
function handleFailure(kind, context, logFile) {
  if (waitForRecovery(kind, context)) return true;
  const k = KIND[kind];
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
function ensureBranch() {
  if (!doCommit || dryRun) return;
  // 엔진 자신의 로그(auto-pipeline-logs/)는 이전 배치의 마지막 줄이 미커밋으로 남는 것이 정상 — dirty 판정에서 제외
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).out
    .split("\n").filter((l) => l.trim() && !l.includes("auto-pipeline-logs/")).join("\n").trim();
  if (dirty) {
    note("✖ COMMIT GUARD STOP — --commit 은 시작 시점 작업 트리가 clean 이어야 한다(추적 파일 변경 존재 → 이전 작업이 스토리 커밋에 섞인다). 먼저 사람이 커밋/정리.");
    push("COMMIT GUARD STOP", "시작 시 작업 트리 dirty — 사람 정리 후 재실행");
    process.exit(6);
  }
  const cur = git(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  if (!branchName) { note(`ℹ --commit: 현재 브랜치(${cur})에 스토리 단위 커밋(푸시 없음).`); return; }
  if (cur === branchName) { note(`ℹ 브랜치 ${branchName} (현재)`); return; }
  const exists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`]).code === 0;
  const r = exists ? git(["switch", branchName]) : git(["switch", "-c", branchName]);
  if (r.code !== 0) { note(`✖ COMMIT GUARD STOP — 브랜치 전환 실패: ${r.err.trim()}`); process.exit(6); }
  note(`ℹ 브랜치 ${exists ? "전환" : "생성"}: ${branchName} (base=${cur})`);
}
function commitStory(story, stagesDone) {
  if (!doCommit) return;
  if (dryRun) { note(`   (dry-run) commit [${story}] paths=${commitPaths.length} push=${doPush}`); return; }
  git(["reset", "-q"]);
  // 존재하지 않는 pathspec 이 하나라도 있으면 git add 전체가 중단되므로 실존 경로만 넘긴다
  const paths = commitPaths.filter((p) => existsSync(p));
  if (paths.length === 0) { note(`ℹ [${story}] 커밋 화이트리스트 경로가 하나도 없음 — 커밋 생략.`); return; }
  const add = git(["add", "-A", "--", ...paths]);
  if (add.code !== 0) note(`⚠ [${story}] git add 경고: ${add.err.trim().split("\n")[0]}`);
  const staged = git(["diff", "--cached", "--name-only"]).out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (staged.length === 0) { note(`ℹ [${story}] 커밋할 변경 없음(스테이징 0).`); return; }
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
  if (c.code !== 0) { note(`⚠ [${story}] git commit 실패: ${c.err.trim().split("\n")[0]} — 계속 진행(사람 확인)`); return; }
  const sha = git(["rev-parse", "--short", "HEAD"]).out.trim();
  note(`   ✔ commit ${sha} (${staged.length} files)`);
  if (doPush) {
    const p = git(["push", "-u", "origin", branchName]);
    if (p.code !== 0) { note(`⚠ [${story}] git push 실패(계속): ${(p.err || p.out).trim().split("\n").slice(-1)[0]}`); push("PUSH FAILED", `[${story}] push 실패 — 아침에 사람 재시도`); }
    else note(`   ✔ push origin/${branchName}`);
  }
}

// ---- 단계별 프롬프트 (비대화형 + 가드레일 명시) ----
// GUARD는 프로젝트 중립 — 프로젝트 특화 제약(법정 보수성·보호 파일 등)은 실행 cwd의
// 프로젝트 CLAUDE.md가 nested 인스턴스에 자동 로드되어 주입된다(계층화 원칙, 2026-08-08).
const GUARD = "[비대화형] 승인/질문 없이 합리적 기본값으로 끝까지 진행하라. ⚠️ git commit·push 절대 금지. 프로젝트 CLAUDE.md에 명시된 절대 제약(보호 파일·보수성 규칙)을 최우선 준수하라.";
const prompts = {
  create: (s) => `/bmad-create-story ${s}\n\n${GUARD} 스토리 스펙(AC·파일 그라운딩)을 작성·저장하고 종료.`,
  dev: (s) => `/bmad-dev-story ${s}\n\n${GUARD} 구현 후 검증까지 자동 실행.`,
  review: (s) => `/bmad-code-review ${s}\n\n${GUARD} 다른 LLM 관점에서 적대적으로. findings 리포트만 작성(코드 자동수정·commit 금지).`,
};

// 반환: "ok" | "stop" (사유는 내부에서 note + exit)
function runClaude(stage, story) {
  const model = models[stage];
  const prompt = prompts[stage](story);
  // --settings pipeline-settings.json = nested 인스턴스에만 commit/push/파괴 deny 적용
  // (사람의 settings.json은 deny-free → 대화형 커밋 자유). 엔진 no-commit 가드레일 이중 방어.
  const cmd = `${claudeBin} -p${model ? ` --model ${model}` : ""} --permission-mode ${permMode}${settingsPath ? ` --settings "${settingsPath}"` : ""}`;
  note(`→ [${story}] ${stage} (model=${shownModel(model)}, perm=${permMode})`);
  if (dryRun) {
    note(`   (dry-run) ${cmd}  <<< ${prompt.split("\n")[0]}`);
    return "ok";
  }
  const beforeMaxMtime = storyArtifactsMaxMtime(story); // 사후조건용 전-스냅샷
  const res = spawnSync(cmd, {
    shell: true,
    input: prompt,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: stageTimeoutMs, // (U5) 행 방지
  });
  const logFile = resolve(logDir, `${story}-${stage}.log`);
  writeFileSync(logFile, `# ${cmd}\n# prompt:\n${prompt}\n\n## stdout\n${res.stdout || ""}\n\n## stderr\n${res.stderr || ""}\n`);
  const code = res.status ?? 1;
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  note(`   exit=${res.status}${timedOut ? " (TIMEOUT)" : ""} log=${logFile}`);

  const postOk = postconditionOk(stage, story, beforeMaxMtime);

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
  if (AUTH_RE.test(combined)) {
    return "auth"; // (U3/U7) 인증 오류 — 호출부(runStage)가 대기/중단 판단
  }
  if (LIMIT_RE.test(combined)) {
    return "limit"; // (U8) 사용량 한도 — 호출부(runStage)가 대기/중단 판단
  }
  if (timedOut) {
    note(`✖ STOP — [${story}] ${stage} 타임아웃(${stageTimeoutMs / 60000}분 초과). 배치 중단. log=${logFile}`);
  } else {
    note(`✖ STOP — [${story}] ${stage} 실패(exit=${code}). 배치 중단. log=${logFile}`);
  }
  // 진단 보강(실사고: 무인 dev 세션이 stdout 으로 「완료」를 보고했으나 스토리 산출물은
  // 갱신되지 않았다 — 거짓 완료 보고). 아침 분석이 로그 대조 없이 원인을 즉시 알 수 있게
  // STOP 사유에 불일치를 명시한다. 판정 자체는 종전(산출물 실측 우선).
  if (/완료|완주/.test((res.stdout || "").slice(-3000))) {
    note(`   ⚠ 보고·실물 불일치 — 세션 stdout 은 완료를 보고하나 스토리 산출물(md) mtime 미전진. 세션 보고를 신뢰하지 말고 파일 실물로 판단할 것.`);
  }
  push("BATCH STOP", `[${story}] ${stage} ${timedOut ? "타임아웃" : `실패(exit=${code})`} — 로그 확인 필요.`);
  process.exit(1);
}

/** 단계 실행 + 인증·한도 오류 시 (U7/U8) 대기·자동 재시도. 성공 외에는 내부에서 exit. */
const MAX_AUTH_RETRY_PER_STAGE = 5; // 프로브만 통과하고 단계는 계속 실패하는 병리 케이스의 무한루프 방지
function runStage(stage, story) {
  for (let authRetry = 0; ; authRetry++) {
    const r = runClaude(stage, story); // "ok" | "auth" | "limit"
    if (r === "ok") return;
    // 대기 모드면 복구 후 같은 단계 재실행, 아니면 handleFailure가 exit(3|5)
    if (authRetry >= MAX_AUTH_RETRY_PER_STAGE) {
      note(`✖ ${KIND[r].tag} STOP — [${story}] ${stage}: 복구 후에도 ${MAX_AUTH_RETRY_PER_STAGE}회 연속 ${KIND[r].what}. 환경 점검 필요(재로그인 계정·CLAUDE_BIN·네트워크·한도). 배치 중단.`);
      push(`${KIND[r].tag} STOP`, `[${story}] ${stage} — ${MAX_AUTH_RETRY_PER_STAGE}회 연속 ${KIND[r].what}. 환경 점검 필요.`);
      process.exit(KIND[r].exit);
    }
    handleFailure(r, `[${story}] ${stage}`, resolve(logDir, `${story}-${stage}.log`));
    note(`↻ [${story}] ${stage} 재시도 (복구 후, ${authRetry + 1}/${MAX_AUTH_RETRY_PER_STAGE})`);
  }
}

function runQaGate(story) {
  note(`→ [${story}] qa-gate: ${qaCmd}`);
  if (dryRun) {
    note(`   (dry-run) skip qa`);
    return 0;
  }
  const res = spawnSync(qaCmd, {
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: stageTimeoutMs,
  });
  const logFile = resolve(logDir, `${story}-qa.log`);
  writeFileSync(logFile, `# ${qaCmd}\n\n## stdout\n${res.stdout || ""}\n\n## stderr\n${res.stderr || ""}\n`);
  note(`   qa exit=${res.status} log=${logFile}`);
  return res.status ?? 1;
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
appendFileSync(runLog, `\n${"=".repeat(70)}\n[${stamp()}] BATCH START stories=[${stories.join(", ")}] stages=[${stages.join(", ")}] models=${JSON.stringify(modelsShown)} perm=${permMode} dryRun=${dryRun} force=${force} waitAuthMin=${waitAuthMin} e2e=${e2eCmd || "-"} ntfy=${ntfyTopic ? "on" : "off"} commit=${doCommit} branch=${branchName || "-"} push=${doPush}\n`);
note(`=== auto-story-pipeline v2: ${stories.length} 스토리 × [${stages.join(", ")}] ===`);
if (!settingsPath) {
  note(`⚠ pipeline-settings.json 미발견(프로젝트 .claude/·전역 ~/.claude/ 모두) — nested 인스턴스 commit/push deny 없이 진행(GUARD 프롬프트 금지 지시만 적용).`);
}

ensureBranch();

for (const story of stories) {
  note(`──────── STORY ${story} ────────`);

  // ---- (U6) 스토리 경계 인증·한도 프로브 — 만료를 스토리 중간이 아닌 경계에서 감지 ----
  if (!dryRun && storyNeedsWork(story)) {
    for (;;) {
      const p = authProbe(); // "ok" | "auth" | "limit" | "other"
      if (p === "ok") break;
      if (p === "other") {
        note(`⚠ [${story}] 프로브가 비인증·비한도 사유로 실패 — 배치는 계속 진행(실패 시 단계에서 판정).`);
        break;
      }
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
    } else if (isDone(story, stage) && !force) {
      note(`↷ [${story}] ${stage} skip — state.json 완료 기록 (재실행=--force).`);
      // dev가 skip이면 qa도 이미 통과한 기록이 있을 때만 skip (아래 qa 블록에서 판정)
      if (stage === "dev" && !isDone(story, "qa")) {
        const qa = runQaGate(story);
        if (qa !== 0) {
          note(`✖ STOP — [${story}] qa RED(exit=${qa}). 거짓 PASS 차단 → 배치 중단. (사람 개입 필요)`);
          push("QA RED", `[${story}] qa 게이트 RED — 사람 개입 필요.`);
          process.exit(1);
        }
        markDone(story, "qa");
      }
      continue;
    }

    // ---- 실행 전 하위 단계 기록 무효화 (재실행 정합) ----
    if (stage === "create") invalidate(story, "dev", "qa", "review");
    if (stage === "dev") invalidate(story, "qa", "review");

    runStage(stage, story); // 실패 시 내부에서 exit (인증 오류는 대기 모드 시 자동 재시도)
    markDone(story, stage);

    // dev 직후 qa 게이트 (stages에 dev가 있을 때만)
    if (stage === "dev") {
      const qa = runQaGate(story);
      if (qa !== 0) {
        note(`✖ STOP — [${story}] qa RED(exit=${qa}). 거짓 PASS 차단 → 배치 중단. (사람 개입 필요)`);
        push("QA RED", `[${story}] qa 게이트 RED — 사람 개입 필요.`);
        process.exit(1);
      }
      markDone(story, "qa");
    }
  }
  commitStory(story, stages);
  note(`✔ [${story}] 완료 (review 상태까지).${doCommit ? ` 스토리 커밋${doPush ? "+푸시(" + branchName + ")" : ""} 수행 — 정본 main 반영은 사람 머지.` : " 커밋/푸시는 사람 게이트 — 미실행."}`);
}

// ---- (2026-08-08) 배치 종료 e2e 스모크 — 프로젝트가 --e2e 로 명령을 지정한 경우에만, 전 스토리 완주 후 1회 ----
if (e2eCmd) {
  note(`→ batch-e2e (전 스토리 완주 후 1회): ${e2eCmd}`);
  if (dryRun) {
    note(`   (dry-run) skip e2e`);
  } else {
    const res = spawnSync(e2eCmd, {
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: stageTimeoutMs,
    });
    const e2eLog = resolve(logDir, "batch-e2e.log");
    writeFileSync(e2eLog, `# ${e2eCmd}\n\n## stdout\n${res.stdout || ""}\n\n## stderr\n${res.stderr || ""}\n`);
    note(`   e2e exit=${res.status} log=${e2eLog}`);
    if ((res.status ?? 1) !== 0) {
      note(`✖ E2E RED — 스토리 산출물은 완료됐지만 배치 종료 e2e 스모크가 실패. 커밋 전 원인 확인 필요. log=${e2eLog}`);
      push("E2E RED", `스토리 ${stories.length}건 산출물은 완료 — 단 e2e 스모크 RED. 커밋 전 확인 필요.`);
      process.exit(1);
    }
    note(`   ✅ e2e 스모크 통과`);
  }
}

note(`=== 배치 완료: ${stories.length} 스토리. ${doCommit ? `스토리 단위 커밋${doPush ? "+푸시(" + branchName + ")" : ""} 수행 — main 머지는 사람 승인.` : "커밋/푸시 안 함 — diff·리뷰 리포트 검토 후 수동 진행하세요."} ===`);
push("BATCH DONE", `${stories.length} 스토리 완료${e2eCmd && !dryRun ? " + e2e 스모크 통과" : ""} — diff·리뷰 검토 후 커밋은 수동.`);
process.exit(0);
