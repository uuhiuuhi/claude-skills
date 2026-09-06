// Read old records without discarding unknown fields or changing their filenames.
export function migrateRecord(value) {
  if (Array.isArray(value)) return value.map(migrateRecord);
  if (!value || typeof value !== 'object') return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrateRecord(item)]));
  if (typeof out.schema === 'string') out.schema = out.schema.replace(/^(night-batch-ops|auto-story-finish)\//, 'batch-24-multiag/');
  return out;
}

export function readRecord(text) { return migrateRecord(JSON.parse(text)); }
