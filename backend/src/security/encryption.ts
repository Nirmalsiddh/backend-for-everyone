import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedPayload {
  encryptedConfig: string;
  encryptionIv: string;
  encryptionTag: string;
  encryptionVersion: number;
}

export class CredentialEncryption {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(hexKey)) throw new Error('Invalid credential encryption key');
    this.key = Buffer.from(hexKey, 'hex');
  }

  encrypt(value: unknown, context: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`v1:${context}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return {
      encryptedConfig: encrypted.toString('base64'),
      encryptionIv: iv.toString('base64'),
      encryptionTag: cipher.getAuthTag().toString('base64'),
      encryptionVersion: 1,
    };
  }

  decrypt<T>(payload: EncryptedPayload, context: string): T {
    try {
      if (payload.encryptionVersion !== 1) throw new Error();
      const iv = Buffer.from(payload.encryptionIv, 'base64');
      const tag = Buffer.from(payload.encryptionTag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`v1:${context}`));
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(payload.encryptedConfig, 'base64')), decipher.final(),
      ]).toString('utf8')) as T;
    } catch {
      throw new Error('Credential decryption failed');
    }
  }
}
