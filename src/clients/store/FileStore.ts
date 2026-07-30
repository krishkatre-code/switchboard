import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Store } from "./Store";
import type { Override, Vote, RecentSearch } from "../../orchestrator/types";
import { log } from "../../util/logger";

/** Minimal promise mutex so read-modify-write / appends never interleave. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive regardless of fn's outcome.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/**
 * Local file-backed store — a bridge until the shared Quick REST backend is wired up.
 *   - overrides       → JSON array (read-modify-write, mutex-guarded; supports delete)
 *   - feedback        → append-only JSONL (concurrency-safe additive writes)
 *   - recent_searches → append-only JSONL
 * `recent(limit)` returns newest-first to mirror the web app's `orderBy(created_at,"desc")`.
 */
export class FileStore implements Store {
  private readonly dir: string;
  private readonly overridesFile: string;
  private readonly feedbackFile: string;
  private readonly recentFile: string;
  private readonly ovLock = new Mutex();
  private readonly fbLock = new Mutex();
  private readonly rcLock = new Mutex();

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.overridesFile = path.join(this.dir, "overrides.json");
    this.feedbackFile = path.join(this.dir, "feedback.jsonl");
    this.recentFile = path.join(this.dir, "recent_searches.jsonl");
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async readJsonArray<T>(file: string): Promise<T[]> {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch (e: any) {
      if (e?.code === "ENOENT") return [];
      log.warn(`FileStore: failed to read ${file}`, e?.message ?? e);
      return [];
    }
  }

  private async readJsonl<T>(file: string): Promise<T[]> {
    try {
      const raw = await fs.readFile(file, "utf8");
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as T;
          } catch {
            return null;
          }
        })
        .filter((x): x is T => x != null);
    } catch (e: any) {
      if (e?.code === "ENOENT") return [];
      log.warn(`FileStore: failed to read ${file}`, e?.message ?? e);
      return [];
    }
  }

  private async appendJsonl(file: string, row: unknown): Promise<void> {
    await this.ensureDir();
    await fs.appendFile(file, JSON.stringify(row) + "\n", "utf8");
  }

  overrides = {
    list: async (limit: number): Promise<Override[]> => {
      const rows = await this.readJsonArray<Override>(this.overridesFile);
      // newest-first, matching orderBy(created_at,"desc")
      return rows
        .slice()
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
        .slice(0, limit);
    },
    create: async (o: Override): Promise<void> => {
      await this.ovLock.run(async () => {
        await this.ensureDir();
        const rows = await this.readJsonArray<Override>(this.overridesFile);
        rows.push({
          id: o.id ?? randomUUID(),
          trigger: o.trigger,
          channels: o.channels,
          by: o.by ?? "",
          created_at: o.created_at ?? new Date().toISOString(),
        });
        await fs.writeFile(this.overridesFile, JSON.stringify(rows, null, 2), "utf8");
      });
    },
    delete: async (id: string): Promise<void> => {
      await this.ovLock.run(async () => {
        const rows = await this.readJsonArray<Override>(this.overridesFile);
        const next = rows.filter((r) => r.id !== id);
        await fs.writeFile(this.overridesFile, JSON.stringify(next, null, 2), "utf8");
      });
    },
  };

  feedback = {
    recent: async (limit: number): Promise<Vote[]> => {
      const rows = await this.readJsonl<Vote>(this.feedbackFile);
      return rows.slice(-limit).reverse();
    },
    create: async (v: Vote): Promise<void> => {
      await this.fbLock.run(() =>
        this.appendJsonl(this.feedbackFile, {
          id: v.id ?? randomUUID(),
          channel: v.channel,
          vote: v.vote,
          query: v.query ?? "",
          by: v.by ?? "",
          created_at: v.created_at ?? new Date().toISOString(),
        })
      );
    },
  };

  recent = {
    recent: async (limit: number): Promise<RecentSearch[]> => {
      const rows = await this.readJsonl<RecentSearch>(this.recentFile);
      return rows.slice(-limit).reverse();
    },
    create: async (r: RecentSearch): Promise<void> => {
      await this.rcLock.run(() =>
        this.appendJsonl(this.recentFile, {
          id: r.id ?? randomUUID(),
          query: r.query,
          by: r.by ?? "",
          created_at: r.created_at ?? new Date().toISOString(),
        })
      );
    },
  };
}
