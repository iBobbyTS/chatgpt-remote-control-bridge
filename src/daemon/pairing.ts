/**
 * PairingManager（PLAN S04 ①–③）：每实例的配对生命周期与 status 数据源。
 *
 * 职责：
 * - **enable 自动配对**：实例上线（enrollment 就绪）后自动 `pair(manual_code:true)`，
 *   pending 码（`{code, expiresAt, token}`）原子落盘 `instances/<agent>/pairing.json`。
 * - **续码**：后台定时器检查 expiry，到期未 claim → 重发新码覆盖（每实例同时至多一个 pending）。
 * - **claim 轮询**：`pairStatus({manualPairingCode, remoteControlToken})`（单码语义）→ claimed 后清 pending。
 * - **token 订阅**：订阅 tunnel `"enrollment"` 事件；token 变化时同步 pending 轮询所用 token
 *   与 pairing.json（不残留旧 token，S04 不变量⑤）。
 * - **追加配对**：`requestNewCode()` 强制覆盖旧 pending（多设备并存，无上限）。
 *
 * 并发/失效语义：
 * - 所有会写状态的操作经 `enqueue` 串行；`suspend()`（disable 第 (a) 步）递增代次并置位，
 *   使在途 pair/poll 的结果在落盘/事件前被丢弃（不会在 disable 后补写 pairing.json）。
 * - 所有异步链自带 catch，绝不产生 unhandledRejection。
 *
 * 仅依赖 WhamClient（REST）与 tunnel 的 enrollment 事件，不 import 具体 agent。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BridgeAuthManager } from "../auth/manager.ts";
import { WhamClient } from "../wham/client.ts";
import type { EnrollRemoteServerResponse, RemoteControlClient } from "../wham/protocol.ts";
import { instancePaths } from "./paths.ts";

/** pairing.json 持久化形状（S04 交付物 1；S05 消费）。 */
export interface PairingPending {
  code: string;
  expiresAt: string;
  /** 生成该码时的 enrollment remote_control_token（refresh 后续期同步更新）。 */
  token: string;
}

/** 对外可见的 pending 视图（不含 token）。 */
export interface PairingPendingView {
  code: string;
  expiresAt: string;
}

/** PairingManager.status() / IPC pair-status / daemon status.agents[*].pairing 形状。 */
export interface PairingStatus {
  agentId: string;
  pending: PairingPendingView | null;
  /** 最近一次观测到该 pending 码被 claim（清 pending 后为 true）。 */
  claimed: boolean;
  /** 最近一次 listClients 结果（缓存；pair-status 可刷新）。 */
  clients: RemoteControlClient[];
  clientsRefreshedAt: string | null;
  environmentId: string | null;
  warnings: string[];
}

/** PairingManager 对 tunnel 的最小依赖（结构类型，避免反向耦合具体实现）。 */
export interface PairingTunnel {
  readonly pairToken: string | null;
  readonly enrollmentSnapshot: EnrollRemoteServerResponse | null;
  on(event: "enrollment", listener: (enrollment: EnrollRemoteServerResponse) => void): unknown;
  off(event: "enrollment", listener: (enrollment: EnrollRemoteServerResponse) => void): unknown;
}

export interface PairingManagerOptions {
  agentId: string;
  /** 实例目录（pairing.json / enrollment.json 所在）。 */
  instanceDir: string;
  authManager: BridgeAuthManager;
  baseUrl?: string;
  log?: (line: string) => void;
  /** config enabled 查询（自动配对/续码门控）。 */
  isEnabled: () => boolean;
  /** 实例在线查询。 */
  isOnline: () => boolean;
  /** claim 轮询周期；默认 2000ms。 */
  claimPollIntervalMs?: number;
  /** 续码检查周期；默认 5000ms。 */
  renewalCheckIntervalMs?: number;
  /** 时间源（测试注入）；默认 Date.now。 */
  now?: () => number;
}

const DEFAULT_CLAIM_POLL_MS = 2000;
const DEFAULT_RENEWAL_CHECK_MS = 5000;

/** 读取实例目录的 enrollment.json（容错；无/损坏/缺 environment_id 返回 null）。 */
export async function readEnrollmentFile(
  instanceDir: string,
): Promise<EnrollRemoteServerResponse | null> {
  try {
    const parsed = JSON.parse(
      await readFile(instancePaths(instanceDir).enrollment, "utf8"),
    ) as Partial<EnrollRemoteServerResponse>;
    if (parsed && typeof parsed.environment_id === "string" && parsed.environment_id) {
      return parsed as EnrollRemoteServerResponse;
    }
  } catch {
    // 无记录/损坏：视为无
  }
  return null;
}

export class PairingManager {
  /** 累计 WARN（pair/poll 失败等），供 status 展示。 */
  readonly warnings: string[] = [];
  private readonly opts: PairingManagerOptions;
  private readonly instanceDir: string;
  private readonly pairingPath: string;
  private readonly client: WhamClient;
  private readonly now: () => number;
  private readonly periodMs: number;
  private readonly log: (line: string) => void;
  private tunnel: PairingTunnel | null = null;
  private pending: PairingPending | null = null;
  private claimed = false;
  private environmentId: string | null = null;
  private clients: RemoteControlClient[] = [];
  private clientsRefreshedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private suspended = false;
  private loadedFromDisk = false;
  private generation = 0;
  private opChain: Promise<unknown> = Promise.resolve();
  private readonly enrollmentListener = (enrollment: EnrollRemoteServerResponse): void => {
    if (enrollment?.environment_id) {
      this.environmentId = enrollment.environment_id;
    }
    void this.enqueue((gen) => this.applyToken(gen, enrollment?.remote_control_token)).catch(
      (err) => this.warn(`enrollment 同步失败: ${errorMessage(err)}`),
    );
  };

  constructor(opts: PairingManagerOptions) {
    this.opts = opts;
    this.instanceDir = opts.instanceDir;
    this.pairingPath = instancePaths(opts.instanceDir).pairing;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.periodMs = Math.max(
      1,
      Math.min(
        opts.claimPollIntervalMs ?? DEFAULT_CLAIM_POLL_MS,
        opts.renewalCheckIntervalMs ?? DEFAULT_RENEWAL_CHECK_MS,
      ),
    );
    this.client = new WhamClient({
      authManager: opts.authManager,
      baseUrl: opts.baseUrl,
      installationDir: opts.instanceDir,
    });
  }

  get agentId(): string {
    return this.opts.agentId;
  }

  /** 绑定隧道（首次加载磁盘 pending）并订阅 enrollment 事件。 */
  async attach(tunnel: PairingTunnel): Promise<void> {
    if (this.tunnel && this.tunnel !== tunnel) {
      this.tunnel.off("enrollment", this.enrollmentListener);
    }
    this.tunnel = tunnel;
    tunnel.on("enrollment", this.enrollmentListener);
    const snap = tunnel.enrollmentSnapshot;
    if (snap?.environment_id) {
      this.environmentId = snap.environment_id;
    }
    if (!this.loadedFromDisk) {
      this.loadedFromDisk = true;
      if (!this.pending) {
        await this.loadPending();
      }
    }
    const disk = await readEnrollmentFile(this.instanceDir);
    if (disk?.environment_id) {
      this.environmentId = disk.environment_id;
    }
  }

  /**
   * 实例上线钩子（daemon 在 startInstance/restartInstance 成功后调用）：
   * 启定时器；若无有效 pending 则自动发码（多设备第二次 enable 不重复发）。
   */
  async onInstanceOnline(): Promise<PairingPendingView | null> {
    this.startTimer();
    return this.enqueue(async (gen) => {
      if (this.suspended || gen !== this.generation) return this.view();
      if (!this.safeEnabled() || !this.safeOnline()) return this.view();
      if (this.pending && this.notExpired(this.pending)) return this.view();
      await this.issueCode(gen, "online");
      return this.view();
    });
  }

  /** IPC pair：强制发新码覆盖旧 pending（多设备并存）。返回 null = 未发（未启用/无 token）。 */
  async requestNewCode(): Promise<PairingPendingView | null> {
    return this.enqueue(async (gen) => {
      if (this.suspended || gen !== this.generation) return null;
      if (!this.safeEnabled()) return null;
      const ok = await this.issueCode(gen, "manual");
      return ok ? this.view() : null;
    });
  }

  /** 停止续码/轮询并在途结果作废（disable 第 (a) 步）。 */
  suspend(): void {
    this.generation += 1;
    this.suspended = true;
    this.stopTimer();
  }

  /** 中止 disable 后恢复配对（保持 enabled 的复位）。 */
  resume(): void {
    this.suspended = false;
    if (this.safeEnabled() && this.safeOnline()) {
      this.startTimer();
    }
  }

  /** 实例销毁（disable 完成）：停定时器/取消订阅，不再写盘。 */
  dispose(): void {
    this.generation += 1;
    this.suspended = true;
    this.stopTimer();
    if (this.tunnel) {
      this.tunnel.off("enrollment", this.enrollmentListener);
      this.tunnel = null;
    }
  }

  /** status 数据源；refreshClients=true 时实时 listClients 刷新缓存。 */
  async status(args: { refreshClients?: boolean } = {}): Promise<PairingStatus> {
    if (args.refreshClients) {
      await this.refreshClients();
    }
    return {
      agentId: this.opts.agentId,
      pending: this.view(),
      claimed: this.claimed,
      clients: [...this.clients],
      clientsRefreshedAt: this.clientsRefreshedAt,
      environmentId: this.environmentId,
      warnings: [...this.warnings],
    };
  }

  // -------------------------------------------------------------- 内部操作

  private enqueue<T>(fn: (generation: number) => Promise<T>): Promise<T> {
    const gen = this.generation;
    const task = this.opChain.then(() => fn(gen));
    this.opChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private startTimer(): void {
    if (this.timer || this.suspended) return;
    this.timer = setInterval(() => {
      void this.enqueue((gen) => this.tick(gen)).catch((err) =>
        this.warn(`配对定时检查失败: ${errorMessage(err)}`),
      );
    }, this.periodMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(gen: number): Promise<void> {
    if (this.suspended || gen !== this.generation) return;
    if (!this.safeEnabled() || !this.safeOnline()) return;
    const pending = this.pending;
    if (!pending) return;
    if (!this.notExpired(pending)) {
      await this.issueCode(gen, "expiry");
      return;
    }
    await this.pollClaim(gen, pending);
  }

  private async issueCode(gen: number, reason: string): Promise<boolean> {
    const token = this.currentToken();
    if (!token) {
      this.warn(`无法生成配对码：缺少 remote_control_token（${reason}）`);
      return false;
    }
    let response: {
      pairing_code: string;
      manual_pairing_code: string | null;
      environment_id: string;
      expires_at: string;
    };
    try {
      response = await this.client.pair({ remoteControlToken: token, manualCode: true });
    } catch (err) {
      this.warn(`生成配对码失败（${reason}）: ${errorMessage(err)}`);
      return false;
    }
    if (this.suspended || gen !== this.generation) return false;
    const code = response.manual_pairing_code ?? response.pairing_code;
    if (!code) {
      this.warn(`配对响应缺少 code（${reason}）`);
      return false;
    }
    this.pending = {
      code,
      expiresAt:
        typeof response.expires_at === "string"
          ? response.expires_at
          : new Date(this.now() + 10 * 60_000).toISOString(),
      token,
    };
    this.claimed = false;
    if (response.environment_id) {
      this.environmentId = response.environment_id;
    }
    await this.persist(gen);
    this.log(`配对码已生成: ${code} expires=${this.pending.expiresAt}（${reason}）`);
    return true;
  }

  private async pollClaim(gen: number, pending: PairingPending): Promise<void> {
    let claimed: boolean;
    try {
      const res = await this.client.pairStatus({
        manualPairingCode: pending.code,
        remoteControlToken: pending.token,
      });
      claimed = res.claimed === true;
    } catch (err) {
      this.warn(`pair-status 轮询失败: ${errorMessage(err)}`);
      return;
    }
    if (this.suspended || gen !== this.generation) return;
    if (this.pending?.code !== pending.code) return; // 已被续码覆盖
    if (!claimed) return;
    this.pending = null;
    this.claimed = true;
    await rm(this.pairingPath, { force: true }).catch(() => undefined);
    this.log(`配对码已被 claim，清除 pending: ${pending.code}`);
  }

  private async applyToken(gen: number, token: string | undefined): Promise<void> {
    if (this.suspended || gen !== this.generation) return;
    if (!token || !this.pending || this.pending.token === token) return;
    this.pending = { ...this.pending, token };
    await this.persist(gen);
    this.log(`enrollment 续期：pending 码 token 已同步`);
  }

  private async persist(gen: number): Promise<void> {
    if (this.suspended || gen !== this.generation || !this.pending) return;
    await writeJsonAtomic(this.pairingPath, this.pending);
  }

  private async loadPending(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.pairingPath, "utf8")) as Partial<PairingPending>;
      if (
        parsed &&
        typeof parsed.code === "string" &&
        parsed.code &&
        typeof parsed.expiresAt === "string" &&
        typeof parsed.token === "string"
      ) {
        this.pending = { code: parsed.code, expiresAt: parsed.expiresAt, token: parsed.token };
      }
    } catch {
      // 无/损坏：忽略
    }
  }

  private async refreshClients(): Promise<void> {
    const env =
      this.environmentId ??
      this.tunnel?.enrollmentSnapshot?.environment_id ??
      (await readEnrollmentFile(this.instanceDir))?.environment_id ??
      null;
    this.environmentId = env;
    if (!env) {
      this.clients = [];
      return;
    }
    try {
      const page = await this.client.listClients({ environmentId: env, limit: 100, order: "desc" });
      this.clients = page.items;
      this.clientsRefreshedAt = new Date(this.now()).toISOString();
    } catch (err) {
      this.warn(`listClients 刷新失败: ${errorMessage(err)}`);
    }
  }

  private currentToken(): string | null {
    return this.tunnel?.pairToken ?? this.pending?.token ?? null;
  }

  private notExpired(pending: PairingPending): boolean {
    const expiresAt = Date.parse(pending.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt > this.now();
  }

  private view(): PairingPendingView | null {
    return this.pending ? { code: this.pending.code, expiresAt: this.pending.expiresAt } : null;
  }

  private safeEnabled(): boolean {
    try {
      return this.opts.isEnabled();
    } catch {
      return false;
    }
  }

  private safeOnline(): boolean {
    try {
      return this.opts.isOnline();
    } catch {
      return false;
    }
  }

  private warn(line: string): void {
    this.warnings.push(line);
    this.log(`WARN ${line}`);
  }
}

/** 原子写 JSON（tmp + rename，mode 600），避免读方看到半写 pairing.json。 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
