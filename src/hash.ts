// FNV-1a 32-bit hash — same algorithm used by Ketama/libmemcached
export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Hash for virtual node i of a given node name.
 * XOR-folds the idx bytes into the base hash via FNV-1a rounds
 * to get well-distributed, avalanche-mixed hashes for each vnode.
 */
export function vnodeHash(node: string, idx: number): number {
  let h = fnv1a32(node);
  // Feed each byte of idx through FNV-1a mixing rounds
  h ^= (idx & 0xff);          h = Math.imul(h, 16777619) >>> 0;
  h ^= ((idx >> 8) & 0xff);  h = Math.imul(h, 16777619) >>> 0;
  h ^= ((idx >> 16) & 0xff); h = Math.imul(h, 16777619) >>> 0;
  h ^= ((idx >> 24) & 0xff); h = Math.imul(h, 16777619) >>> 0;
  return h;
}
