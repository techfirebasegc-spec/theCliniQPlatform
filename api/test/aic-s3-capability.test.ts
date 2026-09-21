import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AicS3StorageProvider, aicS3Configuration, isAicS3NotFound } from '../src/modules/files/aic-s3-storage-provider.js';

const environment = {
  AIC_S3_ENDPOINT: process.env.AIC_S3_ENDPOINT,
  AIC_S3_REGION: process.env.AIC_S3_REGION,
  AIC_S3_BUCKET: process.env.AIC_S3_BUCKET,
  AIC_S3_ACCESS_KEY_ID: process.env.AIC_S3_ACCESS_KEY_ID,
  AIC_S3_SECRET_ACCESS_KEY: process.env.AIC_S3_SECRET_ACCESS_KEY,
};
const configuration = aicS3Configuration(environment);

describe('AIC S3 capability verification', () => {
  if (!configuration) {
    it.skip('requires configured server-only AIC credentials', () => {});
    return;
  }

  it('puts, heads, gets, deletes, and confirms deletion of a private temporary object', async () => {
    const provider = AicS3StorageProvider.fromEnvironment(environment)!;
    const key = `phase71c-verify/${randomUUID()}/probe.txt`;
    const content = new TextEncoder().encode('Phase 7.1C AIC verification');
    let uploaded = false;
    let deleted = false;
    let operationError: unknown;
    let cleanupFailed = false;

    try {
      await provider.putObject(key, content, { contentType: 'text/plain', metadata: { phase: '7.1c' } });
      uploaded = true;

      const head = await provider.headObject(key);
      expect(head.contentLength).toBe(content.byteLength);
      expect(head.contentType).toBe('text/plain');
      expect(head.metadata.phase).toBe('7.1c');

      const object = await provider.getObject(key);
      expect(Buffer.from(object.body)).toEqual(Buffer.from(content));

      const anonymousUrl = new URL(`${configuration.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`, `${configuration.endpoint}/`);
      const anonymousResponse = await fetch(anonymousUrl);
      expect(anonymousResponse.ok).toBe(false);

      await provider.deleteObject(key);
      deleted = true;
      try {
        await provider.headObject(key);
        throw new Error('Deleted AIC S3 object remained available.');
      } catch (error) {
        expect(isAicS3NotFound(error)).toBe(true);
      }
    } catch (error) {
      operationError = error;
    } finally {
      if (uploaded && !deleted) {
        try {
          await provider.deleteObject(key);
        } catch {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed) throw new Error(`AIC verification cleanup failed for temporary object ${key}.`);
    if (operationError !== undefined) throw operationError;
  });
});
