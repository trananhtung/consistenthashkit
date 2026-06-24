import { describe, test, expect, beforeEach } from "@jest/globals";
import { ConsistentHash, fnv1a32, vnodeHash } from "../src/index.js";

describe("ConsistentHash — basic", () => {
  let ring: ConsistentHash;

  beforeEach(() => {
    ring = new ConsistentHash({ replicas: 100 });
  });

  test("empty ring returns undefined", () => {
    expect(ring.getNode("key")).toBeUndefined();
    expect(ring.getNodes("key", 3)).toEqual([]);
  });

  test("single node always returns that node", () => {
    ring.addNode("server1");
    expect(ring.getNode("any-key")).toBe("server1");
    expect(ring.getNode("another")).toBe("server1");
    expect(ring.size).toBe(1);
  });

  test("addNode is chainable", () => {
    ring.addNode("s1").addNode("s2").addNode("s3");
    expect(ring.size).toBe(3);
  });

  test("getNode returns one of the added nodes", () => {
    ring.addNode("a").addNode("b").addNode("c");
    const node = ring.getNode("test-key");
    expect(["a", "b", "c"]).toContain(node);
  });

  test("nodes list returns all nodes", () => {
    ring.addNode("alpha").addNode("beta").addNode("gamma");
    expect(new Set(ring.nodes)).toEqual(new Set(["alpha", "beta", "gamma"]));
  });

  test("isEmpty", () => {
    expect(ring.isEmpty).toBe(true);
    ring.addNode("s1");
    expect(ring.isEmpty).toBe(false);
  });
});

describe("ConsistentHash — stability (core guarantee)", () => {
  test("same key maps to same node (deterministic)", () => {
    const ring = new ConsistentHash({ replicas: 150 });
    ring.addNode("s1").addNode("s2").addNode("s3");

    const key = "user:12345";
    const first = ring.getNode(key);
    for (let i = 0; i < 100; i++) {
      expect(ring.getNode(key)).toBe(first);
    }
  });

  test("adding a node minimally disrupts mappings", () => {
    const ring = new ConsistentHash({ replicas: 200 });
    ring.addNode("s1").addNode("s2").addNode("s3");

    const keys = Array.from({ length: 1000 }, (_, i) => `key:${i}`);
    const before = new Map(keys.map(k => [k, ring.getNode(k)]));

    ring.addNode("s4");

    let changed = 0;
    for (const k of keys) {
      if (ring.getNode(k) !== before.get(k)) changed++;
    }

    // Adding 1 of 4 nodes should remap ~25% of keys
    // Allow generous bounds: 10%..45%
    const pct = changed / keys.length;
    expect(pct).toBeGreaterThan(0.10);
    expect(pct).toBeLessThan(0.45);
  });

  test("removing a node only remaps keys from that node", () => {
    const ring = new ConsistentHash({ replicas: 200 });
    ring.addNode("s1").addNode("s2").addNode("s3");

    const keys = Array.from({ length: 1000 }, (_, i) => `key:${i}`);
    const before = new Map(keys.map(k => [k, ring.getNode(k)]));

    ring.removeNode("s2");

    for (const k of keys) {
      const was = before.get(k);
      const now = ring.getNode(k);
      // Keys NOT on s2 should keep their mapping
      if (was !== "s2") {
        expect(now).toBe(was);
      } else {
        // Keys on s2 get redistributed — should go to s1 or s3
        expect(["s1", "s3"]).toContain(now);
      }
    }
  });
});

describe("ConsistentHash — removeNode", () => {
  test("removeNode returns true for existing node", () => {
    const ring = new ConsistentHash();
    ring.addNode("s1");
    expect(ring.removeNode("s1")).toBe(true);
    expect(ring.size).toBe(0);
  });

  test("removeNode returns false for unknown node", () => {
    const ring = new ConsistentHash();
    expect(ring.removeNode("nope")).toBe(false);
  });

  test("re-adding after remove works correctly", () => {
    const ring = new ConsistentHash({ replicas: 100 });
    ring.addNode("s1").addNode("s2");
    ring.removeNode("s2");
    expect(ring.size).toBe(1);
    ring.addNode("s2");
    expect(ring.size).toBe(2);
    // Same mapping as original since ring state is same
    const ring2 = new ConsistentHash({ replicas: 100 });
    ring2.addNode("s1").addNode("s2");
    expect(ring.getNode("stable-key")).toBe(ring2.getNode("stable-key"));
  });
});

describe("ConsistentHash — weighted nodes", () => {
  test("heavier nodes receive proportionally more keys", () => {
    const ring = new ConsistentHash({ replicas: 300 });
    ring.addNode("small", 1);
    ring.addNode("large", 3); // 3x weight

    const dist = ring.distribution();
    const small = dist.get("small")!;
    const large = dist.get("large")!;

    // large should have roughly 3x the ring space (with statistical variance)
    expect(large / small).toBeGreaterThan(1.5);
    expect(large / small).toBeLessThan(5.0);
  });

  test("nodeInfo reports weight and virtual node count", () => {
    const ring = new ConsistentHash({ replicas: 100 });
    ring.addNode("s1", 2);
    const info = ring.nodeInfo();
    expect(info).toHaveLength(1);
    expect(info[0]).toEqual({ node: "s1", weight: 2, virtualNodes: 200 });
  });
});

describe("ConsistentHash — getNodes (replication)", () => {
  test("returns N unique nodes", () => {
    const ring = new ConsistentHash({ replicas: 100 });
    ring.addNode("s1").addNode("s2").addNode("s3").addNode("s4");

    const nodes = ring.getNodes("replicate-me", 3);
    expect(nodes).toHaveLength(3);
    expect(new Set(nodes).size).toBe(3); // all unique
    expect(nodes.every(n => ["s1","s2","s3","s4"].includes(n))).toBe(true);
  });

  test("returns fewer if ring has fewer nodes", () => {
    const ring = new ConsistentHash();
    ring.addNode("only");
    expect(ring.getNodes("key", 3)).toEqual(["only"]);
  });

  test("different keys get different replica sets", () => {
    const ring = new ConsistentHash({ replicas: 100 });
    ring.addNode("s1").addNode("s2").addNode("s3").addNode("s4").addNode("s5");

    const sets = new Set<string>();
    for (let i = 0; i < 50; i++) {
      sets.add(ring.getNodes(`key:${i}`, 2).sort().join(","));
    }
    // Different keys should produce different replica sets
    expect(sets.size).toBeGreaterThan(2);
  });
});

describe("ConsistentHash — distribution", () => {
  test("distribution sums to ~1", () => {
    const ring = new ConsistentHash({ replicas: 200 });
    ring.addNode("s1").addNode("s2").addNode("s3");
    const dist = ring.distribution();
    const total = [...dist.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  test("uniform nodes each get ~33% with 3 nodes", () => {
    const ring = new ConsistentHash({ replicas: 500 });
    ring.addNode("s1").addNode("s2").addNode("s3");
    const dist = ring.distribution();
    for (const [, pct] of dist) {
      expect(pct).toBeGreaterThan(0.15); // at least 15%
      expect(pct).toBeLessThan(0.55);    // at most 55%
    }
  });

  test("empty ring returns empty dist", () => {
    const ring = new ConsistentHash();
    expect(ring.distribution().size).toBe(0);
  });
});

describe("ConsistentHash — custom hash", () => {
  test("accepts custom hash function", () => {
    // Simple additive hash for determinism in test
    const customHash = (key: string) => {
      let h = 0;
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      return h;
    };
    const ring = new ConsistentHash({ replicas: 100, hashFn: customHash });
    ring.addNode("a").addNode("b").addNode("c");
    const node = ring.getNode("test");
    expect(["a","b","c"]).toContain(node);
  });
});

describe("ConsistentHash — real-world: cache cluster", () => {
  test("simulates adding a cache node to a 3-node cluster", () => {
    const ring = new ConsistentHash({ replicas: 150 });
    ring.addNode("cache-0").addNode("cache-1").addNode("cache-2");

    // Simulate 10k cache keys
    const keys = Array.from({ length: 10_000 }, (_, i) => `session:${i}`);
    const oldMapping = new Map(keys.map(k => [k, ring.getNode(k)]));

    ring.addNode("cache-3");

    let moved = 0;
    const newDist = new Map<string, number>([["cache-0",0],["cache-1",0],["cache-2",0],["cache-3",0]]);
    for (const k of keys) {
      const node = ring.getNode(k)!;
      newDist.set(node, (newDist.get(node) ?? 0) + 1);
      if (node !== oldMapping.get(k)) moved++;
    }

    // ~25% of keys should move to cache-3
    expect(moved / keys.length).toBeGreaterThan(0.10);
    expect(moved / keys.length).toBeLessThan(0.45);

    // Each node should have some keys
    for (const [, count] of newDist) {
      expect(count).toBeGreaterThan(500); // at least 5%
    }
  });
});

describe("fnv1a32 hash", () => {
  test("same input → same output", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
  });

  test("different inputs → different hashes (likely)", () => {
    expect(fnv1a32("hello")).not.toBe(fnv1a32("world"));
  });

  test("returns uint32", () => {
    const h = fnv1a32("test");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });
});
