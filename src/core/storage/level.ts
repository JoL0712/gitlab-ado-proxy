/**
 * Level (LevelDB) Storage Adapter.
 * Uses a sorted key-value store for efficient prefix scans and incremental writes.
 */

import { Level } from 'level';
import type { KVStorage, StorageItem, SetOptions, ListOptions, ListResult } from './types.js';

const DEFAULT_LOCATION = '.data/level';

/** Character used to form exclusive upper bound for prefix range scans. */
const PREFIX_END = '\xff';

export interface LevelStorageConfig {
  /** Directory path for the LevelDB store. Created if missing. */
  location?: string;
  /** Optional key prefix for namespacing. */
  keyPrefix?: string;
}

export class LevelStorage implements KVStorage {
  private db: Level<string, StorageItem<unknown>>;
  private keyPrefix: string;

  constructor(config: LevelStorageConfig = {}) {
    this.keyPrefix = config.keyPrefix ?? '';
    this.db = new Level<string, StorageItem<unknown>>(config.location ?? DEFAULT_LOCATION, {
      valueEncoding: 'json',
    });
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

  private isExpired(item: StorageItem<unknown> | null | undefined): boolean {
    if (!item || item.expiresAt === null || item.expiresAt === undefined) {
      return false;
    }
    return Date.now() / 1000 > item.expiresAt;
  }

  /**
   * Check if the raw value from DB is a valid StorageItem.
   */
  private isStorageItem(value: unknown): value is StorageItem<unknown> {
    return (
      value !== null &&
      typeof value === 'object' &&
      'value' in value &&
      'createdAt' in value
    );
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const item = await this.getWithMetadata<T>(key);
    return item?.value ?? null;
  }

  async getWithMetadata<T = unknown>(key: string): Promise<StorageItem<T> | null> {
    const prefixedKey = this.prefixKey(key);

    try {
      const raw = await this.db.get(prefixedKey);

      // Handle legacy data that isn't wrapped in StorageItem format.
      if (!this.isStorageItem(raw)) {
        // Return as-is wrapped in a minimal StorageItem.
        const now = Math.floor(Date.now() / 1000);
        return {
          value: raw as T,
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
        };
      }

      const item = raw as StorageItem<T>;
      if (this.isExpired(item)) {
        await this.db.del(prefixedKey);
        return null;
      }
      return item;
    } catch (err) {
      const notFound = err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'LEVEL_NOT_FOUND';
      if (notFound) {
        return null;
      }
      throw err;
    }
  }

  async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const prefixedKey = this.prefixKey(key);
    const now = Date.now() / 1000;

    let createdAt = now;
    try {
      const existing = (await this.db.get(prefixedKey)) as StorageItem<unknown>;
      createdAt = existing.createdAt;
    } catch {
      // Key missing, keep createdAt as now.
    }

    const item: StorageItem<T> = {
      value,
      expiresAt: options?.ttl ? now + options.ttl : null,
      createdAt,
      updatedAt: now,
    };

    await this.db.put(prefixedKey, item as StorageItem<unknown>);
  }

  async delete(key: string): Promise<boolean> {
    const item = await this.getWithMetadata(key);
    if (!item) {
      return false;
    }
    await this.db.del(this.prefixKey(key));
    return true;
  }

  async exists(key: string): Promise<boolean> {
    const item = await this.getWithMetadata(key);
    return item !== null;
  }

  async list<T = unknown>(options?: ListOptions): Promise<ListResult<T>> {
    const rangePrefix = options?.prefix ? this.prefixKey(options.prefix) : this.keyPrefix;
    const limit = options?.limit ?? 100;
    const cursor = options?.cursor ?? undefined;

    const gte = rangePrefix || undefined;
    const gt = cursor || undefined;
    const lt = rangePrefix ? rangePrefix + PREFIX_END : undefined;

    const it = this.db.iterator({
      gt: gt ?? gte,
      gte: gt ? undefined : gte,
      lt,
      limit: limit + 1,
    });

    const items: Array<{ key: string; item: StorageItem<T> }> = [];
    const batch: Array<[string, StorageItem<unknown>]> = [];

    try {
      for await (const [key, item] of it) {
        batch.push([key, item]);
      }
    } finally {
      await it.close();
    }

    let lastReturnedKey: string | undefined;
    for (const [key, item] of batch) {
      if (!this.isExpired(item)) {
        items.push({
          key: this.unprefixKey(key),
          item: item as StorageItem<T>,
        });
        lastReturnedKey = key;
        if (items.length >= limit) {
          break;
        }
      }
    }

    const nextCursor =
      batch.length > limit && items.length === limit ? lastReturnedKey : undefined;

    return { items, nextCursor };
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const fullPrefix = this.prefixKey(prefix);
    const rangeEnd = fullPrefix + PREFIX_END;
    const keysToDelete: string[] = [];

    const it = this.db.iterator({
      gte: fullPrefix,
      lt: rangeEnd,
    });

    try {
      for await (const [key] of it) {
        keysToDelete.push(key);
      }
    } finally {
      await it.close();
    }

    if (keysToDelete.length === 0) {
      return 0;
    }

    await this.db.batch(keysToDelete.map((key) => ({ type: 'del' as const, key })));
    return keysToDelete.length;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
