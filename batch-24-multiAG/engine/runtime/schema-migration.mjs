import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

// Read old records without discarding unknown fields or changing their filenames.
export function migrateRecord(value) {
  if (Array.isArray(value)) return value.map(migrateRecord);
  if (!value || typeof value !== 'object') return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrateRecord(item)]));
  if (typeof out.schema === 'string') out.schema = out.schema.replace(/^(night-batch-ops|auto-story-finish)\//, 'batch-24-multiag/');
  return out;
}

export function readRecord(text) { return migrateRecord(JSON.parse(text)); }

/** 장부 파일 원자적 쓰기 — 임시 파일에 다 쓴 뒤 rename 으로 바꿔 끼운다. 도중에 프로세스가 죽거나 디스크가 차도(ENOSPC)
 *  원래 파일은 그대로 남는다(2026-11-15 실사고: state.json 직접 덮어쓰기 중 ENOSPC → 0바이트 → 구현자 기록 소실 → 마감 재검수 exit 5 반복).
 *  Windows 의 rename 은 기존 파일을 덮어쓴다(MoveFileEx REPLACE_EXISTING) — 다른 프로세스가 잠깐 잡고 있으면(EPERM·EBUSY·EACCES) 몇 번 다시 한다. */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text);
    for (let i = 0; ; i++) {
      try { renameSync(tmp, file); return; } catch (e) {
        if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1));
      }
    }
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 이미 없음 */ }
    throw e;
  }
}
