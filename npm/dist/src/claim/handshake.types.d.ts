export type HostCapability = 'sync' | 'sign' | 'local_fs' | string;
export type SessionMode = 'cloud' | 'host';
export type HostStatus = 'pending' | 'authorized' | 'revoked';
export type SessionTransport = 'cloud' | 'host-verified';
export interface CleakerSession {
    username: string;
    mode: SessionMode;
    iat: number;
    exp: number;
    capabilities: string[];
    host?: {
        fingerprint: string;
        local_endpoint: string;
        attestation: string;
    };
}
export interface SessionNonceRequest {
    username: string;
}
export interface SessionNonceResponse {
    username: string;
    nonce: string;
    iat: number;
    exp: number;
}
export interface CreateCloudSessionRequest {
    username: string;
    ttlSeconds?: number;
    capabilities?: string[];
}
export interface HostAttestationPayload {
    fingerprint: string;
    local_endpoint: string;
    attestation: string;
    daemonPublicKey: string;
    capabilities?: string[];
    label?: string;
    hostname?: string;
}
export interface VerifyHostSessionRequest {
    username: string;
    nonce: string;
    host: HostAttestationPayload;
    ttlSeconds?: number;
}
export interface RevokeHostRequest {
    username: string;
    hostFingerprint: string;
}
export interface AuthorizedHostRecordV1 {
    username: string;
    hostFingerprint: string;
    hostLabel?: string;
    daemonPublicKey: string;
    capabilities: HostCapability[];
    status: HostStatus;
    createdAt: number;
    updatedAt: number;
    revokedAt?: number;
    lastSeenAt?: number;
}
export interface LocalChallengePayloadV1 {
    hostFingerprint: string;
    challengeNonce: string;
    challengeIssuedAt: string;
    challengeExpiresAt: string;
    daemonSignature: string;
    daemonPublicKey: string;
}
export interface RegisterHostCommandV1 {
    username: string;
    hostFingerprint: string;
    challengeNonce: string;
    challengeSignature: string;
    capabilitiesRequested: HostCapability[];
}
export interface RegisterHostResultV1 {
    authorizationId: string;
    transport: SessionTransport;
    host: AuthorizedHostRecordV1;
}
export interface IssueHostSessionCommandV1 {
    username: string;
    hostFingerprint: string;
    scope: string[];
    ttlSeconds?: number;
}
export interface HostSessionTokenV1 {
    token: string;
    tokenType: 'Bearer';
    username: string;
    hostFingerprint: string;
    transport: SessionTransport;
    issuedAt: string;
    expiresAt: string;
    sessionKeyId: string;
    scope: string[];
}
