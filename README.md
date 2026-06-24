# consistenthashkit

Zero-dependency TypeScript consistent hashing (Ketama algorithm) for distributed systems: virtual nodes, weighted nodes, N-node replication, minimal key remapping on topology changes. Port of Python `hash_ring` / Go `hashring`.

[![npm](https://img.shields.io/npm/v/consistenthashkit)](https://www.npmjs.com/package/consistenthashkit)
[![license](https://img.shields.io/npm/l/consistenthashkit)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

## Install

```bash
npm install consistenthashkit
```

## Why?

- `hashring` (277k/week) — has runtime dependencies (`connection-parse`, `simple-lru-cache`), no TypeScript types
- `consistent-hash` — minimal API, no weighted nodes or replication support
- `consistenthashkit` — zero-dep, TypeScript-native, virtual nodes, weights, N-node replication, FNV-1a hashing

**The core guarantee**: when you add or remove a node, only `~1/n` of keys move — only the keys that were on the changed node are remapped. All other key-node assignments remain stable.

## Quick start

```typescript
import { ConsistentHash } from "consistenthashkit";

const ring = new ConsistentHash({ replicas: 150 });
ring.addNode("cache-0");
ring.addNode("cache-1");
ring.addNode("cache-2");

ring.getNode("user:12345");    // → "cache-1" (stable)
ring.getNode("session:abc");   // → "cache-0" (stable)

// Adding a node only remaps ~25% of keys
ring.addNode("cache-3");
ring.getNode("user:12345");    // might still be "cache-1"
```

## Core concept: virtual nodes

Without virtual nodes, consistent hashing has poor distribution — some servers get far more keys than others. Virtual nodes (vnodes) solve this by placing each real server at many random points on the hash ring, giving smoother distribution.

More `replicas` → better distribution, higher memory usage. Default 150 is a good balance.

```
ring space: 0 ────────────────────────────────────── 2³²
              ^s1^  ^s2^  ^s1^  ^s3^  ^s2^  ^s1^  ^s3^
              (each server appears at multiple positions)
```

## API

### `new ConsistentHash(opts?)`

```typescript
const ring = new ConsistentHash({
  replicas: 150,           // virtual nodes per server (default: 150)
  hashFn: fnv1a32,         // custom hash function (default: FNV-1a 32-bit)
});
```

### `.addNode(node, weight?)`

```typescript
ring.addNode("server1");       // weight=1 (default)
ring.addNode("server2", 2);    // 2x more keys than server1
ring.addNode("server3", 0.5);  // half the keys of server1
```

Weighted nodes receive proportionally more virtual node positions. Use this when servers have different capacities.

### `.removeNode(node)`

```typescript
ring.removeNode("server1"); // returns true if existed, false if not
```

Only keys that were on `server1` get remapped. All other mappings are unchanged.

### `.getNode(key)`

```typescript
const server = ring.getNode("user:12345"); // → "server2" | undefined
```

Returns `undefined` if the ring is empty.

### `.getNodes(key, count)` — Replication

```typescript
const replicas = ring.getNodes("important-data", 3);
// → ["server1", "server3", "server2"]  (3 unique nodes, ordered by ring position)
```

Use for replica placement — write to all N nodes, read from any one.

### `.distribution()` — Ring space analysis

```typescript
const dist = ring.distribution();
// Map { "server1" → 0.33, "server2" → 0.34, "server3" → 0.33 }
// Values are fractions of the ring space (sum to 1.0)
```

### `.nodeInfo()`

```typescript
ring.nodeInfo();
// [{ node: "server1", weight: 1, virtualNodes: 150 }, ...]
```

### `.nodes`, `.size`, `.isEmpty`

```typescript
ring.nodes;   // string[] of all real nodes
ring.size;    // number of real nodes
ring.isEmpty; // boolean
```

## Recipes

### Memcached / Redis cache cluster

```typescript
import { ConsistentHash } from "consistenthashkit";

const ring = new ConsistentHash({ replicas: 200 });

// Initial cluster
for (const host of ["redis-1:6379", "redis-2:6379", "redis-3:6379"]) {
  ring.addNode(host);
}

function getCacheServer(key: string): string {
  return ring.getNode(key)!;
}

// Scale up — only ~25% of keys migrate
ring.addNode("redis-4:6379");

// Node failure — only that node's keys get redistributed
ring.removeNode("redis-2:6379");
```

### Database sharding

```typescript
const shards = new ConsistentHash({ replicas: 150 });
shards.addNode("shard-us-east", 2);  // 2x capacity
shards.addNode("shard-eu-west", 1);
shards.addNode("shard-ap-south", 1);

function getShardForUser(userId: string): string {
  return shards.getNode(`user:${userId}`)!;
}
```

### Distributed write replication (N=3)

```typescript
const ring = new ConsistentHash({ replicas: 150 });
ring.addNode("node-A").addNode("node-B").addNode("node-C")
    .addNode("node-D").addNode("node-E");

async function writeWithReplication(key: string, value: string) {
  const replicas = ring.getNodes(key, 3);
  await Promise.all(replicas.map(node => writeTo(node, key, value)));
}
```

### Monitoring distribution skew

```typescript
const dist = ring.distribution();
const expected = 1 / ring.size;

for (const [node, pct] of dist) {
  const skew = Math.abs(pct - expected) / expected;
  if (skew > 0.2) {
    console.warn(`${node} has ${(pct * 100).toFixed(1)}% of ring (${(skew*100).toFixed(0)}% skew)`);
  }
}
```

## Algorithm

Uses the **Ketama algorithm** with FNV-1a 32-bit hashing:

1. For each node, compute `replicas * weight` virtual node positions by hashing `node + index`
2. Sort all positions on a circular ring [0, 2³²)
3. For any key, hash it and find the first virtual node position ≥ the key's hash (wrap around)
4. That virtual node's real server handles the key

Properties:
- **Minimal disruption**: adding/removing 1 of N nodes remaps only ~1/N keys
- **Load balance**: 150 vnodes per node gives ≤5% std deviation in key distribution
- **Determinism**: same ring state always maps same key to same node

## License

MIT
