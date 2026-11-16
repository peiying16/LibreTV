import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CatalogEpisode, DownloadJob, LibraryEpisode, LibraryItem } from '@/lib/library-types';
import type { HistoryEntry } from '@/lib/db';
import type { SourceConfig } from '@/lib/types';

type Row = Record<string, unknown>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
export function libraryId(sourceUrl: string, vodId: string): string {
  const u = new URL(sourceUrl); u.hash = ''; u.pathname = u.pathname.replace(/\/+$/, '');
  return hash(`${u.href.replace(/\/$/, '')}\n${vodId}`);
}
export class LibraryStore {
  readonly db: Database.Database;
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root); mkdirSync(this.root, { recursive: true });
    this.db = new Database(join(this.root, 'library.sqlite'));
    this.db.pragma('busy_timeout = 5000'); this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, vod_id TEXT NOT NULL, title TEXT NOT NULL, cover TEXT NOT NULL DEFAULT '',
        favorite INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 1, error TEXT, updated_at INTEGER NOT NULL,
        next_check INTEGER NOT NULL DEFAULT 0, cleanup_through INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), episode_key TEXT NOT NULL, title TEXT NOT NULL,
        ordinal INTEGER NOT NULL, url TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        completed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
        error TEXT, entry TEXT, owner TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, UNIQUE(item_id, episode_key)
      );
      CREATE INDEX IF NOT EXISTS episode_queue ON episodes(status, retry_at, lease_until);
      CREATE TABLE IF NOT EXISTS progress (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id), position REAL NOT NULL, duration REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_status (id INTEGER PRIMARY KEY CHECK(id=1), heartbeat INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS online_progress (id TEXT PRIMARY KEY, position REAL NOT NULL, duration REAL NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO revisions VALUES(1,0);
      PRAGMA user_version = 1;
    `);
    for (const table of ['items', 'episodes', 'progress', 'history']) for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS revision_${table}_${event} AFTER ${event} ON ${table} BEGIN UPDATE revisions SET value=value+1 WHERE id=1; END;`);
    }
  }
  close() { this.db.close(); }
  private row(sql: string, ...args: (string | number)[]) { return this.db.prepare(sql).get(...args) as Row | undefined; }
  private rows(sql: string, ...args: (string | number)[]) { return this.db.prepare(sql).all(...args) as Row[]; }
  private itemFrom(row: Row): LibraryItem {
    return { id: String(row.id), source: JSON.parse(String(row.source)), vodId: String(row.vod_id), title: String(row.title), cover: String(row.cover), favorite: !!row.favorite, generation: Number(row.generation), error: row.error as string | null, updatedAt: Number(row.updated_at), nextCheck: Number(row.next_check), cleanupThrough: Number(row.cleanup_through), episodes: this.episodes(String(row.id)) };
  }
  get(id: string) { const row = this.row('SELECT * FROM items WHERE id=?', id); return row ? this.itemFrom(row) : null; }
  list() { return this.rows('SELECT * FROM items WHERE favorite=1 ORDER BY updated_at DESC').map(r => this.itemFrom(r)); }
  episodes(id: string): LibraryEpisode[] {
    return this.rows('SELECT e.*,p.position,p.duration,p.updated_at AS progress_at FROM episodes e LEFT JOIN progress p ON p.episode_id=e.id WHERE item_id=? ORDER BY ordinal', id).map(r => ({ id: String(r.id), itemId: String(r.item_id), episodeKey: String(r.episode_key), title: String(r.title), ordinal: Number(r.ordinal), url: String(r.url), generation: Number(r.generation), status: r.status as LibraryEpisode['status'], completed: Number(r.completed), total: Number(r.total), bytes: Number(r.bytes), error: r.error as string | null, entry: r.entry as string | null, position: Number(r.position || 0), duration: Number(r.duration || 0), progressUpdatedAt: Number(r.progress_at || 0) }));
  }
  episode(id: string) { const row = this.row('SELECT item_id FROM episodes WHERE id=?', id); return row ? this.episodes(String(row.item_id)).find(e => e.id === id)! : null; }
  favorite(source: SourceConfig, vodId: string, title: string, cover = '') {
    const id = libraryId(source.url, vodId), now = Date.now();
    this.db.transaction(() => {
      const old = this.row('SELECT * FROM items WHERE id=?', id);
      if (!old) this.db.prepare('INSERT INTO items(id,source,vod_id,title,cover,updated_at) VALUES(?,?,?,?,?,?)').run(id, JSON.stringify(source), vodId, title, cover, now);
      else if (!old.favorite) {
        this.db.prepare('UPDATE items SET favorite=1,generation=generation+1,source=?,title=?,cover=?,next_check=0,error=NULL,updated_at=? WHERE id=?').run(JSON.stringify(source), title, cover, now, id);
        this.db.prepare("UPDATE episodes SET generation=(SELECT generation FROM items WHERE id=?),status='queued',owner='',lease_until=0,attempts=0,retry_at=0,entry=NULL,error=NULL,completed=0,total=0,bytes=0 WHERE item_id=?").run(id, id);
      }
    })();
    return this.get(id)!;
  }
  unfavorite(id: string) {
    this.db.transaction(() => {
      this.db.prepare('UPDATE items SET favorite=0,cleanup_through=MAX(cleanup_through,generation),generation=generation+1,updated_at=? WHERE id=? AND favorite=1').run(Date.now(), id);
      this.db.prepare("UPDATE episodes SET status='cancelled',owner='',lease_until=0 WHERE item_id=?").run(id);
    })();
  }
  syncEpisodes(id: string, generation: number, episodes: CatalogEpisode[]) {
    if (new Set(episodes.map(e => e.key)).size !== episodes.length) throw new Error('来源存在重复集名，无法安全追更');
    this.db.transaction(() => {
      if (!this.row('SELECT id FROM items WHERE id=? AND favorite=1 AND generation=?', id, generation)) return;
      const upsert = this.db.prepare(`INSERT INTO episodes(id,item_id,episode_key,title,ordinal,url,generation) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(item_id,episode_key) DO UPDATE SET title=excluded.title,ordinal=excluded.ordinal,url=excluded.url`);
      const item = this.get(id)!;
      episodes.forEach((e, i) => {
        const episodeId = hash(`${id}\n${e.key}`); upsert.run(episodeId, id, e.key, e.title, i, e.url, generation);
        const old = this.onlineProgress(item.source.url, item.vodId, i);
        if (old) this.db.prepare('INSERT OR IGNORE INTO progress VALUES(?,?,?,?)').run(episodeId, old.position, old.duration, Date.now());
      });
      this.db.prepare('UPDATE items SET next_check=?,error=NULL WHERE id=?').run(Date.now() + this.refreshInterval, id);
    })();
  }
  get refreshInterval() { return Math.max(60_000, Number(process.env.LIBRARY_REFRESH_MS) || 1_800_000); }
  due() { return this.rows('SELECT * FROM items WHERE favorite=1 AND next_check<=? ORDER BY next_check LIMIT 10', Date.now()).map(r => this.itemFrom(r)); }
  catalogError(item: LibraryItem, message: string) { this.db.prepare('UPDATE items SET error=?,next_check=? WHERE id=? AND generation=?').run(message, Date.now() + 60_000, item.id, item.generation); }
  claim(owner: string): DownloadJob | null {
    return this.db.transaction(() => {
      const now = Date.now();
      const row = this.row(`SELECT e.* FROM episodes e JOIN items i ON i.id=e.item_id
        WHERE i.favorite=1 AND i.generation=e.generation AND ((e.status IN ('queued','error','paused') AND e.retry_at<=? AND e.attempts<5) OR (e.status='downloading' AND e.lease_until<?)) ORDER BY i.updated_at DESC,e.ordinal LIMIT 1`, now, now);
      if (!row) return null;
      this.db.prepare("UPDATE episodes SET status='downloading',owner=?,lease_until=?,attempts=attempts+1,error=NULL WHERE id=?").run(owner, now + 30_000, row.id);
      return { ...this.episode(String(row.id))!, owner, leaseUntil: now + 30_000, attempts: Number(row.attempts) + 1 };
    }).immediate();
  }
  active(job: DownloadJob) { return !!this.row(`SELECT e.id FROM episodes e JOIN items i ON i.id=e.item_id WHERE e.id=? AND e.owner=? AND e.status='downloading' AND e.generation=? AND i.generation=e.generation AND i.favorite=1 AND e.lease_until>?`, job.id, job.owner, job.generation, Date.now()); }
  withLease<T>(job: DownloadJob, action: () => T): T {
    return this.db.transaction(() => { if (!this.active(job)) throw new Error('任务已取消或租约已失效'); return action(); }).immediate();
  }
  heartbeat(job: DownloadJob) { if (this.active(job)) this.db.prepare('UPDATE episodes SET lease_until=? WHERE id=? AND owner=?').run(Date.now() + 30_000, job.id, job.owner); }
  complete(job: DownloadJob, entry: string) {
    return this.db.transaction(() => {
      if (!this.active(job)) return false;
      this.db.prepare("UPDATE episodes SET status='ready',entry=?,owner='',lease_until=0,error=NULL WHERE id=?").run(entry, job.id); return true;
    }).immediate();
  }
  downloaded(job: DownloadJob, completed: number, total: number, bytes: number) {
    this.withLease(job, () => this.db.prepare('UPDATE episodes SET completed=?,total=?,bytes=? WHERE id=?').run(completed, total, bytes, job.id));
  }
  fail(job: DownloadJob, message: string, paused = false) {
    if (this.active(job) && !paused) this.db.prepare('UPDATE items SET next_check=0 WHERE id=? AND generation=?').run(job.itemId, job.generation);
    if (this.active(job)) this.db.prepare('UPDATE episodes SET status=?,error=?,owner=\'\',lease_until=0,retry_at=?,attempts=CASE WHEN ? THEN MAX(0,attempts-1) ELSE attempts END WHERE id=? AND owner=?').run(paused ? 'paused' : 'error', message, Date.now() + (paused ? 60_000 : Math.min(1_800_000, 10_000 * 2 ** job.attempts)), paused ? 1 : 0, job.id, job.owner);
  }
  retry(id: string) { this.db.prepare("UPDATE episodes SET status='queued',attempts=0,retry_at=0,error=NULL WHERE item_id=? AND status IN ('error','paused')").run(id); this.db.prepare('UPDATE items SET next_check=0,error=NULL WHERE id=? AND favorite=1').run(id); }
  cleanupItems() { return this.rows('SELECT * FROM items WHERE cleanup_through>0').map(r => this.itemFrom(r)); }
  cleaned(id: string, generation: number) { this.db.prepare("UPDATE items SET cleanup_through=0,error=CASE WHEN error='文件清理失败，后台将重试' THEN NULL ELSE error END WHERE id=? AND cleanup_through=?").run(id, generation); }
  cleanupError(id: string) { this.db.prepare("UPDATE items SET error='文件清理失败，后台将重试' WHERE id=?").run(id); }
  progress(id: string, position: number, duration: number, ended = false) {
    if (!this.episode(id) || !Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
    this.db.transaction(() => {
    const episode = this.episode(id)!;
    const item = this.get(episode.itemId)!;
    this.saveOnlineProgress(item.source.url, item.vodId, episode.ordinal, position, duration, ended);
    this.saveHistory({ sourceKey: item.source.key, sourceUrl: item.source.url, vodId: item.vodId, title: item.title, pic: item.cover, episodeIndex: episode.ordinal, totalEpisodes: item.episodes.length, playbackPosition: ended ? 0 : position, duration, timestamp: Date.now() });
    this.db.prepare('INSERT INTO progress VALUES(?,?,?,?) ON CONFLICT(episode_id) DO UPDATE SET position=excluded.position,duration=excluded.duration,updated_at=excluded.updated_at WHERE excluded.updated_at>=progress.updated_at').run(id, ended ? 0 : Math.max(0, Math.min(position, duration)), duration, Date.now());
    }).immediate();
  }
  historyList(): HistoryEntry[] { return this.rows('SELECT * FROM history ORDER BY updated_at DESC LIMIT 100').map(row => JSON.parse(String(row.payload))); }
  saveHistory(entry: Omit<HistoryEntry, 'id'>, onlyIfMissing = false) {
    this.db.transaction(() => {
    const id = libraryId(entry.sourceUrl || entry.sourceKey, entry.vodId);
    const old = this.row('SELECT payload FROM history WHERE id=?', id);
    if (old && onlyIfMissing) return;
    const previous = old ? JSON.parse(String(old.payload)) as HistoryEntry : null;
    const progress = this.onlineProgress(entry.sourceUrl || entry.sourceKey, entry.vodId, entry.episodeIndex);
    const data = { ...previous, ...entry, id, timestamp: Date.now(), playbackPosition: entry.playbackPosition > 0 ? entry.playbackPosition : progress?.position ?? (previous?.episodeIndex === entry.episodeIndex ? previous.playbackPosition : 0), duration: entry.duration || progress?.duration || previous?.duration || 0 };
    this.db.prepare('INSERT INTO history VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(id, JSON.stringify(data), data.timestamp);
    this.db.prepare('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY updated_at DESC LIMIT 100)').run();
    }).immediate();
  }
  removeHistory(id?: string) {
    this.db.transaction(() => {
      if (id) { this.db.prepare('DELETE FROM history WHERE id=?').run(id); this.db.prepare('DELETE FROM online_progress WHERE id LIKE ?').run(id + ':%'); this.db.prepare('DELETE FROM progress WHERE episode_id IN (SELECT id FROM episodes WHERE item_id=?)').run(id); }
      else { this.db.prepare('DELETE FROM history').run(); this.db.prepare('DELETE FROM online_progress').run(); this.db.prepare('DELETE FROM progress').run(); }
    })();
  }
  onlineProgress(sourceUrl: string, vodId: string, index: number): { position: number; duration: number } | null {
    return this.row('SELECT position,duration FROM online_progress WHERE id=?', `${libraryId(sourceUrl, vodId)}:${index}`) as { position: number; duration: number } | undefined ?? null;
  }
  saveOnlineProgress(sourceUrl: string, vodId: string, index: number, position: number, duration: number, ended = false) {
    if (![position, duration].every(Number.isFinite) || duration <= 0 || index < 0 || !Number.isSafeInteger(index)) return;
    this.db.transaction(() => {
    const id = libraryId(sourceUrl, vodId), value = ended ? 0 : Math.max(0, Math.min(position, duration));
    this.db.prepare('INSERT INTO online_progress VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,duration=excluded.duration,updated_at=excluded.updated_at').run(`${id}:${index}`, value, duration, Date.now());
    const row = this.row('SELECT payload FROM history WHERE id=?', id);
    if (row) {
      const payload = JSON.parse(String(row.payload)) as HistoryEntry;
      payload.playbackPosition = value; payload.duration = duration; payload.episodeIndex = index; payload.timestamp = Date.now();
      this.db.prepare('UPDATE history SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(payload), payload.timestamp, id);
    }
    }).immediate();
  }
  health(error: string | null = null) { this.db.prepare('INSERT INTO worker_status VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat,error=excluded.error').run(Date.now(), error); }
  revision() { return Number(this.row('SELECT value FROM revisions WHERE id=1')?.value || 0); }
  invalidateAsset(id: string, generation: number) { this.db.prepare("UPDATE episodes SET status='queued',entry=NULL,error='本地文件缺失，等待重新下载',attempts=0,retry_at=0 WHERE id=? AND generation=? AND status='ready'").run(id, generation); }
  workerHealth() { return this.row('SELECT heartbeat,error FROM worker_status WHERE id=1') ?? null; }
}
let singleton: LibraryStore | undefined;
export function libraryStore() { return singleton ??= new LibraryStore(process.env.LIBRARY_DATA_DIR || join(process.cwd(), '.libretv')); }
