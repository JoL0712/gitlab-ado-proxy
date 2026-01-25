/**
 * Storage Factory.
 * Creates the appropriate storage adapter based on configuration.
 */

import type { KVStorage, StorageConfig } from './types.js';
import { MemoryStorage } from './memory.js';
import { DynamoDBStorage } from './dynamodb.js';

// Singleton storage instance.
let storageInstance: KVStorage | null = null;

/**
 * Create a storage adapter based on configuration.
 */
export function createStorage(config: StorageConfig): KVStorage {
  switch (config.type) {
    case 'memory':
      return new MemoryStorage(config.keyPrefix);

    case 'dynamodb':
      if (!config.tableName) {
        throw new Error('DynamoDB storage requires tableName configuration');
      }
      return new DynamoDBStorage({
        tableName: config.tableName,
        region: config.region,
        keyPrefix: config.keyPrefix,
      });

    case 'redis':
      throw new Error('Redis storage adapter not yet implemented');

    default:
      throw new Error(`Unknown storage type: ${config.type}`);
  }
}

/**
 * Get storage configuration from environment variables.
 */
export function getStorageConfigFromEnv(): StorageConfig {
  const type = (process.env.STORAGE_TYPE as StorageConfig['type']) ?? 'memory';

  return {
    type,
    tableName: process.env.STORAGE_TABLE_NAME ?? process.env.DYNAMODB_TABLE_NAME,
    region: process.env.AWS_REGION ?? process.env.STORAGE_REGION,
    redisUrl: process.env.REDIS_URL ?? process.env.STORAGE_REDIS_URL,
    keyPrefix: process.env.STORAGE_KEY_PREFIX ?? 'gitlab-ado-proxy',
  };
}

/**
 * Get or create the singleton storage instance.
 * Uses environment variables for configuration.
 */
export function getStorage(): KVStorage {
  if (!storageInstance) {
    const config = getStorageConfigFromEnv();
    storageInstance = createStorage(config);
    console.log(`Storage initialized: type=${config.type}, prefix=${config.keyPrefix}`);
  }
  return storageInstance;
}

/**
 * Initialize storage with explicit configuration.
 * Useful for testing or custom setups.
 */
export function initStorage(config: StorageConfig): KVStorage {
  if (storageInstance) {
    console.warn('Storage already initialized, replacing with new instance');
  }
  storageInstance = createStorage(config);
  return storageInstance;
}

/**
 * Close and reset the storage instance.
 */
export async function closeStorage(): Promise<void> {
  if (storageInstance) {
    await storageInstance.close();
    storageInstance = null;
  }
}
