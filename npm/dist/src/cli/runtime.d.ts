export type MonadRecordStatus = "starting" | "running" | "stopped" | "dead";
export interface MonadRecord {
    name: string;
    identity: string;
    namespace: string;
    surface: string;
    port: number;
    pid: number;
    endpoint: string;
    cwd: string;
    startedAt: string;
    updatedAt: string;
    status: MonadRecordStatus;
    runtimeDir: string;
    stateDir: string;
    claimDir: string;
    selfConfigPath: string;
    stdoutLog: string;
    stderrLog: string;
}
export interface StartMonadCliOptions {
    name?: string;
    port?: number;
    namespace?: string;
    cwd?: string;
    seed?: string;
}
export interface MonadRuntimeStatus {
    record: MonadRecord;
    pidAlive: boolean;
    healthy: boolean;
    status: MonadRecordStatus;
    surface?: unknown;
    error?: string;
}
export interface FollowMonadLogsOptions {
    lines?: number;
    intervalMs?: number;
    signal?: AbortSignal;
    includeStderr?: boolean;
}
export declare function getMonadsHome(): string;
export declare function normalizeMonadName(input?: string): string;
export declare function getMonadRuntimeDir(name: string): string;
export declare function readMonadRecord(name: string): Promise<MonadRecord | null>;
export declare function listMonadRecords(): Promise<MonadRecord[]>;
export declare function listRunningMonads(): Promise<MonadRuntimeStatus[]>;
export declare function getMonadStatus(record: MonadRecord): Promise<MonadRuntimeStatus>;
export declare function startMonadProcess(options?: StartMonadCliOptions): Promise<MonadRuntimeStatus>;
export declare function stopMonadProcess(name: string): Promise<MonadRuntimeStatus>;
export declare function readLogTail(record: MonadRecord, stream?: "stdout" | "stderr", lines?: number): Promise<string>;
export declare function followMonadLogs(record: MonadRecord, options?: FollowMonadLogsOptions): Promise<void>;
