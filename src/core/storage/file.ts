/**
 * File-Based Storage Adapter.
 * Persists to a JSON file for local development so data survives server restarts.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { KVStorage, StorageItem, SetOptions, ListOptions, ListResult } from './types.js';

const DEFAULT_FILE_PATH = '.data/storage.json';

export interface FileStorageConfig {
  // Path to the JSON file. Directory is created if missing.
  filePath?: string;
  // Optional key prefix for namespacing.
  keyPrefix?: string;
}

/**
 * Persisted shape: array of [key, item] for JSON serialization.
 */
type PersistedEntries = Array<[string, StorageItem<unknown>]>;

export class FileStorage implements KVStorage {
  private store: Map<string, StorageItem<unknown>>;
  private keyPrefix: string;
  private filePath: string;
  private writeScheduled: ReturnType<typeof setImmediate> | null = null;
  private loaded = false;

  constructor(config: FileStorageConfig = {}) {
    this.filePath = config.filePath ?? DEFAULT_FILE_PATH;
    this.keyPrefix = config.keyPrefix ?? '';
    this.store = new Map();
  }

  private prefixKey(key: string): string {
    return this.keyPrefix ? `${this.keyPrefix}:${key}` : key;
  }

  private unprefixKey(key: string): string {
    if (this.keyPrefix && key.startsWith(`${this.keyPrefix}:`)) {
      return key.slice(this.keyPrefix.length + 1);
    }
    return key;
  }

  private isExpired(item: StorageItem<unknown>): boolean {
    if (item.expiresAt === null) {
      return false;
    }
    return Date.now() / 1000 > item.expiresAt;
  }

  /**
   * Load state from disk. Call once before use (e.g. in get/list or via init).
   */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const entries = JSON.parse(raw) as PersistedEntries;
      this.store = new Map(entries);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code === 'ENOENT') {
        this.store = new Map();
        return;
      }
      throw err;
    }
  }

  /**
   * Persist current store to disk. Debounced so rapid writes don't thrash the file.
   */
  private schedulePersist(): void {
    if (this.writeScheduled !== null) {
      return;
    }
    this.writeScheduled = setImmediate(() => {
      this.writeScheduled = null;
      this.persist().catch((err) => {
        console.error('[FileStorage] Failed to persist:', err);
      });
    });
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const entries: PersistedEntries = Array.from(this.store.entries());
    await writeFile(this.filePath, JSON.stringify(entries), 'utf-8');
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
      this.loaded = true;
    }
  }

  private cleanupExpired(): void {
    const now = Date.now() / 1000;
    for (const [key, item] of this.store.entries()) {
      if (item.expiresAt !== null && now > item.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const item = await this.getWithMetadata<T>(key);
    return item?.value ?? null;
  }

  async getWithMetadata<T = unknown>(key: string): Promise<StorageItem<T> | null> {
    await this.ensureLoaded();
    const prefixedKey = this.prefixKey(key);
    const item = this.store.get(prefixedKey) as StorageItem<T> | undefined;

    if (!item) {
      return null;
    }

    if (this.isExpired(item)) {
      this.store.delete(prefixedKey);
      this.schedulePersist();
      return null;
    }

    return item;
  }

  async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    await this.ensureLoaded();
    const prefixedKey = this.prefixKey(key);
    const now = Date.now() / 1000;

    const existing = this.store.get(prefixedKey);
    const createdAt = existing ? existing.createdAt : now;

    const item: StorageItem<T> = {
      value,
      expiresAt: options?.ttl ? now + options.ttl : null,
      createdAt,
      updatedAt: now,
    };

    this.store.set(prefixedKey, item as StorageItem<unknown>);
    this.schedulePersist();
  }

  async delete(key: string): Promise<boolean> {
    await this.ensureLoaded();
    const prefixedKey = this.prefixKey(key);
    const removed = this.store.delete(prefixedKey);
    if (removed) {
      this.schedulePersist();
    }
    return removed;
  }

  async exists(key: string): Promise<boolean> {
    const item = await this.getWithMetadata(key);
    return item !== null;
  }

  async list<T = unknown>(options?: ListOptions): Promise<ListResult<T>> {
    await this.ensureLoaded();
    this.cleanupExpired();

    const prefix = options?.prefix ? this.prefixKey(options.prefix) : this.keyPrefix;
    const limit = options?.limit ?? 100;
    const cursorIndex = options?.cursor ? parseInt(options.cursor, 10) : 0;

    const allKeys = Array.from(this.store.keys())
      .filter((key) => !prefix || key.startsWith(prefix))
      .sort();

    const paginatedKeys = allKeys.slice(cursorIndex, cursorIndex + limit);

    const items: Array<{ key: string; item: StorageItem<T> }> = [];
    for (const key of paginatedKeys) {
      const item = this.store.get(key) as StorageItem<T>;
      if (item && !this.isExpired(item)) {
        items.push({
          key: this.unprefixKey(key),
          item,
        });
      }
    }

    const nextIndex = cursorIndex + limit;
    const nextCursor = nextIndex < allKeys.length ? String(nextIndex) : undefined;

    return { items, nextCursor };
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    await this.ensureLoaded();
    const fullPrefix = this.prefixKey(prefix);
    let count = 0;

    for (const key of this.store.keys()) {
      if (key.startsWith(fullPrefix)) {
        this.store.delete(key);
        count++;
      }
    }

    if (count > 0) {
      this.schedulePersist();
    }
    return count;
  }

  async close(): Promise<void> {
    if (this.writeScheduled !== null) {
      clearImmediate(this.writeScheduled);
      this.writeScheduled = null;
    }
    await this.persist();
    this.store.clear();
  }
}
