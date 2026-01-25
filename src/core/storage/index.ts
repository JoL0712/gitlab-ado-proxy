/**
 * Storage Module.
 * Provides cloud-agnostic key-value storage for serverless environments.
 */

// Types.
export type {
  KVStorage,
  StorageItem,
  SetOptions,
  ListOptions,
  ListResult,
  StorageConfig,
} from './types.js';

// Adapters.
export { MemoryStorage } from './memory.js';
export { DynamoDBStorage } from './dynamodb.js';
export type { DynamoDBStorageConfig } from './dynamodb.js';

// Factory.
export {
  createStorage,
  getStorage,
  initStorage,
  closeStorage,
  getStorageConfigFromEnv,
} from './factory.js';
