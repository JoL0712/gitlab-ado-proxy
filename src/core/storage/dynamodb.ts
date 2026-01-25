/**
 * DynamoDB Storage Adapter.
 * Designed for AWS Lambda and serverless environments.
 * Uses a single table design with TTL support.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { KVStorage, StorageItem, SetOptions, ListOptions, ListResult } from './types.js';

export interface DynamoDBStorageConfig {
  // DynamoDB table name.
  tableName: string;
  // AWS region.
  region?: string;
  // Optional key prefix for namespacing.
  keyPrefix?: string;
  // Optional endpoint for local development (e.g., DynamoDB Local).
  endpoint?: string;
}

/**
 * DynamoDB table schema:
 * - pk (Partition Key): string - The item key
 * - value: any - The stored value (JSON serialized)
 * - expiresAt: number | null - TTL timestamp (seconds)
 * - createdAt: number - Creation timestamp (seconds)
 * - updatedAt: number - Last update timestamp (seconds)
 * - ttl: number - DynamoDB TTL attribute (same as expiresAt)
 */

export class DynamoDBStorage implements KVStorage {
  private client: DynamoDBDocumentClient;
  private tableName: string;
  private keyPrefix: string;

  constructor(config: DynamoDBStorageConfig) {
    const dynamoClient = new DynamoDBClient({
      region: config.region ?? process.env.AWS_REGION ?? 'us-east-1',
      endpoint: config.endpoint,
    });

    this.client = DynamoDBDocumentClient.from(dynamoClient, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });

    this.tableName = config.tableName;
    this.keyPrefix = config.keyPrefix ?? '';
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

  private isExpired(expiresAt: number | null): boolean {
    if (expiresAt === null) {
      return false;
    }
    return Date.now() / 1000 > expiresAt;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const item = await this.getWithMetadata<T>(key);
    return item?.value ?? null;
  }

  async getWithMetadata<T = unknown>(key: string): Promise<StorageItem<T> | null> {
    const prefixedKey = this.prefixKey(key);

    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: prefixedKey },
        })
      );

      if (!result.Item) {
        return null;
      }

      const item = result.Item;

      // Check if expired (DynamoDB TTL may have delay).
      if (this.isExpired(item.expiresAt)) {
        return null;
      }

      return {
        value: item.value as T,
        expiresAt: item.expiresAt ?? null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    } catch (error) {
      console.error('DynamoDB get error:', error);
      throw error;
    }
  }

  async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    const prefixedKey = this.prefixKey(key);
    const now = Math.floor(Date.now() / 1000);

    // Try to get existing item for createdAt.
    let createdAt = now;
    try {
      const existing = await this.getWithMetadata(key);
      if (existing) {
        createdAt = existing.createdAt;
      }
    } catch {
      // Ignore errors, use current time.
    }

    const expiresAt = options?.ttl ? now + options.ttl : null;

    const item: Record<string, unknown> = {
      pk: prefixedKey,
      value,
      expiresAt,
      createdAt,
      updatedAt: now,
    };

    // Set TTL attribute for DynamoDB automatic deletion.
    if (expiresAt !== null) {
      item.ttl = expiresAt;
    }

    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
        })
      );
    } catch (error) {
      console.error('DynamoDB set error:', error);
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    const prefixedKey = this.prefixKey(key);

    try {
      // Check if item exists first.
      const existing = await this.get(key);
      if (existing === null) {
        return false;
      }

      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: prefixedKey },
        })
      );

      return true;
    } catch (error) {
      console.error('DynamoDB delete error:', error);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const item = await this.get(key);
    return item !== null;
  }

  async list<T = unknown>(options?: ListOptions): Promise<ListResult<T>> {
    const prefix = options?.prefix ? this.prefixKey(options.prefix) : this.keyPrefix;
    const limit = options?.limit ?? 100;

    try {
      // Use Scan with filter for prefix matching.
      // Note: For large tables, consider using a GSI with a prefix-based partition key.
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'begins_with(pk, :prefix)',
          ExpressionAttributeValues: {
            ':prefix': prefix || '',
          },
          Limit: limit,
          ExclusiveStartKey: options?.cursor
            ? JSON.parse(Buffer.from(options.cursor, 'base64').toString())
            : undefined,
        })
      );

      const now = Math.floor(Date.now() / 1000);
      const items: Array<{ key: string; item: StorageItem<T> }> = [];

      for (const record of result.Items ?? []) {
        // Filter out expired items.
        if (record.expiresAt && record.expiresAt < now) {
          continue;
        }

        items.push({
          key: this.unprefixKey(record.pk as string),
          item: {
            value: record.value as T,
            expiresAt: record.expiresAt ?? null,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
        });
      }

      const nextCursor = result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : undefined;

      return { items, nextCursor };
    } catch (error) {
      // If Query fails (e.g., no GSI), fall back to Scan.
      console.warn('DynamoDB Query failed, falling back to Scan:', error);
      return this.listWithScan<T>(options);
    }
  }

  private async listWithScan<T = unknown>(options?: ListOptions): Promise<ListResult<T>> {
    const prefix = options?.prefix ? this.prefixKey(options.prefix) : this.keyPrefix;
    const limit = options?.limit ?? 100;

    // Scan is less efficient but works without GSI.
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');

    const result = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: prefix ? 'begins_with(pk, :prefix)' : undefined,
        ExpressionAttributeValues: prefix ? { ':prefix': prefix } : undefined,
        Limit: limit,
        ExclusiveStartKey: options?.cursor
          ? JSON.parse(Buffer.from(options.cursor, 'base64').toString())
          : undefined,
      })
    );

    const now = Math.floor(Date.now() / 1000);
    const items: Array<{ key: string; item: StorageItem<T> }> = [];

    for (const record of result.Items ?? []) {
      // Filter out expired items.
      if (record.expiresAt && record.expiresAt < now) {
        continue;
      }

      items.push({
        key: this.unprefixKey(record.pk as string),
        item: {
          value: record.value as T,
          expiresAt: record.expiresAt ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    }

    const nextCursor = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : undefined;

    return { items, nextCursor };
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const fullPrefix = this.prefixKey(prefix);
    let count = 0;
    let cursor: string | undefined;

    do {
      const result = await this.listWithScan({ prefix: fullPrefix, limit: 25, cursor });

      if (result.items.length === 0) {
        break;
      }

      // Batch delete items (max 25 per batch).
      const deleteRequests = result.items.map((item) => ({
        DeleteRequest: {
          Key: { pk: this.prefixKey(item.key) },
        },
      }));

      await this.client.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.tableName]: deleteRequests,
          },
        })
      );

      count += result.items.length;
      cursor = result.nextCursor;
    } while (cursor);

    return count;
  }

  async close(): Promise<void> {
    // DynamoDB client doesn't need explicit cleanup.
    this.client.destroy();
  }
}
