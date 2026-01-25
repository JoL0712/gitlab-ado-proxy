/**
 * Key-Value Storage Types.
 * Provides a cloud-agnostic interface for persistent storage.
 */

/**
 * Storage item with metadata.
 */
export interface StorageItem<T = unknown> {
  // The stored value.
  value: T;
  // Unix timestamp (seconds) when the item expires. Null if no expiration.
  expiresAt: number | null;
  // Unix timestamp (seconds) when the item was created.
  createdAt: number;
  // Unix timestamp (seconds) when the item was last updated.
  updatedAt: number;
}

/**
 * Options for setting a storage item.
 */
export interface SetOptions {
  // Time-to-live in seconds. Item will be automatically deleted after this time.
  ttl?: number;
}

/**
 * Options for listing storage items.
 */
export interface ListOptions {
  // Prefix to filter keys by.
  prefix?: string;
  // Maximum number of items to return.
  limit?: number;
  // Cursor for pagination.
  cursor?: string;
}

/**
 * Result of a list operation.
 */
export interface ListResult<T = unknown> {
  // The items matching the query.
  items: Array<{ key: string; item: StorageItem<T> }>;
  // Cursor for the next page, if there are more results.
  nextCursor?: string;
}

/**
 * Key-Value Storage Interface.
 * All storage adapters must implement this interface.
 */
export interface KVStorage {
  /**
   * Get an item by key.
   * Returns null if the item doesn't exist or has expired.
   */
  get<T = unknown>(key: string): Promise<T | null>;

  /**
   * Get an item with its metadata.
   * Returns null if the item doesn't exist or has expired.
   */
  getWithMetadata<T = unknown>(key: string): Promise<StorageItem<T> | null>;

  /**
   * Set an item by key.
   * If the item already exists, it will be overwritten.
   */
  set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void>;

  /**
   * Delete an item by key.
   * Returns true if the item was deleted, false if it didn't exist.
   */
  delete(key: string): Promise<boolean>;

  /**
   * Check if an item exists (and is not expired).
   */
  exists(key: string): Promise<boolean>;

  /**
   * List items with optional filtering.
   */
  list<T = unknown>(options?: ListOptions): Promise<ListResult<T>>;

  /**
   * Delete multiple items by key prefix.
   * Returns the number of items deleted.
   */
  deleteByPrefix(prefix: string): Promise<number>;

  /**
   * Close the storage connection (cleanup).
   */
  close(): Promise<void>;
}

/**
 * Storage configuration.
 */
export interface StorageConfig {
  // Storage adapter type.
  type: 'memory' | 'file' | 'dynamodb' | 'redis';
  // Path to JSON file for file adapter (local development).
  filePath?: string;
  // Table/bucket name for cloud storage.
  tableName?: string;
  // AWS region for DynamoDB.
  region?: string;
  // Redis URL for Redis adapter.
  redisUrl?: string;
  // Key prefix for namespacing.
  keyPrefix?: string;
}
