import { EvidenceError } from './operator-inputs.mjs';

const fail = () => { throw new EvidenceError('invalid_journal'); };

export function snapshotJournalData(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) fail();
  seen.add(value);
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) fail();
  const dataKeys = array ? keys.filter((key) => key !== 'length') : keys;
  if (array && (!Object.hasOwn(descriptors.length ?? {}, 'value') || dataKeys.length !== descriptors.length.value
    || dataKeys.some((key, index) => key !== String(index)))) fail();
  const result = array ? [] : {};
  for (const key of dataKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
    result[key] = snapshotJournalData(descriptor.value, seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}
