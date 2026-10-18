/**
 * Exact minimum-weight perfect matching on general (non-bipartite) graphs.
 *
 * This is a TypeScript port of the Galil/Edmonds primal-dual "blossom"
 * algorithm. It follows, line for line in control flow, the implementation in
 * NetworkX `networkx/algorithms/matching.py::max_weight_matching`
 * (BSD-3-Clause, (c) 2004-2025 NetworkX developers; the original
 * implementation was written by Joris van Rantwijk). The algorithm and its
 * terminology come from "Efficient Algorithms for Finding Maximum Matching in
 * Graphs", Zvi Galil, ACM Computing Surveys, 1986.
 *
 * Everything here runs on integer weights (see `assertSafeWeights`), so the
 * dual-variable arithmetic stays exact in JS numbers.
 *
 * Strategy: minimum-weight perfect matching is computed exactly like
 * NetworkX's `min_weight_matching` does it - build the inverted graph
 * `w' = (maxWeight + 1) - w` and run the max-weight routine with
 * `maxcardinality = true`. Every perfect matching is shifted by the same
 * constant `#edges * (maxWeight + 1)`, so the maximiser of `w'` is the
 * minimiser of `w`; using this (rather than literal negation) keeps the edge
 * weights positive, which is the configuration the primal-dual algorithm is
 * validated against. A returned matching whose cardinality is below
 * `vertexCount / 2` proves that no perfect matching exists.
 *
 * No greedy or bipartite shortcut is used anywhere: the answer is exact.
 */

export interface MatchingEdge {
  readonly a: number;
  readonly b: number;
  readonly weight: number;
}

/** Default wall-clock budget for one pairing solve. */
export const DEFAULT_PAIRING_BUDGET_MS = 10_000;

/**
 * Raised when a minimum-weight perfect matching cannot be produced: either the
 * graph admits no perfect matching, or the solver ran out of its time budget.
 * Callers must treat this as a blocked pairing, never fall back to a worse one.
 */
export class PairingSolverError extends Error {
  readonly code: 'BLOCKED_PAIRING' = 'BLOCKED_PAIRING';

  constructor(message: string) {
    super(message);
    this.name = 'PairingSolverError';
  }
}

/**
 * Rejects any weight that is not a non-negative safe integer. Guarantees the
 * exactness of the solver's integer dual arithmetic.
 */
export function assertSafeWeights(weights: readonly number[]): void {
  for (const weight of weights) {
    if (typeof weight !== 'number' || !Number.isSafeInteger(weight) || weight < 0) {
      throw new PairingSolverError(
        `matching weights must be non-negative safe integers, received ${String(weight)}`,
      );
    }
  }
}

export interface PerfectMatchingOptions {
  /** Wall-clock budget in milliseconds; defaults to {@link DEFAULT_PAIRING_BUDGET_MS}. */
  readonly budgetMs?: number;
  /** Clock used for budget checks (injectable for tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Sentinel distinct from every vertex index. */
const NO_NODE = -1;

/** A vertex or a (sub-)blossom. Vertices are plain numbers, blossoms objects. */
type Node = number | Blossom;

/**
 * Representation of a non-trivial blossom or sub-blossom.
 *
 * `childs` is an ordered list of the blossom's sub-blossoms, starting with the
 * base and going round the blossom.
 *
 * `edges[i] = (v, w)` where `v` is a vertex in `childs[i]` and `w` a vertex in
 * `childs[(i + 1) % childs.length]`.
 *
 * If this is a top-level S-blossom, `mybestedges` is the list of least-slack
 * edges to neighbouring S-blossoms, or `null` when it has not been computed
 * yet. Used for the efficient computation of delta3.
 */
class Blossom {
  childs: Node[] = [];
  edges: Array<[number, number]> = [];
  mybestedges: Array<[number, number]> | null = null;

  /** Base vertex of this blossom (`blossombase[b]`). */
  base = -1;
  /** Immediate parent sub-blossom, or `null` for a top-level blossom. */
  parent: Node | null = null;
  /** Dual variable z(b) of this blossom. */
  dual = 0;

  /** Yields the blossom's leaf vertices. */
  *leaves(): Generator<number> {
    const stack: Node[] = [...this.childs];
    while (stack.length > 0) {
      const top = stack.pop() as Node;
      if (typeof top === 'number') yield top;
      else stack.push(...top.childs);
    }
  }
}

/**
 * Exact minimum-weight perfect matching of the graph on vertices
 * `0..vertexCount-1` whose allowed edges are exactly `edges`.
 *
 * Returns the pairs `[a, b]` with `a < b`, each vertex covered exactly once.
 * Throws {@link PairingSolverError} when no perfect matching exists or when the
 * time budget is exhausted.
 */
export function minimumWeightPerfectMatching(
  vertexCount: number,
  edges: readonly MatchingEdge[],
  options: PerfectMatchingOptions = {},
): readonly (readonly [number, number])[] {
  if (!Number.isInteger(vertexCount) || vertexCount < 0) {
    throw new Error(`vertexCount must be a non-negative integer, received ${String(vertexCount)}`);
  }
  const n = vertexCount;
  assertSafeWeights(edges.map((edge) => edge.weight));

  const budgetMs = options.budgetMs ?? DEFAULT_PAIRING_BUDGET_MS;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + budgetMs;

  const adjacency: number[][] = [];
  for (let v = 0; v < n; v++) adjacency.push([]);
  const edgeKey = (v: number, w: number): number => (v < w ? v * n + w : w * n + v);
  const rawWeight = new Map<number, number>();
  let maxWeight = 0;
  for (const edge of edges) {
    const { a, b, weight } = edge;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n) {
      throw new Error(`edge endpoint out of range for ${n} vertices: (${String(a)}, ${String(b)})`);
    }
    if (a === b) throw new Error(`self-loop edge is not allowed: (${String(a)}, ${String(b)})`);
    const key = edgeKey(a, b);
    if (rawWeight.has(key)) {
      throw new Error(`duplicate edge: (${String(Math.min(a, b))}, ${String(Math.max(a, b))})`);
    }
    rawWeight.set(key, weight);
    adjacency[a].push(b);
    adjacency[b].push(a);
    if (weight > maxWeight) maxWeight = weight;
  }

  // Inverted graph: w' = (maxWeight + 1) - w, all strictly positive integers.
  const invertedWeight = new Map<number, number>();
  for (const [key, weight] of rawWeight) invertedWeight.set(key, maxWeight + 1 - weight);
  const weightOf = (v: number, w: number): number => invertedWeight.get(edgeKey(v, w)) as number;

  if (n % 2 !== 0) {
    throw new PairingSolverError(
      `no perfect matching exists for an odd number of vertices (${String(n)})`,
    );
  }

  const checkBudget = (): void => {
    if (now() >= deadline) {
      throw new PairingSolverError(`pairing budget of ${String(budgetMs)}ms exhausted`);
    }
  };

  const mate = blossomMaxWeightMatching(n, adjacency, weightOf, true, checkBudget);

  const pairs: Array<[number, number]> = [];
  for (let v = 0; v < n; v++) {
    const partner = mate[v];
    if (partner !== NO_NODE && partner > v) pairs.push([v, partner]);
  }
  if (pairs.length * 2 !== n) {
    throw new PairingSolverError(
      `no perfect matching exists for ${String(n)} vertices (best matching covers ${String(pairs.length * 2)})`,
    );
  }
  pairs.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return pairs;
}

/**
 * Maximum-weight matching (optionally of maximum cardinality first) on the
 * graph described by `adjacency` and `weightOf`.
 *
 * `checkpoint` is invoked while the search runs; it may throw to abort.
 * Returns `mate`, where `mate[v]` is the partner of `v`, or `-1` if unmatched.
 */
function blossomMaxWeightMatching(
  n: number,
  adjacency: readonly number[][],
  weightOf: (v: number, w: number) => number,
  maxcardinality: boolean,
  checkpoint: () => void,
): Int32Array {
  if (n === 0) return new Int32Array(0).fill(-1);

  // Maximum edge weight, used as the initial value of the vertex duals.
  let maxweight = 0;
  for (let v = 0; v < n; v++) {
    for (const w of adjacency[v]) {
      if (w !== v) {
        const weight = weightOf(v, w);
        if (weight > maxweight) maxweight = weight;
      }
    }
  }

  // If v is a matched vertex, mate[v] is its partner vertex; -1 if single.
  const mate = new Int32Array(n).fill(-1);

  // If b is a top-level blossom, label of b is absent if unlabeled, 1 if an
  // S-blossom, 2 if a T-blossom. Vertices inside a T-blossom carry label 2 iff
  // they are reachable from an S-vertex outside the blossom.
  const label = new Map<Node, number>();

  // If b is a labeled top-level blossom, labeledge[b] = (v, w) is the edge
  // through which b obtained its label, with w a vertex in b; null if b's base
  // vertex is single.
  const labeledge = new Map<Node, readonly [number, number] | null>();

  // inblossom[v] is the top-level blossom containing vertex v.
  const inblossom: Node[] = [];
  for (let v = 0; v < n; v++) inblossom.push(v);

  // Immediate parent (sub-)blossom of each vertex / blossom.
  const vertexParent: Array<Node | null> = new Array<Node | null>(n).fill(null);

  // bestedge[w] is the least-slack edge (v, w) from an S-vertex reaching a free
  // vertex or an unreached vertex in a T-blossom; for a top-level S-blossom b,
  // bestedge[b] is the least-slack edge to a different S-blossom.
  const bestedge = new Map<Node, readonly [number, number] | null>();

  // dualvar[v] = 2 * u(v): both duals and slacks are pre-multiplied by two so
  // that integer weights keep the whole computation integral.
  const dualvar = new Float64Array(n).fill(maxweight);

  // Active non-trivial blossoms and their dual variables z(b).
  const blossomdual = new Set<Blossom>();

  // allowedge holds the edges known to have zero slack.
  const allowedge = new Set<number>();

  // Queue of newly discovered S-vertices.
  const queue: number[] = [];

  const labelOf = (node: Node): number | null => {
    const value = label.get(node);
    return value === undefined ? null : value;
  };
  const labelEdgeOf = (node: Node): readonly [number, number] | null => {
    const value = labeledge.get(node);
    return value === undefined ? null : value;
  };
  const bestEdgeOf = (node: Node): readonly [number, number] | null => {
    const value = bestedge.get(node);
    return value === undefined ? null : value;
  };
  const baseOf = (node: Node): number => (typeof node === 'number' ? node : node.base);
  const parentOf = (node: Node): Node | null =>
    typeof node === 'number' ? vertexParent[node] : node.parent;
  const setParent = (node: Node, parent: Node | null): void => {
    if (typeof node === 'number') vertexParent[node] = parent;
    else node.parent = parent;
  };

  // 2 * slack of edge (v, w); only meaningful outside blossoms.
  const slack = (v: number, w: number): number => dualvar[v] + dualvar[w] - 2 * weightOf(v, w);

  // Python indexes lists with negative indices while walking a blossom; JS
  // arrays need the wrap spelled out.
  const wrapIndex = (index: number, length: number): number =>
    index < 0 ? index + length : index;

  const allowEdge = (v: number, w: number): void => {
    allowedge.add(v * n + w);
    allowedge.add(w * n + v);
  };
  const isAllowed = (v: number, w: number): boolean => allowedge.has(v * n + w);

  // Assign label t to the top-level blossom containing vertex w, reached
  // through an edge from vertex v.
  const assignLabel = (w: number, t: number, v: number | null): void => {
    const b = inblossom[w];
    label.set(w, t);
    label.set(b, t);
    if (v !== null) {
      const edge: [number, number] = [v, w];
      labeledge.set(w, edge);
      labeledge.set(b, edge);
    } else {
      labeledge.set(w, null);
      labeledge.set(b, null);
    }
    bestedge.set(w, null);
    bestedge.set(b, null);
    if (t === 1) {
      // b became an S-vertex/blossom; add it (its vertices) to the queue.
      if (typeof b === 'number') queue.push(b);
      else for (const leaf of b.leaves()) queue.push(leaf);
    } else if (t === 2) {
      // b became a T-vertex/blossom; label its mate S (R12).
      const base = baseOf(b);
      assignLabel(mate[base], 1, base);
    }
  };

  // Trace back from v and w to discover either a new blossom or an augmenting
  // path. Returns the base vertex of a new blossom, or NO_NODE for an
  // augmenting path.
  const scanBlossom = (vStart: number, wStart: number): number => {
    const path: Node[] = [];
    let base = NO_NODE;
    let v = vStart;
    let w = wStart;
    while (v !== NO_NODE) {
      // Look for a breadcrumb in v's blossom, or place a new breadcrumb.
      const b = inblossom[v];
      const bLabel = labelOf(b);
      if (bLabel !== null && (bLabel & 4) !== 0) {
        base = baseOf(b);
        break;
      }
      path.push(b);
      label.set(b, 5);
      // Trace one step back.
      const edge = labelEdgeOf(b);
      if (edge === null) {
        // The base of blossom b is single; stop tracing this path.
        v = NO_NODE;
      } else {
        v = edge[0];
        // b is a T-blossom; trace one more step back.
        v = labelEdgeOf(inblossom[v])![0];
      }
      // Swap v and w so that we alternate between both paths.
      if (w !== NO_NODE) {
        const swap = v;
        v = w;
        w = swap;
      }
    }
    // Remove breadcrumbs.
    for (const b of path) label.set(b, 1);
    return base;
  };

  // Construct a new blossom with the given base through S-vertices v and w.
  const addBlossom = (base: number, vStart: number, wStart: number): void => {
    const bb = inblossom[base];
    let bv = inblossom[vStart];
    let bw = inblossom[wStart];
    const b = new Blossom();
    b.base = base;
    setParent(b, null);
    setParent(bb, b);
    // List of sub-blossoms and their interconnecting edge endpoints.
    const path: Node[] = [];
    const edgs: Array<[number, number]> = [[vStart, wStart]];
    b.childs = path;
    b.edges = edgs;
    // Trace back from v to base.
    let v = vStart;
    let w = wStart;
    while (bv !== bb) {
      setParent(bv, b);
      path.push(bv);
      const edge = labelEdgeOf(bv)!;
      edgs.push([edge[0], edge[1]]);
      v = edge[0];
      bv = inblossom[v];
    }
    // Add the base sub-blossom, then reverse the lists.
    path.push(bb);
    path.reverse();
    edgs.reverse();
    // Trace back from w to base.
    while (bw !== bb) {
      setParent(bw, b);
      path.push(bw);
      const edge = labelEdgeOf(bw)!;
      edgs.push([edge[1], edge[0]]);
      w = edge[0];
      bw = inblossom[w];
    }
    // Label the new blossom S and give it dual variable zero.
    label.set(b, 1);
    labeledge.set(b, labelEdgeOf(bb));
    b.dual = 0;
    blossomdual.add(b);
    // Relabel vertices.
    for (const leaf of b.leaves()) {
      if (labelOf(inblossom[leaf]) === 2) {
        // This T-vertex becomes an S-vertex inside an S-blossom; queue it.
        queue.push(leaf);
      }
      inblossom[leaf] = b;
    }
    // Compute b.mybestedges.
    const bestedgeto = new Map<Node, [number, number]>();
    for (const child of path) {
      let nblist: Array<[number, number]>;
      if (typeof child === 'number') {
        nblist = adjacency[child]
          .filter((other) => other !== child)
          .map((other) => [child, other] as [number, number]);
      } else if (child.mybestedges !== null) {
        // Walk this sub-blossom's least-slack edges; it will not need them again.
        nblist = child.mybestedges;
        child.mybestedges = null;
      } else {
        // No list of least-slack edges; collect them from the vertices.
        nblist = [];
        for (const leaf of child.leaves()) {
          for (const other of adjacency[leaf]) {
            if (leaf !== other) nblist.push([leaf, other]);
          }
        }
      }
      for (const k of nblist) {
        let [i, j] = k;
        if (inblossom[j] === b) {
          const swap = i;
          i = j;
          j = swap;
        }
        const bj = inblossom[j];
        if (bj !== b && labelOf(bj) === 1) {
          const current = bestedgeto.get(bj);
          if (current === undefined || slack(i, j) < slack(current[0], current[1])) {
            bestedgeto.set(bj, k);
          }
        }
      }
      // Forget about the least-slack edge of the sub-blossom.
      bestedge.set(child, null);
    }
    b.mybestedges = [...bestedgeto.values()];
    // Select bestedge[b].
    let mybestedge: readonly [number, number] | null = null;
    let mybestslack = 0;
    for (const k of b.mybestedges) {
      const kslack = slack(k[0], k[1]);
      if (mybestedge === null || kslack < mybestslack) {
        mybestedge = k;
        mybestslack = kslack;
      }
    }
    bestedge.set(b, mybestedge);
  };

  // Expand the given top-level blossom.
  const expandBlossom = (bStart: Blossom, endstage: boolean): void => {
    // Trampoline: the recursion is expressed with a generator and an explicit
    // stack so the call stack stays flat, exactly as in the reference.
    function* recurse(b: Blossom): Generator<Blossom> {
      // Convert sub-blossoms into top-level blossoms.
      for (const s of b.childs) {
        setParent(s, null);
        if (typeof s === 'number') {
          inblossom[s] = s;
        } else if (endstage && s.dual === 0) {
          // Recursively expand this sub-blossom.
          yield s;
        } else {
          for (const leaf of s.leaves()) inblossom[leaf] = s;
        }
      }
      // If a T-blossom is expanded during a stage, its sub-blossoms must be
      // relabeled.
      if (!endstage && labelOf(b) === 2) {
        // Start at the sub-blossom through which the expanding blossom got its
        // label, and relabel sub-blossoms until we reach the base.
        const entrychild = inblossom[labelEdgeOf(b)![1]];
        // Decide in which direction we will go round the blossom.
        let j = b.childs.indexOf(entrychild);
        let jstep: number;
        if ((j & 1) !== 0) {
          // Start index is odd; go forward and wrap.
          j -= b.childs.length;
          jstep = 1;
        } else {
          // Start index is even; go backward.
          jstep = -1;
        }
        let [v, w] = labelEdgeOf(b)!;
        while (j !== 0) {
          // Relabel the T-sub-blossom.
          let p: number;
          let q: number;
          if (jstep === 1) {
            [p, q] = b.edges[wrapIndex(j, b.edges.length)];
          } else {
            [q, p] = b.edges[j - 1];
          }
          label.delete(w);
          label.delete(q);
          assignLabel(w, 2, v);
          // Step to the next S-sub-blossom and note its forward edge.
          allowEdge(p, q);
          j += jstep;
          if (jstep === 1) {
            [v, w] = b.edges[wrapIndex(j, b.edges.length)];
          } else {
            [w, v] = b.edges[j - 1];
          }
          // Step to the next T-sub-blossom.
          allowEdge(v, w);
          j += jstep;
        }
        // Relabel the base T-sub-blossom without stepping through to its mate
        // (so assignLabel is not called).
        const bw = b.childs[j];
        label.set(w, 2);
        label.set(bw, 2);
        const baseEdge: [number, number] = [v, w];
        labeledge.set(w, baseEdge);
        labeledge.set(bw, baseEdge);
        bestedge.set(bw, null);
        // Continue along the blossom until we get back to entrychild.
        j += jstep;
        while (b.childs[wrapIndex(j, b.childs.length)] !== entrychild) {
          // Does this sub-blossom contain a vertex reachable from a
          // neighbouring S-vertex outside the expanding blossom?
          const child = b.childs[wrapIndex(j, b.childs.length)];
          if (labelOf(child) === 1) {
            // This sub-blossom already got label S; leave it be.
            j += jstep;
            continue;
          }
          let reachable: number | null = null;
          if (typeof child === 'number') {
            reachable = child;
          } else {
            for (const leaf of child.leaves()) {
              if ((labelOf(leaf) ?? 0) !== 0) {
                reachable = leaf;
                break;
              }
            }
          }
          // If the sub-blossom contains a reachable vertex, label it T.
          if (reachable !== null && (labelOf(reachable) ?? 0) !== 0) {
            label.delete(reachable);
            label.delete(mate[baseOf(child)]);
            assignLabel(reachable, 2, labelEdgeOf(reachable)![0]);
          }
          j += jstep;
        }
      }
      // Remove the expanded blossom entirely.
      label.delete(b);
      labeledge.delete(b);
      bestedge.delete(b);
      blossomdual.delete(b);
    }

    const stack: Array<Generator<Blossom>> = [recurse(bStart)];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const next = top.next();
      if (next.done === true) stack.pop();
      else stack.push(recurse(next.value));
    }
  };

  // Swap matched/unmatched edges over an alternating path through blossom b
  // between vertex v and the base vertex, keeping the bookkeeping consistent.
  const augmentBlossom = (bStart: Blossom, vStart: number): void => {
    function* recurse(b: Blossom, v: number): Generator<[Blossom, number]> {
      // Bubble up through the blossom tree from v to an immediate sub-blossom.
      let t = v as Node;
      while (parentOf(t) !== b) t = parentOf(t) as Node;
      // Deal with the first sub-blossom.
      if (typeof t !== 'number') yield [t, v];
      // Decide in which direction we will go round the blossom.
      const i = b.childs.indexOf(t);
      let j = i;
      let jstep: number;
      if ((i & 1) !== 0) {
        // Start index is odd; go forward and wrap.
        j -= b.childs.length;
        jstep = 1;
      } else {
        // Start index is even; go backward.
        jstep = -1;
      }
      // Move along the blossom until we get to the base.
      while (j !== 0) {
        // Step to the next sub-blossom and augment it recursively.
        j += jstep;
        t = b.childs[wrapIndex(j, b.childs.length)];
        let w: number;
        let x: number;
        if (jstep === 1) {
          [w, x] = b.edges[wrapIndex(j, b.edges.length)];
        } else {
          [x, w] = b.edges[j - 1];
        }
        if (typeof t !== 'number') yield [t, w];
        // Step to the next sub-blossom and augment it recursively.
        j += jstep;
        t = b.childs[wrapIndex(j, b.childs.length)];
        if (typeof t !== 'number') yield [t, x];
        // Match the edge connecting those sub-blossoms.
        mate[w] = x;
        mate[x] = w;
      }
      // Rotate the list of sub-blossoms to put the new base at the front.
      b.childs = b.childs.slice(i).concat(b.childs.slice(0, i));
      b.edges = b.edges.slice(i).concat(b.edges.slice(0, i));
      b.base = baseOf(b.childs[0]);
    }

    const stack: Array<Generator<[Blossom, number]>> = [recurse(bStart, vStart)];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const next = top.next();
      if (next.done === true) stack.pop();
      else stack.push(recurse(next.value[0], next.value[1]));
    }
  };

  // Swap matched/unmatched edges over an alternating path between two single
  // vertices. The augmenting path runs through S-vertices v and w.
  const augmentMatching = (v: number, w: number): void => {
    const endpoints: Array<[number, number]> = [
      [v, w],
      [w, v],
    ];
    for (const [sStart, jStart] of endpoints) {
      let s = sStart;
      let j = jStart;
      // Match s to j, then trace back from s until a single vertex is found,
      // swapping matched and unmatched edges on the way.
      for (;;) {
        const bs = inblossom[s];
        // Augment through the S-blossom from s to its base.
        if (typeof bs !== 'number') augmentBlossom(bs, s);
        mate[s] = j;
        // Trace one step back.
        const edge = labelEdgeOf(bs);
        if (edge === null) break; // reached a single vertex
        const t = edge[0];
        const bt = inblossom[t];
        // Trace one more step back.
        const btEdge = labelEdgeOf(bt)!;
        s = btEdge[0];
        j = btEdge[1];
        // Augment through the T-blossom from j to its base.
        if (typeof bt !== 'number') augmentBlossom(bt, j);
        mate[j] = s;
      }
    }
  };

  // Main loop: each iteration is a "stage" that finds an augmenting path.
  for (;;) {
    checkpoint();
    // Remove labels from top-level blossoms/vertices.
    label.clear();
    labeledge.clear();
    // Forget all about least-slack edges.
    bestedge.clear();
    for (const b of blossomdual) b.mybestedges = null;
    // Labeling loss means currently allowable edges cannot be trusted.
    allowedge.clear();
    queue.length = 0;

    // Label single blossoms/vertices S and queue them.
    for (let v = 0; v < n; v++) {
      if (mate[v] === NO_NODE && labelOf(inblossom[v]) === null) assignLabel(v, 1, null);
    }

    let augmented = false;
    // Each iteration is a "substage": it either finds an augmenting path or
    // pumps some slack out of the dual variables.
    for (;;) {
      checkpoint();
      // Continue labeling until all reachable vertices are labeled.
      while (queue.length > 0 && !augmented) {
        checkpoint();
        const v = queue.pop() as number;
        // Scan the neighbours of v.
        for (const w of adjacency[v]) {
          if (w === v) continue; // self-loops are ignored
          const bv = inblossom[v];
          const bw = inblossom[w];
          if (bv === bw) continue; // internal to a blossom
          let kslack = 0;
          if (!isAllowed(v, w)) {
            kslack = slack(v, w);
            // Zero slack means the edge is allowable.
            if (kslack <= 0) allowEdge(v, w);
          }
          if (isAllowed(v, w)) {
            const bwLabel = labelOf(bw);
            if (bwLabel === null) {
              // (C1) w is a free vertex: label w T, its mate S (R12).
              assignLabel(w, 2, v);
            } else if (bwLabel === 1) {
              // (C2) w is an S-vertex: follow back-links to find either an
              // augmenting path or a new blossom.
              const base = scanBlossom(v, w);
              if (base !== NO_NODE) {
                addBlossom(base, v, w);
              } else {
                augmentMatching(v, w);
                augmented = true;
                break;
              }
            } else if (labelOf(w) === null) {
              // w is inside a T-blossom but not yet reached from outside.
              label.set(w, 2);
              labeledge.set(w, [v, w]);
            }
          } else if (labelOf(bw) === 1) {
            // Keep the least-slack non-allowable edge to another S-blossom.
            const best = bestEdgeOf(bv);
            if (best === null || kslack < slack(best[0], best[1])) bestedge.set(bv, [v, w]);
          } else if (labelOf(w) === null) {
            // w is a free vertex (or an unreached vertex in a T-blossom) that
            // cannot be reached yet; keep the least-slack edge reaching it.
            const best = bestEdgeOf(w);
            if (best === null || kslack < slack(best[0], best[1])) bestedge.set(w, [v, w]);
          }
        }
      }

      if (augmented) break;

      // No augmenting path under these constraints: compute delta and reduce
      // slack in the optimization problem.
      let deltatype = -1;
      let delta = 0;
      let deltaedge: readonly [number, number] | null = null;
      let deltablossom: Blossom | null = null;

      // delta1: the minimum value of any vertex dual.
      if (!maxcardinality) {
        deltatype = 1;
        delta = Infinity;
        for (let v = 0; v < n; v++) if (dualvar[v] < delta) delta = dualvar[v];
      }

      // delta2: the minimum slack on any edge between an S-vertex and a free
      // vertex.
      for (let v = 0; v < n; v++) {
        if (labelOf(inblossom[v]) !== null) continue;
        const best = bestEdgeOf(v);
        if (best === null) continue;
        const d = slack(best[0], best[1]);
        if (deltatype === -1 || d < delta) {
          delta = d;
          deltatype = 2;
          deltaedge = best;
        }
      }

      // delta3: half the minimum slack on any edge between two S-blossoms.
      for (let v = 0; v < n; v++) {
        if (parentOf(v) !== null || labelOf(v) !== 1) continue;
        const best = bestEdgeOf(v);
        if (best === null) continue;
        // Weights are integers, so this slack is even; division is exact.
        const d = slack(best[0], best[1]) / 2;
        if (deltatype === -1 || d < delta) {
          delta = d;
          deltatype = 3;
          deltaedge = best;
        }
      }
      for (const b of blossomdual) {
        if (parentOf(b) !== null || labelOf(b) !== 1) continue;
        const best = bestEdgeOf(b);
        if (best === null) continue;
        const d = slack(best[0], best[1]) / 2;
        if (deltatype === -1 || d < delta) {
          delta = d;
          deltatype = 3;
          deltaedge = best;
        }
      }

      // delta4: minimum z variable of any T-blossom.
      for (const b of blossomdual) {
        if (parentOf(b) !== null || labelOf(b) !== 2) continue;
        if (deltatype === -1 || b.dual < delta) {
          delta = b.dual;
          deltatype = 4;
          deltablossom = b;
        }
      }

      if (deltatype === -1) {
        // No further improvement possible: max-cardinality optimum reached.
        // Do a final delta update so the optimum is verifiable.
        if (!maxcardinality) throw new Error('matching: internal delta search failed');
        deltatype = 1;
        delta = 0;
        for (let v = 0; v < n; v++) if (dualvar[v] < delta) delta = dualvar[v];
        delta = Math.max(0, delta);
      }

      // Update dual variables according to delta.
      for (let v = 0; v < n; v++) {
        const lb = labelOf(inblossom[v]);
        if (lb === 1) dualvar[v] -= delta; // S-vertex: 2u = 2u - 2delta
        else if (lb === 2) dualvar[v] += delta; // T-vertex: 2u = 2u + 2delta
      }
      for (const b of blossomdual) {
        if (parentOf(b) !== null) continue;
        if (labelOf(b) === 1) b.dual += delta; // top-level S-blossom
        else if (labelOf(b) === 2) b.dual -= delta; // top-level T-blossom
      }

      // Take action at the point where the minimum delta occurred.
      if (deltatype === 1) {
        // No further improvement possible; optimum reached.
        break;
      } else if (deltatype === 2 || deltatype === 3) {
        // Use the least-slack edge to continue the search.
        const edge = deltaedge as readonly [number, number];
        allowEdge(edge[0], edge[1]);
        queue.push(edge[0]);
      } else {
        // deltatype === 4: expand the least-z blossom.
        expandBlossom(deltablossom as Blossom, false);
      }
    }

    // Stop when no more augmenting path can be found.
    if (!augmented) break;

    // End of a stage: expand all S-blossoms which have dual zero.
    for (const b of [...blossomdual]) {
      if (!blossomdual.has(b)) continue; // already expanded
      if (parentOf(b) === null && labelOf(b) === 1 && b.dual === 0) expandBlossom(b, true);
    }
  }

  return mate;
}
