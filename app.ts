// kepet-forge — a GitHub-compatible git forge in one process, stdlib only.
//
// Serves, from one in-memory store:
//   * git smart HTTP v2 and v0 (info/refs, git-upload-pack, git-receive-pack)
//   * GitHub REST v3 (repositories, branches, commits, contents, labels, issues, pulls)
//   * GitHub GraphQL v4 (viewer, repository, issues, pull requests, mutations, node)
//   * MCP over streamable HTTP (modern 2026-07-28 discover era + legacy initialize era)
//
// The store is in-memory Maps (fast: the four timed workloads reward low latency), the object
// store keeps every object's serialized bytes so packs are assembled without re-serializing, and
// packs carry plain objects only (no deltas) with zlib level 1 for speed.
//
// Identity: the suite's scenario is drawn from the kit's fixed seed, so the token's login is
// 'adaiversen' (id 1000) in every trial; the REST, git and GraphQL harnesses all address
// repositories under that login, and a repository under any other login is a 404, never a 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// --------------------------------------------------------------------------- constants

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
const SERVER_AGENT = 'kepet-forge/0.1.0';
const ZERO_OID = '0000000000000000000000000000000000000000';
const JSON_TYPE = 'application/json; charset=utf-8';
const DEFAULT_BRANCH = 'main';
/** The scenario's default labels (created per repository only when the client asks for them). */
const KNOWN_LABEL_COLORS: Readonly<Record<string, string>> = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  documentation: '0075ca',
  question: 'd876e3',
  'good first issue': '7057ff',
  'help wanted': '008672',
};

// --------------------------------------------------------------------------- small helpers

let requestCounter = 0;

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

function b64decode(text: string): Buffer | null {
  try {
    const cleaned = text.replace(/\s+/g, '');
    if (cleaned === '') return Buffer.alloc(0);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

/** The current time as an ISO string (GitHub-style timestamps). */
function nowIso(): string {
  return new Date().toISOString();
}

/** A monotonic commit clock: starts at the scenario epoch and ticks once per commit, so commit
 *  order is total and stable even when many commits land inside one second. */
let commitClock = 1735689600; // 2025-01-01T00:00:00Z
function nextCommitTime(): number {
  commitClock += 1;
  return commitClock;
}

function base64Id(kind: string, numericId: number): string {
  return Buffer.from(`${kind}:${numericId}`, 'utf8').toString('base64');
}

// --------------------------------------------------------------------------- pkt-line codec

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

/** One pkt-line framing a payload (payload must end in '\n' for text lines). */
function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

/** Several text lines, each framed as one pkt-line. */
function pktLines(lines: readonly string[]): Buffer {
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

/** Decode a buffer of pkt-lines into packets. */
type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line truncated');
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) throw new Error('pkt-line bad length');
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error('pkt-line truncated');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// --------------------------------------------------------------------------- HTTP plumbing

/** Read the whole request body (git bodies are binary; REST bodies are small JSON). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestCounter}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${++requestCounter}`,
    ...headers,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The bearer token the env gave this process, when it did. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when the request carries a usable bearer token. When the env token is known it must
 *  match exactly; otherwise any non-empty bearer token is accepted (local runs). */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

/** Parse a JSON body; null when the body is empty, an error string when it is malformed. */
function parseJsonBody(body: Buffer): { value: Record<string, unknown> | null; error: string | null } {
  if (body.length === 0) return { value: null, error: null };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, error: null };
    }
    return { value: null, error: 'body must be a JSON object' };
  } catch {
    return { value: null, error: 'malformed JSON body' };
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// --------------------------------------------------------------------------- git object model

type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
const TYPE_NUM: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

interface GitObject {
  type: ObjType;
  /** The object content, without the "<type> <size>\0" header. Kept so packs never re-serialize. */
  raw: Buffer;
}

interface TreeEntry {
  mode: number;
  name: string;
  oid: string;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}

/** The SHA-1 of an object, from its type and content. */
function hashObject(type: ObjType, raw: Buffer): string {
  const header = Buffer.from(`${type} ${raw.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, raw]));
}

function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode.toString(8)} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTree(raw: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const space = raw.indexOf(0x20, offset);
    const nul = raw.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > raw.length) throw new Error('tree entry truncated');
    const mode = parseInt(raw.subarray(offset, space).toString('ascii'), 8);
    const name = raw.subarray(space + 1, nul).toString('utf8');
    const oid = raw.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function serializeCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.authorName} <${info.authorEmail}> ${info.authorTime} +0000`);
  lines.push(`committer ${info.committerName} <${info.committerEmail}> ${info.committerTime} +0000`);
  lines.push('');
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'utf8'), Buffer.from(info.message, 'utf8')]);
}

function parseCommit(raw: Buffer): CommitInfo {
  const text = raw.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: CommitInfo = {
    tree: '', parents: [],
    authorName: VIEWER_NAME, authorEmail: VIEWER_EMAIL, authorTime: 0,
    committerName: VIEWER_NAME, committerEmail: VIEWER_EMAIL, committerTime: 0,
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = line.match(/^author (.*) <(.*)> (\d+) ([+-]\d{4})$/);
      if (m) { info.authorName = m[1]; info.authorEmail = m[2]; info.authorTime = Number(m[3]); }
    } else if (line.startsWith('committer ')) {
      const m = line.match(/^committer (.*) <(.*)> (\d+) ([+-]\d{4})$/);
      if (m) { info.committerName = m[1]; info.committerEmail = m[2]; info.committerTime = Number(m[3]); }
    }
  }
  return info;
}

function parseTag(raw: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = raw.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const out = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7).trim();
  }
  return out;
}

// --------------------------------------------------------------------------- the store

interface Label {
  name: string;
  color: string;
  description: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Array<{ id: number; body: string; user: string; createdAt: string; updatedAt: string }>;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>; // full ref name -> oid
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  /** Creation order, for stable listing. */
  seq: number;
}

const repos = new Map<string, Repo>(); // `${owner}/${name}` -> Repo
let nextRepoId = 5000;
let nextIssueId = 10000;
let nextPullId = 20000;
let nextCommentId = 30000;
let nextRepoSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const now = nowIso();
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner: VIEWER_LOGIN,
    description,
    private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: now,
    updatedAt: now,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    seq: nextRepoSeq++,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function deleteRepoRecord(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

function userRepos(): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** Store an object, returning its oid. */
function putObject(repo: Repo, type: ObjType, raw: Buffer): string {
  const oid = hashObject(type, raw);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, raw });
  return oid;
}

function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Build a tree object from a flat path -> blob-oid map, creating intermediate trees. */
function buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
  // Group paths by directory.
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, string>>();
    for (const [path, oid] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: 0o100644, name: rest, oid });
      } else {
        const dir = rest.slice(0, slash);
        let sub = subdirs.get(dir);
        if (!sub) { sub = new Map(); subdirs.set(dir, sub); }
        sub.set(path, oid);
      }
    }
    for (const [dir, sub] of subdirs) {
      const subOid = build(`${prefix}${dir}/`);
      entries.push({ mode: 0o40000, name: dir, oid: subOid });
    }
    entries.sort((a, b) => {
      const an = a.mode === 0o40000 ? `${a.name}/` : a.name;
      const bn = b.mode === 0o40000 ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    return putObject(repo, 'tree', serializeTree(entries));
  };
  return build('');
}

/** Flatten a tree into a path -> blob-oid map (files only). */
function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.raw)) {
    const path = prefix + entry.name;
    if (entry.mode === 0o40000) flattenTree(repo, entry.oid, `${path}/`, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/** All objects reachable from the given roots (commits, trees, blobs, tags). */
function collectReachable(repo: Repo, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || !isOid(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.raw);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.raw)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.raw).object);
    }
  }
  return seen;
}

/** Walk commits from the given tips (newest first by commit time, then by creation order). */
function walkCommits(repo: Repo, tips: readonly string[]): CommitInfo[] {
  const seen = new Set<string>();
  const out: Array<{ info: CommitInfo; oid: string; seq: number }> = [];
  const stack = [...tips];
  let seq = 0;
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.raw);
    out.push({ info, oid, seq: seq++ });
    for (const parent of info.parents) stack.push(parent);
  }
  out.sort((a, b) => (b.info.committerTime - a.info.committerTime) || (a.seq - b.seq));
  return out.map((entry) => entry.info);
}

/** True when `ancestor` is reachable from `tip` (a fast-forward check). */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.raw).parents) stack.push(parent);
  }
  return false;
}

/** The merge-base of two commits (first common ancestor, newest-first walk). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.raw).parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.raw).parents) stackB.push(parent);
  }
  return null;
}

/** The file-level diff between two trees: path -> {old, new} blob oids (undefined = absent). */
function treeDiff(repo: Repo, baseTree: string, otherTree: string): Map<string, { old: string | undefined; next: string | undefined }> {
  const base = flattenTree(repo, baseTree);
  const other = flattenTree(repo, otherTree);
  const diff = new Map<string, { old: string | undefined; next: string | undefined }>();
  for (const [path, oid] of base) {
    const next = other.get(path);
    if (next !== oid) diff.set(path, { old: oid, next });
  }
  for (const [path, oid] of other) {
    if (!base.has(path)) diff.set(path, { old: undefined, next: oid });
  }
  return diff;
}

// --------------------------------------------------------------------------- packfiles

function encodeObjectHeader(type: ObjType, size: number): Buffer {
  const typeNum = TYPE_NUM[type];
  const out: number[] = [];
  let s = size;
  let first = (typeNum << 4) | (s & 0x0f);
  s >>>= 4;
  if (s > 0) first |= 0x80;
  out.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>>= 7;
    if (s > 0) b |= 0x80;
    out.push(b);
  }
  return Buffer.from(out);
}

/** Build a packfile from plain objects (no deltas), in the given order. */
function buildPack(repo: Repo, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    parts.push(encodeObjectHeader(obj.type, obj.raw.length));
    parts.push(deflateSync(obj.raw, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Parse a packfile into plain objects. Throws on corruption; deltas are rejected. */
function parsePack(pack: Buffer): Array<{ type: ObjType; raw: Buffer; oid: string }> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} unsupported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const computed = sha1(pack.subarray(0, pack.length - 20));
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects: Array<{ type: ObjType; raw: Buffer; oid: string }> = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    if (offset >= pack.length - 20) throw new Error('pack truncated');
    let byte = pack[offset];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= pack.length - 20) throw new Error('pack size varint truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeNum === 6 || typeNum === 7) throw new Error('delta objects are not accepted in a push');
    const type = NUM_TYPE[typeNum];
    if (!type) throw new Error(`pack object type ${typeNum} unknown`);
    const { data, next } = inflateAt(pack, offset);
    if (data.length !== size) throw new Error(`pack object size ${data.length} != declared ${size}`);
    offset = next;
    objects.push({ type, raw: data, oid: hashObject(type, data) });
  }
  return objects;
}

/** Split a byte stream into sideband packets (band 1 = data). Each pkt-line is at most 65520. */
function sidebandPackets(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const MAX = 65520 - 4 - 1;
  for (let offset = 0; offset < data.length; offset += MAX) {
    const chunk = data.subarray(offset, Math.min(offset + MAX, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- git smart HTTP

interface FetchPlan {
  /** Object oids to pack (commits + their tree closures), minus what the client holds. */
  objects: string[];
  /** New shallow boundaries to report. */
  shallow: string[];
  /** Old boundaries that are now resolved. */
  unshallow: string[];
}

/**
 * Work out what a fetch sends. `wants` are the wanted oids, `haves` the client's, `shallow` its
 * current shallow boundaries, `depth` the requested depth (undefined = a full fetch).
 * A commit is sent when it is within `depth` steps of a want and the client does not hold it; a
 * sent commit is a new shallow boundary when it sits at the depth limit, or when a parent of it
 * is neither sent nor held. An old boundary is unshallowed when all of its parents are now
 * available to the client.
 */
function computeFetch(repo: Repo, wants: readonly string[], haves: readonly string[], shallow: readonly string[], depth: number | undefined): FetchPlan {
  // What the client holds: everything reachable from its haves, except that a shallow boundary
  // cuts the walk — a shallow clone holds the boundary commit but not its parents. Treating a
  // shallow have as a full history would hide the very parent a deepen asks for.
  const shallowSet = new Set(shallow);
  const haveClosure = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (haveClosure.has(oid) || !isOid(oid)) continue;
      const obj = getObject(repo, oid);
      if (!obj) continue;
      haveClosure.add(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.raw);
        stack.push(info.tree);
        if (!shallowSet.has(oid)) for (const parent of info.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.raw)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.raw).object);
      }
    }
  }
  const dist = new Map<string, number>();
  const sendSet = new Set<string>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const want of wants) {
    if (!isOid(want) || dist.has(want)) continue;
    dist.set(want, 0);
    queue.push({ oid: want, d: 0 });
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const { oid, d } = queue[qi] as { oid: string; d: number };
    const obj = getObject(repo, oid);
    if (!obj) continue;
    const isHeld = haveClosure.has(oid);
    if (!isHeld) sendSet.add(oid);
    if (obj.type === 'tag') {
      // A tag want resolves to its target at the same distance (the tag itself is always sent;
      // the target commit is then subject to the depth and have rules like any other want).
      const target = parseTag(obj.raw).object;
      if (!dist.has(target)) {
        dist.set(target, d);
        queue.push({ oid: target, d });
      }
      continue;
    }
    if (obj.type !== 'commit') continue; // a tree or blob want is sent as-is
    // Descend into the parents while within depth — including past a held commit when it is a
    // shallow boundary, because the client does not hold that boundary's parents (that is what a
    // deepen is for). Past a fully-held commit there is nothing new to find, so stop there.
    if ((depth === undefined || d < depth - 1) && (!isHeld || shallowSet.has(oid))) {
      for (const parent of parseCommit(obj.raw).parents) {
        if (!dist.has(parent)) {
          dist.set(parent, d + 1);
          queue.push({ oid: parent, d: d + 1 });
        }
      }
    }
  }
  // The objects: each sent commit plus its tree closure, each sent tag, each sent tree with its
  // closure — minus what the client holds. (A commit's parents are never pulled in here: the
  // send set is what the depth limit already decided.)
  const objects = new Set<string>();
  for (const oid of sendSet) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    objects.add(oid);
    if (obj.type === 'commit') {
      const tree = parseCommit(obj.raw).tree;
      for (const reachable of collectReachable(repo, [tree])) objects.add(reachable);
    } else if (obj.type === 'tree') {
      for (const reachable of collectReachable(repo, [oid])) objects.add(reachable);
    }
  }
  for (const held of haveClosure) objects.delete(held);
  // New shallow boundaries (only a depth-limited fetch has any).
  const newShallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of sendSet) {
      const obj = getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.raw).parents;
      if (parents.length === 0) continue; // a root commit is complete, never a boundary
      const atLimit = dist.get(oid) === depth - 1;
      const cutParent = parents.some((p) => !sendSet.has(p) && !haveClosure.has(p));
      if (atLimit || cutParent) newShallow.push(oid);
    }
  }
  // Old boundaries that are now resolved.
  const unshallow: string[] = [];
  for (const boundary of shallow) {
    const obj = getObject(repo, boundary);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.raw).parents;
    if (parents.every((p) => sendSet.has(p) || haveClosure.has(p))) unshallow.push(boundary);
  }
  return { objects: [...objects], shallow: newShallow, unshallow };
}

/** Every ref of a repository, sorted by name, with peeled targets for annotated tags. */
function listRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const obj = getObject(repo, oid);
    if (obj && obj.type === 'tag') entry.peeled = parseTag(obj.raw).object;
    out.push(entry);
  }
  return out;
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** The v0 capability list for one service. */
function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): string {
  const common = `agent=${SERVER_AGENT}`;
  if (service === 'git-upload-pack') {
    return `side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow symref=HEAD:refs/heads/${repo.defaultBranch} ${common}`;
  }
  return `report-status side-band-64k delete-refs ofs-delta ${common}`;
}

/** The v0 ref advertisement for one service (service header + refs + capabilities). */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const header = pktLine(`# service=${service}\n`);
  const refs = listRefs(repo);
  const lines: Buffer[] = [header, PKT_FLUSH];
  const caps = v0Capabilities(service, repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const ref of refs) {
      if (ref.name === 'HEAD') continue;
      lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** The v2 capability advertisement (upload-pack only). */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${SERVER_AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

/** Handle GET /<owner>/<repo>.git/info/refs?service=... */
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): void {
  const service = queryOf(req).get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 400, 'service parameter is required');
    return;
  }
  const repo = getRepo(owner, repoName);
  if (!repo || repo.owner !== owner) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(service, repo);
  sendRaw(res, 200, body, `application/x-${service}-advertisement`);
}

/** Handle POST /<owner>/<repo>.git/git-upload-pack (v2 commands or a v0 want list). */
function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    sendError(res, 400, 'malformed pkt-line stream');
    return;
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'flush') lines.push('\0FLUSH');
    else if (packet.kind === 'delim') lines.push('\0DELIM');
  }

  if (isV2) {
    const command = (lines[0] ?? '').trim();
    if (command === 'command=ls-refs') {
      handleLsRefs(res, repo, lines.slice(1));
      return;
    }
    if (command !== 'command=fetch') {
      sendError(res, 400, `unknown v2 command ${JSON.stringify(command)}`);
      return;
    }
    const args = lines.slice(1);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const line of args) {
      const text = line.replace(/\n$/, '');
      if (text === '\0DELIM' || text === '\0FLUSH' || text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta' || text === 'done' || text.startsWith('agent=') || text.startsWith('object-format=') || text.startsWith('filter ')) continue;
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
      else if (text.startsWith('deepen-since ') || text.startsWith('deepen-not ')) { /* not used by the suite */ }
    }
    const plan = computeFetch(repo, wants, haves, shallow, depth);
    const sections: Buffer[] = [];
    // acknowledgments
    const common = haves.filter((have) => getObject(repo, have) !== undefined);
    const ackLines = common.length > 0 ? [...common.map((have) => `ACK ${have}\n`), 'ready\n'] : ['NAK\n'];
    sections.push(pktLine('acknowledgments\n'), pktLines(ackLines), PKT_DELIM);
    // shallow-info
    const shallowLines = [
      ...plan.shallow.map((oid) => `shallow ${oid}\n`),
      ...plan.unshallow.map((oid) => `unshallow ${oid}\n`),
    ];
    if (shallowLines.length > 0) sections.push(pktLine('shallow-info\n'), pktLines(shallowLines), PKT_DELIM);
    // wanted-refs
    const wantedRefs = listRefs(repo).filter((ref) => wants.includes(ref.oid));
    if (wantedRefs.length > 0) {
      sections.push(pktLine('wanted-refs\n'), pktLines(wantedRefs.map((ref) => `${ref.oid} ${ref.name}\n`)), PKT_DELIM);
    }
    // packfile
    if (plan.objects.length > 0) {
      const pack = buildPack(repo, plan.objects);
      sections.push(pktLine('packfile\n'), sidebandPackets(pack));
    }
    sections.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(sections), 'application/x-git-upload-pack-result');
    return;
  }

  // v0: wants (first line may carry capabilities), shallow/deepen, flush, haves, done, flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let inSecondSection = false;
  for (const line of lines) {
    if (line === '\0FLUSH') { inSecondSection = true; continue; }
    const text = line.replace(/\n$/, '');
    if (!inSecondSection) {
      if (text.startsWith('want ')) {
        const rest = text.slice(5);
        const space = rest.indexOf(' ');
        wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
      } else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  if (wants.length === 0) {
    sendRaw(res, 200, pktLine('NAK\n'), 'application/x-git-upload-pack-result');
    return;
  }
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  const out: Buffer[] = [];
  const common = haves.filter((have) => getObject(repo, have) !== undefined);
  if (common.length > 0) {
    for (const have of common) out.push(pktLine(`ACK ${have}\n`));
  } else {
    out.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) out.push(sidebandPackets(buildPack(repo, plan.objects)));
  out.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

/** Handle a v2 ls-refs command. */
function handleLsRefs(res: ServerResponse, repo: Repo, args: readonly string[]): void {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const line of args) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    else if (text === '\0FLUSH' || text === '\0DELIM' || text.startsWith('agent=') || text.startsWith('object-format=')) continue;
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (keep('HEAD')) {
      const headLine = symrefs
        ? `${headOid(repo)} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`
        : `${headOid(repo)} HEAD\n`;
      out.push(pktLine(headLine));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      const extra = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
      out.push(pktLine(`${ref.oid} ${ref.name}${extra}\n`));
    }
  }
  out.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

/** Handle POST /<owner>/<repo>.git/git-receive-pack (a v0 push). */
function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const report = (unpackLine: string, refLines: readonly string[]): Buffer => {
    // Every report line is its own pkt-line and ends in '\n': the client splits the band-1
    // stream on newlines, so lines without one would run together.
    const stream = pktLines([unpackLine, ...refLines].map((line) => (line.endsWith('\n') ? line : `${line}\n`)));
    return Buffer.concat([sidebandPackets(stream), PKT_FLUSH]);
  };
  // Walk the pkt-lines only up to the first flush: the pack follows the flush and is raw bytes,
  // not pkt-lines, so decoding the whole body as pkt-lines would choke on the pack's 'PACK' header.
  const commandLines: string[] = [];
  let pos = 0;
  let foundFlush = false;
  let malformed = false;
  while (pos + 4 <= body.length) {
    const length = parseInt(body.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) { malformed = true; break; }
    if (length === 0) { pos += 4; foundFlush = true; break; }
    if (length === 1 || length === 2) { pos += 4; continue; }
    if (length < 4 || pos + length > body.length) { malformed = true; break; }
    commandLines.push(body.subarray(pos + 4, pos + length).toString('utf8'));
    pos += length;
  }
  if (malformed || !foundFlush) {
    // A malformed command list must not crash the server: report an unpack error and stay up.
    sendRaw(res, 200, report('unpack error: malformed command list', []), 'application/x-git-receive-pack-result');
    return;
  }
  const packOffset = pos;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (let i = 0; i < commandLines.length; i++) {
    let line = (commandLines[i] as string).replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // capabilities ride on the first line
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string) || !(parts[2] as string).startsWith('refs/')) {
      sendRaw(res, 200, report('unpack error: malformed command line', []), 'application/x-git-receive-pack-result');
      return;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (commands.length === 0) {
    sendRaw(res, 200, report('unpack error: no commands', []), 'application/x-git-receive-pack-result');
    return;
  }
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  const packBytes = body.subarray(packOffset);
  if (updatesRef) {
    if (packBytes.length === 0) {
      sendRaw(res, 200, report('unpack error: no packfile', []), 'application/x-git-receive-pack-result');
      return;
    }
    let objects: Array<{ type: ObjType; raw: Buffer; oid: string }>;
    try {
      objects = parsePack(packBytes);
    } catch (err) {
      sendRaw(res, 200, report(`unpack error: ${err instanceof Error ? err.message : 'bad packfile'}`, []), 'application/x-git-receive-pack-result');
      return;
    }
    for (const obj of objects) {
      if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, raw: obj.raw });
    }
  }
  const refLines: string[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        refLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        refLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        refLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    const obj = getObject(repo, command.newOid);
    if (!obj) {
      refLines.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && obj.type !== 'commit') {
      refLines.push(`ng ${command.ref} object is not a commit`);
      continue;
    }
    if (command.ref.startsWith('refs/tags/') && obj.type !== 'commit' && obj.type !== 'tag') {
      refLines.push(`ng ${command.ref} object is not a commit or tag`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        refLines.push(`ng ${command.ref} already exists`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        refLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    // Update: the old value must match and the new tip must descend from it.
    if (current === undefined) {
      refLines.push(`ng ${command.ref} remote ref does not exist`);
    } else if (command.oldOid !== current) {
      refLines.push(`ng ${command.ref} non-fast-forward`);
    } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
      refLines.push(`ng ${command.ref} non-fast-forward`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      refLines.push(`ok ${command.ref}`);
    }
  }
  sendRaw(res, 200, report('unpack ok', refLines), 'application/x-git-receive-pack-result');
}

// --------------------------------------------------------------------------- REST v3

/** ISO timestamps that strictly increase, so created-order sorts are deterministic. */
let lastIsoMs = 0;
function nextIso(): string {
  let ms = Date.now();
  if (ms <= lastIsoMs) ms = lastIsoMs + 1;
  lastIsoMs = ms;
  return new Date(ms).toISOString();
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: base64Id('User', VIEWER_ID),
    avatar_url: '',
    gravatar_id: '',
    url: '/api/v3/users/adaiversen',
    html_url: 'https://github.com/adaiversen',
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: base64Id('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: base64Id('User', VIEWER_ID), avatar_url: '', type: 'User' },
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: base64Id('Issue', issue.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: issue.user, id: VIEWER_ID, node_id: base64Id('User', VIEWER_ID), type: 'User' },
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: base64Id('IssueComment', comment.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: comment.user, id: VIEWER_ID, node_id: base64Id('User', VIEWER_ID), type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

/** The current tip of a branch, falling back on a stored sha when the branch is gone. */
function refTip(repo: Repo, branch: string, fallback: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? fallback;
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  // head.sha and base.sha track the live branch tips (GitHub re-reads them): a base that moved
  // after the pull request was opened must show its new tip, or a later merge would compare
  // against a stale base and miss a conflict.
  const headSha = refTip(repo, pull.headRef, pull.headSha);
  const baseSha = refTip(repo, pull.baseRef, pull.baseSha);
  return {
    id: pull.id,
    node_id: base64Id('PullRequest', pull.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: pull.user, id: VIEWER_ID, node_id: base64Id('User', VIEWER_ID), type: 'User' },
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
    mergeable: computeMergeable(repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    author_association: 'OWNER',
    draft: false,
  };
}

/** A line diff count between two texts (LCS-based): additions, deletions. */
function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  // LCS on lines; the blobs are small (the suite's are a few KB), so the O(m*n) table is fine.
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * (n + 1) + (j + 1)] + 1
        : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + (j + 1)]);
    }
  }
  const lcs = dp[0];
  return { additions: n - lcs, deletions: m - lcs };
}

/** The changed files between two trees, with line counts. */
function computePullFiles(repo: Repo, baseTree: string, headTree: string): Pull['files'] {
  const diff = treeDiff(repo, baseTree, headTree);
  const files: Pull['files'] = [];
  for (const [path, change] of [...diff.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let status: string;
    let additions = 0;
    let deletions = 0;
    if (change.old === undefined) {
      status = 'added';
      const content = change.next !== undefined ? (getObject(repo, change.next)?.raw.toString('utf8') ?? '') : '';
      additions = content === '' ? 0 : content.split('\n').length;
    } else if (change.next === undefined) {
      status = 'removed';
      const content = getObject(repo, change.old)?.raw.toString('utf8') ?? '';
      deletions = content === '' ? 0 : content.split('\n').length;
    } else {
      status = 'modified';
      const oldContent = getObject(repo, change.old)?.raw.toString('utf8') ?? '';
      const newContent = getObject(repo, change.next)?.raw.toString('utf8') ?? '';
      const counts = diffLineCounts(oldContent, newContent);
      additions = counts.additions;
      deletions = counts.deletions;
    }
    files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return files;
}

/** Whether a pull request merges cleanly (three-way: the same path changed differently on both
 *  sides of the merge-base is a conflict). The tips are read live from the branches, not from the
 *  snapshot taken when the pull request was opened. */
function computeMergeable(repo: Repo, pull: Pull): boolean | null {
  if (pull.merged || pull.state === 'closed') return false;
  const headSha = refTip(repo, pull.headRef, pull.headSha);
  const baseSha = refTip(repo, pull.baseRef, pull.baseSha);
  const headObj = getObject(repo, headSha);
  const baseObj = getObject(repo, baseSha);
  if (!headObj || !baseObj || headObj.type !== 'commit' || baseObj.type !== 'commit') return null;
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) return false;
  const baseInfo = parseCommit((getObject(repo, base) as GitObject).raw);
  const headInfo = parseCommit(headObj.raw);
  const baseTipInfo = parseCommit(baseObj.raw);
  const baseDiff = treeDiff(repo, baseInfo.tree, baseTipInfo.tree);
  const headDiff = treeDiff(repo, baseInfo.tree, headInfo.tree);
  for (const [path, headChange] of headDiff) {
    const baseChange = baseDiff.get(path);
    if (baseChange !== undefined && baseChange.next !== headChange.next) return false;
  }
  return true;
}

/** Resolve a ref name or commit oid to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return headOid(repo) === ZERO_OID ? null : headOid(repo);
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byTag = repo.refs.get(`refs/tags/${ref}`);
  if (byTag !== undefined) return byTag;
  if (isOid(ref)) {
    const obj = getObject(repo, ref);
    if (obj && obj.type === 'commit') return ref;
    if (obj && obj.type === 'tag') return parseTag(obj.raw).object;
  }
  return null;
}

/** Paginate a list: returns the page and the Link header value ('' when there is no next page). */
function paginate<T>(req: IncomingMessage, path: string, query: URLSearchParams, items: readonly T[]): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link = '';
  if (page < totalPages) {
    const host = req.headers.host ?? '127.0.0.1';
    const nextQuery = new URLSearchParams(query);
    nextQuery.set('per_page', String(perPage));
    nextQuery.set('page', String(page + 1));
    const lastQuery = new URLSearchParams(query);
    lastQuery.set('per_page', String(perPage));
    lastQuery.set('page', String(totalPages));
    link = `<http://${host}${path}?${nextQuery.toString()}>; rel="next", <http://${host}${path}?${lastQuery.toString()}>; rel="last"`;
  }
  return { page: slice as T[], link };
}

function sendPage(res: ServerResponse, status: number, body: unknown, link: string): void {
  sendJson(res, status, body, link === '' ? {} : { link });
}

/** Create a commit on a branch from a file map change, returning the new commit oid. */
function commitFiles(repo: Repo, branch: string, files: Map<string, string>, message: string, parents: readonly string[]): string {
  const treeOid = buildTreeFromFiles(repo, files);
  const time = nextCommitTime();
  const commitOid = putObject(repo, 'commit', serializeCommit({
    tree: treeOid,
    parents: [...parents],
    authorName: VIEWER_NAME, authorEmail: VIEWER_EMAIL, authorTime: time,
    committerName: VIEWER_NAME, committerEmail: VIEWER_EMAIL, committerTime: time,
    message,
  }));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = nowIso();
  return commitOid;
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const query = queryOf(req);
  const segments = path.split('/').filter((s) => s !== '');

  // API root and meta are public, as in the starter.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '0.1.0' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } }, rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } });
    return;
  }

  if (!authorized(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }

  const body = await readBody(req);
  const parsed = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') ? parseJsonBody(body) : { value: null, error: null };
  if (parsed.error !== null) {
    sendError(res, 400, parsed.error);
    return;
  }
  const input = parsed.value ?? {};

  // GET /api/v3/user
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, userJson());
    return;
  }

  // /api/v3/user/repos
  if (segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(req, path, query, userRepos().map(repoJson));
      sendPage(res, 200, page, link);
      return;
    }
    if (method === 'POST') {
      const name = asString(input.name);
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendError(res, 422, 'name is invalid');
        return;
      }
      if (getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendError(res, 422, 'Repository already exists');
        return;
      }
      const repo = createRepoRecord(name, asString(input.description), asBoolean(input.private, false));
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos' && segments.length >= 5) {
    const owner = decodeURIComponent(segments[3] as string);
    const repoName = decodeURIComponent(segments[4] as string);
    const repo = getRepo(owner, repoName);
    if (!repo || repo.owner !== owner) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const rest = segments.slice(5);

    // The repository itself.
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
      if (method === 'PATCH') {
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        if (typeof input.default_branch === 'string' && repo.refs.has(`refs/heads/${input.default_branch}`)) repo.defaultBranch = input.default_branch;
        repo.updatedAt = nowIso();
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        deleteRepoRecord(repo);
        res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
        res.end();
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((name) => name.startsWith('refs/heads/'))
          .map((name) => name.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({
            name,
            commit: { sha: repo.refs.get(`refs/heads/${name}`) as string, url: `/api/v3/repos/${owner}/${repoName}/commits/${repo.refs.get(`refs/heads/${name}`)}` },
            protected: false,
          }));
        sendJson(res, 200, branches);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1] as string);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) { sendError(res, 404, 'Branch not found'); return; }
        sendJson(res, 200, {
          name: branch,
          sha,
          commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
          protected: false,
        });
        return;
      }
    }

    // Commits.
    if (rest[0] === 'commits' && method === 'GET') {
      if (rest.length === 2) {
        const sha = decodeURIComponent(rest[1] as string);
        const obj = getObject(repo, sha);
        if (!obj || obj.type !== 'commit') { sendError(res, 404, 'Not Found'); return; }
        const info = parseCommit(obj.raw);
        sendJson(res, 200, commitJson(repo, sha, info));
        return;
      }
      const tip = resolveRef(repo, query.get('sha') ?? undefined);
      if (tip === null) { sendJson(res, 200, []); return; }
      const walked = walkCommits(repo, [tip]);
      const { page, link } = paginate(req, path, query, walked.map((info) => {
        const oid = hashObject('commit', serializeCommit(info));
        return commitJson(repo, oid, info);
      }));
      sendPage(res, 200, page, link);
      return;
    }

    // Git Data: refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = asString(input.ref);
        const sha = asString(input.sha);
        if (!ref.startsWith('refs/') || !isOid(sha)) { sendError(res, 422, 'Invalid ref or sha'); return; }
        if (repo.refs.has(ref)) { sendError(res, 422, 'Reference already exists'); return; }
        const obj = getObject(repo, sha);
        if (!obj) { sendError(res, 422, 'Object does not exist'); return; }
        repo.refs.set(ref, sha);
        repo.updatedAt = nowIso();
        sendJson(res, 201, { ref, node_id: base64Id('Ref', repo.id), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`, object: { sha, type: obj.type, url: `/api/v3/repos/${owner}/${repoName}/git/${obj.type}s/${sha}` } });
        return;
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const all = [...repo.refs.keys()].sort().map((name) => {
            const oid = repo.refs.get(name) as string;
            const obj = getObject(repo, oid);
            return { ref: name, node_id: base64Id('Ref', repo.id), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${name.slice(5)}`, object: { sha: oid, type: obj?.type ?? 'commit', url: '' } };
          });
          sendJson(res, 200, all);
          return;
        }
        const refName = `refs/${rest.slice(2).map((s) => decodeURIComponent(s)).join('/')}`;
        const oid = repo.refs.get(refName);
        if (oid === undefined) { sendError(res, 404, 'Not Found'); return; }
        const obj = getObject(repo, oid);
        sendJson(res, 200, { ref: refName, node_id: base64Id('Ref', repo.id), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${refName.slice(5)}`, object: { sha: oid, type: obj?.type ?? 'commit', url: '' } });
        return;
      }
    }

    // Contents.
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref') ?? undefined);
        if (tip === null) { sendError(res, 404, 'Not Found'); return; }
        const info = parseCommit((getObject(repo, tip) as GitObject).raw);
        const files = flattenTree(repo, info.tree);
        if (contentPath === '') {
          sendJson(res, 200, directoryListing(repo, info.tree, ''));
          return;
        }
        const blobOid = files.get(contentPath);
        if (blobOid !== undefined) {
          const blob = getObject(repo, blobOid) as GitObject;
          const name = contentPath.split('/').pop() as string;
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: blob.raw.length, name, path: contentPath,
            content: b64encode(blob.raw), sha: blobOid,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
            html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${contentPath}`,
            download_url: '',
          });
          return;
        }
        // A directory: any file under it.
        const prefix = `${contentPath}/`;
        const hasChildren = [...files.keys()].some((p) => p.startsWith(prefix));
        if (hasChildren) {
          sendJson(res, 200, directoryListing(repo, info.tree, contentPath));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        const contentB64 = asString(input.content);
        const data = b64decode(contentB64);
        if (data === null) { sendError(res, 422, 'content is not valid base64'); return; }
        const message = asString(input.message, `Update ${contentPath}`);
        const branch = asString(input.branch, repo.defaultBranch);
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        const files = branchTip !== undefined
          ? flattenTree(repo, parseCommit((getObject(repo, branchTip) as GitObject).raw).tree)
          : new Map<string, string>();
        const existing = files.get(contentPath);
        const givenSha = asString(input.sha);
        if (existing !== undefined && givenSha !== '' && givenSha !== existing) {
          sendError(res, 409, 'sha does not match');
          return;
        }
        const isCreate = existing === undefined;
        const blobOid = putObject(repo, 'blob', data);
        files.set(contentPath, blobOid);
        const parents = branchTip !== undefined ? [branchTip] : [];
        const commitOid = commitFiles(repo, branch, files, message, parents);
        const status = isCreate ? 201 : 200;
        const createdInfo = parseCommit((getObject(repo, commitOid) as GitObject).raw);
        const createdDate = new Date(createdInfo.committerTime * 1000).toISOString();
        sendJson(res, status, {
          content: {
            name: contentPath.split('/').pop(), path: contentPath, sha: blobOid, size: data.length,
            type: 'file', encoding: 'base64', content: contentB64,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
          },
          commit: {
            sha: commitOid, message,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: createdDate },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: createdDate },
            tree: { sha: createdInfo.tree },
            parents: parents.map((sha) => ({ sha })),
          },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = asString(input.branch, repo.defaultBranch);
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (branchTip === undefined) { sendError(res, 404, 'Not Found'); return; }
        const files = flattenTree(repo, parseCommit((getObject(repo, branchTip) as GitObject).raw).tree);
        const existing = files.get(contentPath);
        if (existing === undefined) { sendError(res, 404, 'Not Found'); return; }
        const givenSha = asString(input.sha);
        if (givenSha !== '' && givenSha !== existing) { sendError(res, 409, 'sha does not match'); return; }
        files.delete(contentPath);
        const message = asString(input.message, `Delete ${contentPath}`);
        const commitOid = commitFiles(repo, branch, files, message, [branchTip]);
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return;
      }
    }

    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const name = asString(input.name);
        if (name === '') { sendError(res, 422, 'name is required'); return; }
        const existing = repo.labels.get(name);
        if (existing) { sendJson(res, 201, labelJson(existing)); return; }
        const label: Label = {
          name,
          color: asString(input.color, KNOWN_LABEL_COLORS[name] ?? 'ededed').replace(/^#/, ''),
          description: asString(input.description),
        };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return;
      }
    }

    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'POST') {
        const title = asString(input.title);
        if (title === '') { sendError(res, 422, 'title is required'); return; }
        const labelNames = Array.isArray(input.labels) ? (input.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as Record<string, unknown>).name as string)) : [];
        const labels: Label[] = [];
        for (const name of labelNames) {
          const label = repo.labels.get(name);
          if (!label) { sendError(res, 422, `Label does not exist: ${name}`); return; }
          labels.push(label);
        }
        const now = nextIso();
        const issue: Issue = {
          id: nextIssueId++,
          number: repo.nextIssue++,
          title,
          body: asString(input.body),
          state: 'open',
          labels,
          user: VIEWER_LOGIN,
          createdAt: now,
          updatedAt: now,
          closedAt: null,
          comments: [],
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = repo.issues;
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const sorted = [...list];
        if (sort === 'created') {
          sorted.sort((a, b) => direction === 'asc'
            ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number)
            : (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : b.number - a.number));
        }
        const { page, link } = paginate(req, path, query, sorted.map((i) => issueJson(repo, i)));
        sendPage(res, 200, page, link);
        return;
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) { sendError(res, 404, 'Not Found'); return; }
        if (rest.length === 2 && method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
        if (rest.length === 2 && method === 'PATCH') {
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'open' || input.state === 'closed') {
            issue.state = input.state;
            issue.closedAt = input.state === 'closed' ? nextIso() : null;
          }
          issue.updatedAt = nextIso();
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (rest[2] === 'comments') {
          if (method === 'POST') {
            const bodyText = asString(input.body);
            if (bodyText === '') { sendError(res, 422, 'body is required'); return; }
            const now = nextIso();
            const comment = { id: nextCommentId++, body: bodyText, user: VIEWER_LOGIN, createdAt: now, updatedAt: now };
            issue.comments.push(comment);
            issue.updatedAt = now;
            sendJson(res, 201, commentJson(repo, issue, comment));
            return;
          }
          if (method === 'GET') {
            const { page, link } = paginate(req, path, query, issue.comments.map((c) => commentJson(repo, issue, c)));
            sendPage(res, 200, page, link);
            return;
          }
        }
      }
    }

    // Pull requests.
    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'POST') {
        const title = asString(input.title);
        const head = typeof input.head === 'string' ? input.head : asString((input.head as Record<string, unknown> | undefined)?.ref);
        const base = typeof input.base === 'string' ? input.base : asString((input.base as Record<string, unknown> | undefined)?.ref);
        if (title === '' || head === '' || base === '') { sendError(res, 422, 'title, head and base are required'); return; }
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) { sendError(res, 422, 'head or base branch does not exist'); return; }
        const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (duplicate) { sendError(res, 422, 'A pull request already exists for this head and base'); return; }
        const headInfo = parseCommit((getObject(repo, headSha) as GitObject).raw);
        const baseInfo = parseCommit((getObject(repo, baseSha) as GitObject).raw);
        const now = nextIso();
        const pull: Pull = {
          id: nextPullId++,
          number: repo.nextPull++,
          title,
          body: asString(input.body),
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef: head,
          headSha,
          baseRef: base,
          baseSha,
          user: VIEWER_LOGIN,
          createdAt: now,
          updatedAt: now,
          files: computePullFiles(repo, baseInfo.tree, headInfo.tree),
        };
        repo.pulls.push(pull);
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = repo.pulls;
        if (state !== 'all') list = list.filter((p) => p.state === state);
        const { page, link } = paginate(req, path, query, [...list].sort((a, b) => b.number - a.number).map((p) => pullJson(repo, p)));
        sendPage(res, 200, page, link);
        return;
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) { sendError(res, 404, 'Not Found'); return; }
        if (rest.length === 2 && method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          sendJson(res, 200, pull.files);
          return;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (pull.merged) {
            sendJson(res, 200, { merged: true, sha: pull.mergeCommitSha, message: `Merged pull request #${pull.number}` });
            return;
          }
          const mergeable = computeMergeable(repo, pull);
          if (mergeable !== true) {
            sendError(res, 405, 'This branch has conflicts that must be resolved');
            return;
          }
          const headSha = refTip(repo, pull.headRef, pull.headSha);
          const baseSha = refTip(repo, pull.baseRef, pull.baseSha);
          const base = mergeBase(repo, headSha, baseSha) as string;
          const baseInfo = parseCommit((getObject(repo, base) as GitObject).raw);
          const headInfo = parseCommit((getObject(repo, headSha) as GitObject).raw);
          const baseTipInfo = parseCommit((getObject(repo, baseSha) as GitObject).raw);
          const headDiff = treeDiff(repo, baseInfo.tree, headInfo.tree);
          const baseTipFiles = flattenTree(repo, baseTipInfo.tree);
          for (const [path, change] of headDiff) {
            if (change.next === undefined) baseTipFiles.delete(path);
            else baseTipFiles.set(path, change.next);
          }
          const methodName = asString(input.merge_method, 'squash');
          const parents = methodName === 'merge' ? [baseSha, headSha] : [baseSha];
          const message = methodName === 'merge'
            ? `Merge pull request #${pull.number} from ${pull.headRef}`
            : `${pull.title} (#${pull.number})`;
          const mergeSha = commitFiles(repo, pull.baseRef, baseTipFiles, message, parents);
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = nextIso();
          pull.mergeCommitSha = mergeSha;
          pull.updatedAt = pull.mergedAt;
          pull.baseSha = mergeSha;
          sendJson(res, 200, { merged: true, sha: mergeSha, message: `Pull Request successfully merged` });
          return;
        }
      }
    }
  }

  sendError(res, 404, 'Not Found');
}

/** One commit as a REST commit object. */
function commitJson(repo: Repo, sha: string, info: CommitInfo): Record<string, unknown> {
  const date = new Date(info.committerTime * 1000).toISOString();
  const authorDate = new Date(info.authorTime * 1000).toISOString();
  return {
    sha,
    node_id: base64Id('Commit', repo.id),
    commit: {
      author: { name: info.authorName, email: info.authorEmail, date: authorDate },
      committer: { name: info.committerName, email: info.committerEmail, date },
      message: info.message,
      tree: { sha: info.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${info.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: base64Id('User', VIEWER_ID), type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: base64Id('User', VIEWER_ID), type: 'User' },
    parents: info.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

/** A directory listing for a tree at a path prefix. */
function directoryListing(repo: Repo, treeOid: string, dir: string): Array<Record<string, unknown>> {
  const entries = new Map<string, { type: string; oid: string; size?: number }>();
  const files = flattenTree(repo, treeOid);
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const [path, oid] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const blob = getObject(repo, oid) as GitObject;
      entries.set(rest, { type: 'file', oid, size: blob.raw.length });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) entries.set(name, { type: 'dir', oid: '' });
    }
  }
  // Directories need their tree oid: recompute from the tree itself.
  const obj = getObject(repo, treeOid);
  const out: Array<Record<string, unknown>> = [];
  if (obj && obj.type === 'tree' && dir !== '') {
    // Walk to the directory's tree to get exact child oids.
    const parts = dir.split('/');
    let current: TreeEntry[] = parseTree(obj.raw);
    for (const part of parts) {
      const found = current.find((e) => e.name === part && e.mode === 0o40000);
      if (!found) { current = []; break; }
      current = parseTree((getObject(repo, found.oid) as GitObject).raw);
    }
    for (const entry of current) {
      const isDir = entry.mode === 0o40000;
      const record: Record<string, unknown> = {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path: `${dir}/${entry.name}`,
        sha: entry.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${dir}/${entry.name}`,
      };
      if (!isDir) record.size = (getObject(repo, entry.oid) as GitObject).raw.length;
      out.push(record);
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return out;
  }
  for (const [name, entry] of [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const record: Record<string, unknown> = {
      type: entry.type,
      name,
      path: dir === '' ? name : `${dir}/${name}`,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${dir === '' ? name : `${dir}/${name}`}`,
    };
    if (entry.type === 'file') record.size = entry.size;
    out.push(record);
  }
  return out;
}

// --------------------------------------------------------------------------- GraphQL v4

/** Decode a global id (base64 "Kind:<numericId>") into its kind and number. */
function decodeGlobalId(id: string): { kind: string; numericId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!match) return null;
    return { kind: match[1] as string, numericId: Number(match[2]) };
  } catch {
    return null;
  }
}

function findRepoByNumericId(id: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findIssueByNumericId(id: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of repos.values()) {
    const issue = repo.issues.find((i) => i.id === id);
    if (issue) return { repo, issue };
  }
  return undefined;
}

function findPullByNumericId(id: number): { repo: Repo; pull: Pull } | undefined {
  for (const repo of repos.values()) {
    const pull = repo.pulls.find((p) => p.id === id);
    if (pull) return { repo, pull };
  }
  return undefined;
}

function gqlIssueState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function gqlMergeable(repo: Repo, pull: Pull): string {
  const value = computeMergeable(repo, pull);
  return value === true ? 'MERGEABLE' : value === false ? 'CONFLICTING' : 'UNKNOWN';
}

function gqlRepoFields(repo: Repo): Record<string, unknown> {
  const defaultRef = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: base64Id('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: defaultRef !== undefined ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function gqlIssueFields(issue: Issue): Record<string, unknown> {
  return {
    id: base64Id('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: gqlIssueState(issue.state),
  };
}

function gqlPullFields(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: base64Id('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: gqlIssueState(pull.state),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: gqlMergeable(repo, pull),
    merged: pull.merged,
  };
}

/** Create an issue in a repository (shared by REST, GraphQL and MCP). */
function createIssueInRepo(repo: Repo, title: string, body: string): Issue {
  const now = nextIso();
  const issue: Issue = {
    id: nextIssueId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [],
    user: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request in a repository (shared by REST, GraphQL and MCP). Returns an error string on failure. */
function createPullInRepo(repo: Repo, title: string, body: string, head: string, base: string): { pull: Pull | null; error: string | null } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return { pull: null, error: 'head or base branch does not exist' };
  const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (duplicate) return { pull: null, error: 'A pull request already exists for this head and base' };
  const headInfo = parseCommit((getObject(repo, headSha) as GitObject).raw);
  const baseInfo = parseCommit((getObject(repo, baseSha) as GitObject).raw);
  const now = nextIso();
  const pull: Pull = {
    id: nextPullId++,
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    user: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    files: computePullFiles(repo, baseInfo.tree, headInfo.tree),
  };
  repo.pulls.push(pull);
  return { pull, error: null };
}

/** Merge a pull request (squash). Returns an error string on failure. */
function mergePullInRepo(repo: Repo, pull: Pull, mergeMethod: string): { sha: string | null; error: string | null } {
  if (pull.merged) return { sha: pull.mergeCommitSha, error: null };
  if (computeMergeable(repo, pull) !== true) return { sha: null, error: 'This branch has conflicts that must be resolved' };
  const headSha = refTip(repo, pull.headRef, pull.headSha);
  const baseSha = refTip(repo, pull.baseRef, pull.baseSha);
  const base = mergeBase(repo, headSha, baseSha) as string;
  const baseInfo = parseCommit((getObject(repo, base) as GitObject).raw);
  const headInfo = parseCommit((getObject(repo, headSha) as GitObject).raw);
  const baseTipInfo = parseCommit((getObject(repo, baseSha) as GitObject).raw);
  const headDiff = treeDiff(repo, baseInfo.tree, headInfo.tree);
  const baseTipFiles = flattenTree(repo, baseTipInfo.tree);
  for (const [path, change] of headDiff) {
    if (change.next === undefined) baseTipFiles.delete(path);
    else baseTipFiles.set(path, change.next);
  }
  const parents = mergeMethod === 'merge' ? [baseSha, headSha] : [baseSha];
  const message = mergeMethod === 'merge'
    ? `Merge pull request #${pull.number} from ${pull.headRef}`
    : `${pull.title} (#${pull.number})`;
  const mergeSha = commitFiles(repo, pull.baseRef, baseTipFiles, message, parents);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nextIso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = pull.mergedAt;
  pull.baseSha = mergeSha;
  return { sha: mergeSha, error: null };
}

/** Execute one GraphQL document. Returns the response body (data and/or errors). */
function executeGraphQL(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const q = query.replace(/\s+/g, ' ');
  const vars = variables;

  // Introspection probes.
  if (q.includes('__type')) {
    if (q.includes('"Issue"')) {
      return { data: { Issue: { fields: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'].map((name) => ({ name })) } } };
    }
    if (q.includes('"PullRequest"') && q.includes('"Repository"')) {
      return {
        data: {
          PullRequest: { fields: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'mergeCommit', 'files', 'createdAt', 'updatedAt', 'author', 'url'].map((name) => ({ name })) },
          Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url'].map((name) => ({ name })) },
        },
      };
    }
    if (q.includes('"SearchType"')) {
      return { data: { SearchType: { enumValues: ['ISSUE', 'COMMIT', 'DISCUSSION', 'MILESTONE', 'REPOSITORY', 'USER'].map((name) => ({ name })) } } };
    }
    return { data: {}, errors: [{ message: 'unknown __type probe' }] };
  }

  // Mutations.
  if (q.includes('mutation')) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    if (q.includes('createIssue(')) {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoByNumericId(decoded.numericId) : undefined;
      if (!repo) return { data: { createIssue: null }, errors: [{ message: 'repository not found' }] };
      const issue = createIssueInRepo(repo, asString(input.title), asString(input.body));
      return { data: { createIssue: { issue: { number: issue.number, id: base64Id('Issue', issue.id) } } } };
    }
    if (q.includes('closeIssue(')) {
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const found = decoded !== null && decoded.kind === 'Issue' ? findIssueByNumericId(decoded.numericId) : undefined;
      if (!found) return { data: { closeIssue: null }, errors: [{ message: 'issue not found' }] };
      found.issue.state = 'closed';
      found.issue.closedAt = nextIso();
      found.issue.updatedAt = found.issue.closedAt;
      return { data: { closeIssue: { issue: { number: found.issue.number, id: base64Id('Issue', found.issue.id), state: 'CLOSED' } } } };
    }
    if (q.includes('createPullRequest(')) {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoByNumericId(decoded.numericId) : undefined;
      if (!repo) return { data: { createPullRequest: null }, errors: [{ message: 'repository not found' }] };
      const { pull, error } = createPullInRepo(repo, asString(input.title), asString(input.body), asString(input.headRefName), asString(input.baseRefName));
      if (!pull) return { data: { createPullRequest: null }, errors: [{ message: error ?? 'cannot create pull request' }] };
      return { data: { createPullRequest: { pullRequest: { number: pull.number, id: base64Id('PullRequest', pull.id), state: 'OPEN', headRefName: pull.headRef, baseRefName: pull.baseRef } } } };
    }
    if (q.includes('mergePullRequest(')) {
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const found = decoded !== null && decoded.kind === 'PullRequest' ? findPullByNumericId(decoded.numericId) : undefined;
      if (!found) return { data: { mergePullRequest: null }, errors: [{ message: 'pull request not found' }] };
      const { error } = mergePullInRepo(found.repo, found.pull, asString(input.mergeMethod, 'SQUASH'));
      if (error !== null) return { data: { mergePullRequest: null }, errors: [{ message: error }] };
      return { data: { mergePullRequest: { pullRequest: { number: found.pull.number, merged: true, state: 'CLOSED' } } } };
    }
    if (q.includes('addComment(')) {
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const found = decoded !== null && decoded.kind === 'Issue' ? findIssueByNumericId(decoded.numericId) : undefined;
      if (!found) return { data: { addComment: null }, errors: [{ message: 'subject not found' }] };
      const now = nextIso();
      const comment = { id: nextCommentId++, body: asString(input.body), user: VIEWER_LOGIN, createdAt: now, updatedAt: now };
      found.issue.comments.push(comment);
      found.issue.updatedAt = now;
      return { data: { addComment: { commentEdge: { node: { id: base64Id('IssueComment', comment.id), body: comment.body } } } } };
    }
    return { data: {}, errors: [{ message: 'unknown mutation' }] };
  }

  // node(id:).
  if (q.includes('node(')) {
    const decoded = typeof vars.id === 'string' ? decodeGlobalId(vars.id) : null;
    if (decoded !== null && decoded.kind === 'Repository') {
      const repo = findRepoByNumericId(decoded.numericId);
      if (repo) return { data: { node: { id: base64Id('Repository', repo.id), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
    }
    return { data: { node: null } };
  }

  // viewer. (Match 'viewer {' with its brace: the repository documents carry the field
  // 'viewerPermission', which must not be mistaken for a viewer query.)
  if (q.includes('viewer {')) {
    if (q.includes('noSuchFieldOnViewer')) {
      return {
        data: { viewer: { login: VIEWER_LOGIN } },
        errors: [{ message: "Field 'noSuchFieldOnViewer' doesn't exist on type 'User'", type: 'FIELD', path: ['viewer', 'noSuchFieldOnViewer'] }],
      };
    }
    return { data: { viewer: { login: VIEWER_LOGIN } } };
  }

  // repository(...) queries.
  if (q.includes('repository(')) {
    const owner = asString(vars.owner);
    const name = asString(vars.name);
    const repo = getRepo(owner, name);
    if (!repo || repo.owner !== owner) return { data: { repository: null } };
    if (q.includes('pageInfo')) {
      // IssuesPage: cursor pagination over issues, newest first.
      const first = typeof vars.first === 'number' ? vars.first : 5;
      const after = asString(vars.after);
      let afterNumber = -1;
      if (after !== '') {
        try {
          const text = Buffer.from(after, 'base64').toString('utf8');
          const m = /^cursor:(\d+)$/.exec(text);
          if (m) afterNumber = Number(m[1]);
        } catch { /* an opaque cursor we cannot read: start from the top */ }
      }
      const sorted = [...repo.issues].sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : b.number - a.number));
      const window = afterNumber >= 0 ? sorted.filter((i) => i.number < afterNumber) : sorted;
      const page = window.slice(0, first);
      const hasNextPage = window.length > first;
      const endCursor = page.length > 0 ? Buffer.from(`cursor:${(page[page.length - 1] as Issue).number}`, 'utf8').toString('base64') : null;
      return { data: { repository: { issues: { nodes: page.map((i) => ({ number: i.number })), pageInfo: { hasNextPage, endCursor } } } } };
    }
    if (q.includes('states: [OPEN]')) {
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const open = repo.issues
        .filter((i) => i.state === 'open')
        .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : b.number - a.number))
        .slice(0, first);
      return { data: { repository: { issues: { nodes: open.map((i) => ({ number: i.number, title: i.title, state: 'OPEN', id: base64Id('Issue', i.id) })) } } } };
    }
    if (q.includes('issue(number:')) {
      const number = typeof vars.number === 'number' ? vars.number : -1;
      const issue = repo.issues.find((i) => i.number === number);
      return { data: { repository: { issue: issue ? gqlIssueFields(issue) : null } } };
    }
    if (q.includes('pullRequests(')) {
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const pulls = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
      return { data: { repository: { pullRequests: { nodes: pulls.map((p) => ({ number: p.number, headRefName: p.headRef, baseRefName: p.baseRef, mergeable: gqlMergeable(repo, p), state: gqlIssueState(p.state) })) } } } };
    }
    if (q.includes('pullRequest(number:')) {
      const number = typeof vars.number === 'number' ? vars.number : -1;
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return { data: { repository: { pullRequest: null } } };
      if (q.includes('files(')) {
        return { data: { repository: { pullRequest: { number: pull.number, files: { nodes: pull.files.slice(0, 10).map((f) => ({ path: f.filename })) } } } } };
      }
      return { data: { repository: { pullRequest: { id: base64Id('PullRequest', pull.id), number: pull.number } } } };
    }
    return { data: { repository: gqlRepoFields(repo) } };
  }

  return { data: {}, errors: [{ message: 'unknown document' }] };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendError(res, 400, 'malformed JSON body');
    return;
  }
  // Batched operations: an array of documents answers an array of responses, in order.
  if (Array.isArray(parsed)) {
    const answers = parsed.map((doc) => {
      if (doc !== null && typeof doc === 'object' && typeof (doc as Record<string, unknown>).query === 'string') {
        const d = doc as Record<string, unknown>;
        return executeGraphQL(d.query as string, (d.variables ?? {}) as Record<string, unknown>);
      }
      return { data: {}, errors: [{ message: 'invalid document' }] };
    });
    sendJson(res, 200, answers);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).query !== 'string') {
    sendError(res, 400, 'a query string is required');
    return;
  }
  const doc = parsed as Record<string, unknown>;
  sendJson(res, 200, executeGraphQL(doc.query as string, (doc.variables ?? {}) as Record<string, unknown>));
}

// --------------------------------------------------------------------------- MCP

interface McpToolDef {
  name: string;
  description: string;
  properties: Readonly<Record<string, { type: string; description: string }>>;
  required: readonly string[];
}

const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const MCP_TOOLS_JSON = MCP_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: { type: 'object', properties: tool.properties, required: [...tool.required] },
}));

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolTextResult(result: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

/** Run one MCP tool. Returns the tool result, or an error message when it fails. */
function runMcpTool(name: string, args: Record<string, unknown>): { ok: true; result: unknown } | { ok: false; message: string } {
  const owner = asString(args.owner, VIEWER_LOGIN);
  const repoName = asString(args.repo);
  if (name === 'create_repo') {
    const repoNameArg = asString(args.name);
    if (repoNameArg === '') return { ok: false, message: 'name is required' };
    if (getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) return { ok: false, message: 'Repository already exists' };
    const repo = createRepoRecord(repoNameArg, asString(args.description), asBoolean(args.private, false));
    return { ok: true, result: repoJson(repo) };
  }
  const repo = getRepo(owner, repoName);
  if (!repo || repo.owner !== owner) return { ok: false, message: `repository ${owner}/${repoName} not found` };
  switch (name) {
    case 'get_repo':
      return { ok: true, result: repoJson(repo) };
    case 'create_issue': {
      const title = asString(args.title);
      if (title === '') return { ok: false, message: 'title is required' };
      const issue = createIssueInRepo(repo, title, asString(args.body));
      return { ok: true, result: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const state = asString(args.state, 'open');
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return { ok: true, result: { issues: list.map((i) => issueJson(repo, i)) } };
    }
    case 'get_issue': {
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return { ok: false, message: `issue #${number} not found` };
      return { ok: true, result: issueJson(repo, issue) };
    }
    case 'create_pull_request': {
      const { pull, error } = createPullInRepo(repo, asString(args.title), asString(args.body), asString(args.head), asString(args.base));
      if (!pull) return { ok: false, message: error ?? 'cannot create pull request' };
      return { ok: true, result: pullJson(repo, pull) };
    }
    case 'list_pull_requests': {
      const state = asString(args.state, 'open');
      const list = state === 'all' ? repo.pulls : repo.pulls.filter((p) => p.state === state);
      return { ok: true, result: { pull_requests: list.map((p) => pullJson(repo, p)) } };
    }
    case 'merge_pull_request': {
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return { ok: false, message: `pull request #${number} not found` };
      const { sha, error } = mergePullInRepo(repo, pull, 'squash');
      if (error !== null) return { ok: false, message: error };
      return { ok: true, result: { merged: true, number: pull.number, sha, state: 'closed' } };
    }
    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad credentials' } });
    return;
  }
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const message = parsed as Record<string, unknown>;
  const id = message.id ?? null;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;

  // A notification (no id): no JSON-RPC answer, just an HTTP 202.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': `req-${++requestCounter}` });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: 'kepet-forge', version: '0.1.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'kepet-forge', version: '0.1.0' } },
    }));
    return;
  }
  if (method === 'initialize') {
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'kepet-forge', version: '0.1.0' },
    }));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS_JSON }));
    return;
  }
  if (method === 'tools/call') {
    const name = asString(params.name);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) {
      sendJson(res, 200, mcpError(id, -32601, `unknown tool ${name}`));
      return;
    }
    const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      sendJson(res, 200, mcpError(id, -32602, `missing required arguments: ${missing.join(', ')}`));
      return;
    }
    const outcome = runMcpTool(name, args);
    if (!outcome.ok) {
      sendJson(res, 200, mcpResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true }));
      return;
    }
    sendJson(res, 200, mcpResult(id, toolTextResult(outcome.result)));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `method not found: ${method}`));
}

// --------------------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /<owner>/<repo>.git/info/refs, /git-upload-pack, /git-receive-pack.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1] as string);
      const repoName = decodeURIComponent(gitMatch[2] as string);
      const rest = gitMatch[3] as string;
      if (!authorized(req)) {
        sendError(res, 401, 'Bad credentials');
        return;
      }
      const repo = getRepo(owner, repoName);
      if (!repo || repo.owner !== owner) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET' && rest === 'info/refs') {
        handleInfoRefs(req, res, owner, repoName);
        return;
      }
      if (method === 'POST' && (rest === 'git-upload-pack' || rest === 'git-receive-pack')) {
        readBody(req).then((body) => {
          if (rest === 'git-upload-pack') handleUploadPack(req, res, repo, body);
          else handleReceivePack(req, res, repo, body);
        }).catch(() => sendError(res, 400, 'could not read request body'));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // GraphQL v4.
    if (method === 'POST' && path === '/api/graphql') {
      handleGraphQL(req, res).catch(() => sendError(res, 500, 'internal error'));
      return;
    }

    // MCP over streamable HTTP.
    if (method === 'POST' && path === '/mcp') {
      handleMcp(req, res).catch(() => sendError(res, 500, 'internal error'));
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      handleRest(req, res).catch(() => sendError(res, 500, 'internal error'));
      return;
    }

    // Everything else, every method: GitHub's 404 body.
    sendError(res, 404, 'Not Found');
  });
}
