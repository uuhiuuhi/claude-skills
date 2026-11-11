// 깃러너 도우미 — 배포 요청서(JSON) 읽기·검사 · 마이그레이션 묶음(apply-prod.sql) 만들기 · 교체 대상 찾기.
// 사용(부르는 쪽 = gitrunner.sh):
//   node gitrunner-lib.mjs validate <요청.json>            → 문제 줄 출력 · 문제 있으면 exit 1
//   node gitrunner-lib.mjs get <요청.json> <키>            → 값 출력(배열은 줄마다)
//   node gitrunner-lib.mjs replaced <a.sql> …              → 「function 이름」「view 이름」 줄(교체 전 정의를 떠 둘 대상) · 유일 색인이면 「unique 파일」
//   node gitrunner-lib.mjs build-apply <출력.sql> <묶음이름> <a.sql> …  → begin · 이미 적용 검사 · 파일 통째 · 장부 기록 · commit
//   node gitrunner-lib.mjs result <요청.json> <결과.json> <상태> <한 줄> [키=값 …]  → 결과 파일 쓰기(요청 내용 + 상태)
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const [cmd, ...args] = process.argv.slice(2)
const SHA = /^[0-9a-f]{40}$/
const read = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))

if (cmd === 'validate') {
  const r = read(args[0]); const bad = []
  for (const k of ['id', 'requester', 'branch', 'commit', 'summary', 'checks', 'rollback']) if (!r[k] || typeof r[k] !== 'string') bad.push(`필수 칸 없음: ${k}`)
  if (r.commit && !SHA.test(r.commit)) bad.push('commit 은 40자리 커밋 번호')
  if (r.base && !SHA.test(r.base)) bad.push('base 는 40자리 커밋 번호')
  if (r.branch && !/^auto\//.test(r.branch)) bad.push('branch 는 auto/ 로 시작')
  if (r.db && !Array.isArray(r.db.files)) bad.push('db.files 는 배열')
  if (r.db?.files?.length && (!r.db.compat || !r.db.access)) bad.push('DB 파일이 있으면 db.compat(ⓖ 지금 화면이 그대로 도는 이유)·db.access(ⓗ 누가 읽고 실행) 필수')
  for (const b of bad) console.log(b)
  process.exit(bad.length ? 1 : 0)
}

if (cmd === 'get') {
  const r = read(args[0]); let v = r
  for (const k of args[1].split('.')) v = v?.[k]
  if (v == null) process.exit(0)
  console.log(Array.isArray(v) ? v.join('\n') : typeof v === 'object' ? JSON.stringify(v) : String(v))
  process.exit(0)
}

// 주석·문자열 대충 걷어 내기(판정용 — 정본 판정은 tools/ops/additive-check.mjs)
const strip = (s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '$$$$')

if (cmd === 'replaced') {
  for (const f of args) {
    const s = strip(readFileSync(f, 'utf8'))
    for (const m of s.matchAll(/create\s+or\s+replace\s+function\s+("?[\w]+"?\.)?"?(\w+)"?/gi)) console.log(`function ${(m[1] ?? 'public.').replace(/"/g, '')}${m[2]}`)
    for (const m of s.matchAll(/create\s+or\s+replace\s+view\s+("?[\w]+"?\.)?"?(\w+)"?/gi)) console.log(`view ${(m[1] ?? 'public.').replace(/"/g, '')}${m[2]}`)
    if (/create\s+unique\s+index/i.test(s)) console.log(`unique ${basename(f)}`)
  }
  process.exit(0)
}

if (cmd === 'build-apply') {
  const [out, bundle, ...files] = args
  const metas = files.map((f) => {
    const m = /^(\d{14})_(.+)\.sql$/.exec(basename(f))
    if (!m) { console.error(`파일 이름이 <14자리>_<이름>.sql 이 아님: ${f}`); process.exit(1) }
    return { f, version: m[1], name: m[2] }
  })
  const q = (s) => s.replace(/'/g, "''")
  const lines = [
    `-- 운영 적용 묶음 · ${bundle} · 깃러너 자동 · 한 트랜잭션(하나라도 실패하면 전부 되돌아간다)`,
    'begin;',
    'do $gitrunner_guard$ begin',
    `  if exists (select 1 from supabase_migrations.schema_migrations where version in (${metas.map((m) => `'${m.version}'`).join(',')})) then`,
    "    raise exception '이미 적용된 판이 있습니다 — 중단(아무것도 바뀌지 않음)';",
    '  end if;',
    'end $gitrunner_guard$;',
  ]
  for (const m of metas) {
    lines.push('', `-- ===== ${basename(m.f)} (파일 통째) =====`, readFileSync(m.f, 'utf8').replace(/^﻿/, ''), ';')
    lines.push(`insert into supabase_migrations.schema_migrations(version, name, statements) values ('${m.version}', '${q(m.name)}', array['applied via gitrunner apply-prod.sql (file whole) · ${q(bundle)}']);`)
  }
  lines.push('commit;', '')
  writeFileSync(out, lines.join('\n'))
  console.log(metas.map((m) => m.version).join(' '))
  process.exit(0)
}

if (cmd === 'result') {
  const [reqPath, out, status, line, ...kv] = args
  let req = {}
  try { req = read(reqPath) } catch { /* 요청서가 깨졌어도 결과는 남긴다 */ }
  const extra = Object.fromEntries(kv.map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]))
  writeFileSync(out, JSON.stringify({ ...req, result: { status, line, at: new Date().toISOString(), ...extra } }, null, 2) + '\n')
  process.exit(0)
}

console.error('모르는 명령: ' + cmd); process.exit(2)
