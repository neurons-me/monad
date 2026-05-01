export declare function deriveUnlockKey(namespace: string, secret: string): Buffer;
export declare function deriveSecretCommitment(namespace: string, secret: string): string;
export declare function encryptNoise(noise: string, unlockKey: Buffer): string;
export declare function decryptNoise(encryptedData: string, unlockKey: Buffer): string;
