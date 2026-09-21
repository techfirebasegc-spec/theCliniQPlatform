import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Environment } from '../../config/environment.js';

type AicS3Environment = Pick<Environment, 'AIC_S3_ENDPOINT' | 'AIC_S3_REGION' | 'AIC_S3_BUCKET' | 'AIC_S3_ACCESS_KEY_ID' | 'AIC_S3_SECRET_ACCESS_KEY'>;

export type AicS3Configuration = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
export type StoredObjectHead = { contentLength: number | null; contentType: string | null; metadata: Record<string, string> };
export type StoredObject = StoredObjectHead & { body: Uint8Array };

export interface StorageProvider {
  putObject(key: string, body: Uint8Array, input?: { contentType?: string; metadata?: Record<string, string> }): Promise<void>;
  headObject(key: string): Promise<StoredObjectHead>;
  getObject(key: string): Promise<StoredObject>;
  deleteObject(key: string): Promise<void>;
}

export class AicS3StorageError extends Error {
  public constructor(public readonly operation: 'PUT' | 'HEAD' | 'GET' | 'DELETE', public readonly providerCode: string, public readonly statusCode: number | null) {
    super(`AIC S3 ${operation} failed (${providerCode}).`);
  }
}

export function aicS3Configuration(environment: AicS3Environment): AicS3Configuration | null {
  const values = [environment.AIC_S3_ENDPOINT, environment.AIC_S3_REGION, environment.AIC_S3_BUCKET, environment.AIC_S3_ACCESS_KEY_ID, environment.AIC_S3_SECRET_ACCESS_KEY];
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => value === undefined)) throw new Error('AIC S3 configuration must be configured together.');
  return {
    endpoint: environment.AIC_S3_ENDPOINT!, region: environment.AIC_S3_REGION!, bucket: environment.AIC_S3_BUCKET!, accessKeyId: environment.AIC_S3_ACCESS_KEY_ID!, secretAccessKey: environment.AIC_S3_SECRET_ACCESS_KEY!,
  };
}

export function isAicS3NotFound(error: unknown): boolean {
  return error instanceof AicS3StorageError && (error.statusCode === 404 || error.providerCode === 'NotFound' || error.providerCode === 'NoSuchKey');
}

export class AicS3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  private constructor(private readonly configuration: AicS3Configuration) {
    this.client = new S3Client({ endpoint: configuration.endpoint, region: configuration.region, forcePathStyle: true, credentials: { accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey } });
  }

  public static fromEnvironment(environment: AicS3Environment): AicS3StorageProvider | null {
    const configuration = aicS3Configuration(environment);
    return configuration ? new AicS3StorageProvider(configuration) : null;
  }

  public async putObject(key: string, body: Uint8Array, input: { contentType?: string; metadata?: Record<string, string> } = {}): Promise<void> {
    await this.execute('PUT', () => this.client.send(new PutObjectCommand({ Bucket: this.configuration.bucket, Key: key, Body: body, ContentType: input.contentType, Metadata: input.metadata })));
  }

  public async headObject(key: string): Promise<StoredObjectHead> {
    const result = await this.execute('HEAD', () => this.client.send(new HeadObjectCommand({ Bucket: this.configuration.bucket, Key: key })));
    return { contentLength: result.ContentLength ?? null, contentType: result.ContentType ?? null, metadata: result.Metadata ?? {} };
  }

  public async getObject(key: string): Promise<StoredObject> {
    const result = await this.execute('GET', () => this.client.send(new GetObjectCommand({ Bucket: this.configuration.bucket, Key: key })));
    if (!result.Body) throw new AicS3StorageError('GET', 'EMPTY_BODY', null);
    return { body: await result.Body.transformToByteArray(), contentLength: result.ContentLength ?? null, contentType: result.ContentType ?? null, metadata: result.Metadata ?? {} };
  }

  public async deleteObject(key: string): Promise<void> {
    await this.execute('DELETE', () => this.client.send(new DeleteObjectCommand({ Bucket: this.configuration.bucket, Key: key })));
  }

  private async execute<T>(operation: AicS3StorageError['operation'], action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof AicS3StorageError) throw error;
      const source = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown; requestId?: unknown } };
      const providerCode = typeof source.name === 'string' ? source.name : 'UNKNOWN';
      const statusCode = typeof source.$metadata?.httpStatusCode === 'number' ? source.$metadata.httpStatusCode : null;
      throw new AicS3StorageError(operation, providerCode, statusCode);
    }
  }
}
