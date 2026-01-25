/**
 * In-Memory Storage Adapter.
 * Useful for local development and testing.
 * Note: Data is lost when the process restarts.
 */

import type { KVStorage, StorageItem, SetOptions, ListOptions, ListResult } from './types.js';

export class MemoryStorage implements KVStorage {
  private store: Map<string, StorageItem<unknown>>;
  private keyPrefix: string;

  constructor(keyPrefix: string = '') {
    this.store = new Map();
    this.keyPrefix = keyPrefix;
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
    const prefixedKey = this.prefixKey(key);
    const item = this.store.get(prefixedKey) as StorageItem<T> | undefined;

    if (!item) {
      return null;
    }

    if (this.isExpired(item)) {
      this.store.delete(prefixedKey);
      return null;
    }

    return item;
  }

  async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
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

    this.store.set(prefixedKey, item);
  }

  async delete(key: string): Promise<boolean> {
    const prefixedKey = this.prefixKey(key);
    return this.store.delete(prefixedKey);
  }

  async exists(key: string): Promise<boolean> {
    const item = await this.getWithMetadata(key);
    return item !== null;
  }

  async list<T = unknown>(options?: ListOptions): Promise<ListResult<T>> {
    // Clean up expired items first.
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
    const fullPrefix = this.prefixKey(prefix);
    let count = 0;

    for (const key of this.store.keys()) {
      if (key.startsWith(fullPrefix)) {
        this.store.delete(key);
        count++;
      }
    }

    return count;
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  // Helper method for testing: get the size of the store.
  size(): number {
    return this.store.size;
  }

  // Helper method for testing: clear all items.
  clear(): void {
    this.store.clear();
  }
}
