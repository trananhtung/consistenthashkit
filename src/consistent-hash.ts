import { fnv1a32, vnodeHash } from "./hash.js";

export interface ConsistentHashOptions {
  /** Number of virtual nodes per server (higher = better distribution). Default: 150 */
  replicas?: number;
  /** Custom hash function — must return a uint32. Default: FNV-1a 32-bit. */
  hashFn?: (key: string) => number;
}

export interface NodeInfo {
  node: string;
  weight: number;
  virtualNodes: number;
}

/**
 * Consistent hash ring with virtual nodes (Ketama algorithm).
 *
 * Adding or removing a node only remaps keys that were on that node,
 * leaving all other key-node mappings unchanged.
 *
 * @example
 * const ring = new ConsistentHash({ replicas: 150 });
 * ring.addNode("server1");
 * ring.addNode("server2");
 * ring.addNode("server3");
 * ring.getNode("my-cache-key"); // → "server2" (stable)
 */
export class ConsistentHash {
  private readonly _replicas: number;
  private readonly _hashFn: (key: string) => number;
  // Sorted array of virtual node positions
  private _ring: number[] = [];
  // Maps virtual node hash → real node name
  private _map: Map<number, string> = new Map();
  // Tracks per-node virtual node counts for weighted support
  private _weights: Map<string, number> = new Map();

  constructor(opts?: ConsistentHashOptions) {
    this._replicas = opts?.replicas ?? 150;
    this._hashFn = opts?.hashFn ?? fnv1a32;
  }

  /**
   * Add a node with an optional weight multiplier (default: 1).
   * Weight 2 = twice as many virtual nodes = ~2x the keys.
   */
  addNode(node: string, weight = 1): this {
    if (this._weights.has(node)) this.removeNode(node);
    this._weights.set(node, weight);

    const vnodes = Math.round(this._replicas * weight);
    for (let i = 0; i < vnodes; i++) {
      const hash = vnodeHash(node, i);
      this._map.set(hash, node);
    }

    this._rebuild();
    return this;
  }

  /** Remove a node from the ring. Returns true if it existed. */
  removeNode(node: string): boolean {
    if (!this._weights.has(node)) return false;

    const weight = this._weights.get(node)!;
    const vnodes = Math.round(this._replicas * weight);
    for (let i = 0; i < vnodes; i++) {
      const hash = vnodeHash(node, i);
      this._map.delete(hash);
    }
    this._weights.delete(node);
    this._rebuild();
    return true;
  }

  /** Find which node a key maps to. Returns undefined if ring is empty. */
  getNode(key: string): string | undefined {
    if (this._ring.length === 0) return undefined;

    const hash = this._hashFn(key);
    const idx = this._upperBound(hash);
    // Wrap around to first virtual node
    const pos = idx < this._ring.length ? this._ring[idx] : this._ring[0];
    return this._map.get(pos);
  }

  /**
   * Find the N closest nodes (for replication factor N).
   * Returns unique real nodes only — skips duplicate vnodes of same node.
   */
  getNodes(key: string, count: number): string[] {
    if (this._ring.length === 0) return [];

    const unique = new Set<string>();
    const hash = this._hashFn(key);
    let idx = this._upperBound(hash);

    while (unique.size < count && unique.size < this._weights.size) {
      if (idx >= this._ring.length) idx = 0;
      const node = this._map.get(this._ring[idx])!;
      unique.add(node);
      idx++;
    }

    return [...unique];
  }

  /** All real nodes currently in the ring, in insertion order. */
  get nodes(): string[] {
    return [...this._weights.keys()];
  }

  /** Number of real nodes in the ring. */
  get size(): number {
    return this._weights.size;
  }

  /** Whether the ring has no nodes. */
  get isEmpty(): boolean {
    return this._weights.size === 0;
  }

  /** Per-node info (weight, virtual node count). */
  nodeInfo(): NodeInfo[] {
    return [...this._weights.entries()].map(([node, weight]) => ({
      node,
      weight,
      virtualNodes: Math.round(this._replicas * weight),
    }));
  }

  /**
   * Estimate the key distribution across nodes (percentage of ring space).
   * Uses the actual virtual node positions to compute arc lengths.
   */
  distribution(): Map<string, number> {
    const dist = new Map<string, number>();
    for (const node of this._weights.keys()) dist.set(node, 0);

    if (this._ring.length === 0) return dist;

    // Node at position p[i] owns keys from p[i-1]+1 to p[i] (backward arc)
    const MAX = 0xffffffff;
    const n = this._ring.length;
    for (let i = 0; i < n; i++) {
      const curr = this._ring[i];
      const prev = this._ring[(i - 1 + n) % n];
      const arc = i > 0
        ? (curr - prev) / (MAX + 1)
        : (curr + MAX + 1 - prev) / (MAX + 1);
      const node = this._map.get(curr)!;
      dist.set(node, (dist.get(node) ?? 0) + arc);
    }

    // Normalize to percentages
    const total = [...dist.values()].reduce((a, b) => a + b, 0);
    for (const [n, v] of dist) dist.set(n, v / total);
    return dist;
  }

  private _rebuild(): void {
    this._ring = [...this._map.keys()].sort((a, b) => a - b);
  }

  // Returns index of first element > target
  private _upperBound(target: number): number {
    let lo = 0, hi = this._ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._ring[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
