/**
 * 阅读时屏幕常亮
 *
 * 完全对齐 zxmlysxl/reader 的实现（2026-11-26 第三次迭代，前两次带音频兜底的方案在 iOS 上都失败了）：
 * - 只用 legacy window.WakeLock.request("screen", { signal }) + AbortController sentinel，不 await
 * - visibilitychange / fullscreenchange 时重新请求
 * - 用户从 LibraryPage / MePage 点进阅读页的那一下手势（transient activation）里完成首次请求
 * - 无任何视频/音频兜底层
 *
 * 如果这样仍然锁屏，问题就在 iOS PWA 的 Wake Lock 支持本身（zxmlysxl 同机制可用，说明
 * 同一台手机同一浏览器里 zxmlysxl 能拿到 lock），而不是前端多挂了什么层。
 */

/** 旧版接口：window.WakeLock.request(type, { signal })，返回 AbortController */
type LegacyWakeLock = {
  request: (type: string, options?: { signal?: AbortSignal }) => Promise<unknown> | unknown;
};

/** 标准接口：navigator.wakeLock.request(type) -> Promise<WakeLockSentinel> */
type WakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
  removeEventListener?: (type: "release", listener: () => void) => void;
};

// ============================================================
// Wake Lock（完全对齐 zxmlysxl）
// ============================================================

let moduleSentinel: WakeLockSentinel | null = null;
let moduleLegacyController: AbortController | null = null;

// 真实状态跟踪：iOS/legacy WakeLock 的 request 返回一个 Promise，只有 resolve 了
// 才算真正拿到锁。之前把 controller 当成"已锁"，导致 iOS 静默拒绝时徽标还显示绿灯。
// 现在用一个"正在等待/已成功"的标志，只有成功才置 true。
let lockPending = false;
let lockGranted = false;

function hasActiveModuleLock(): boolean {
  return (moduleSentinel !== null && !moduleSentinel.released) || moduleLegacyController !== null;
}

/**
 * 在用户手势上下文里立即申请 Wake Lock（对齐 zxmlysxl 的 requestWakeLock）。
 * legacy 接口优先（zxmlysxl 的写法：AbortController sentinel，不 await），
 * 没有 legacy 时退回 navigator.wakeLock。
 */
function requestWakeLock(): void {
  if (typeof navigator === "undefined" || typeof document === "undefined") return;
  if (lockPending || lockGranted || hasActiveModuleLock()) return;
  lockPending = true;

  const legacy = (window as unknown as { WakeLock?: LegacyWakeLock }).WakeLock;
  if (legacy && typeof legacy.request === "function") {
    try {
      const controller = new AbortController();
      const result = legacy.request("screen", { signal: controller.signal });
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>)
          .then(() => {
            // legacy 实现 resolve = 锁已授予
            moduleLegacyController = controller;
            lockGranted = true;
            lockPending = false;
          })
          .catch(() => {
            lockPending = false;
            lockGranted = false;
            moduleLegacyController = null;
          });
      } else {
        // 同步返回（无 Promise）→ 假设已授予
        moduleLegacyController = controller;
        lockGranted = true;
        lockPending = false;
      }
      return;
    } catch {
      lockPending = false;
      moduleLegacyController = null;
    }
  }

  const nav = navigator as unknown as {
    wakeLock?: { request: (type: string) => Promise<WakeLockSentinel> };
  };
  if (nav.wakeLock && typeof nav.wakeLock.request === "function") {
    void nav.wakeLock
      .request("screen")
      .then((sentinel) => {
        moduleSentinel = sentinel;
        lockGranted = true;
        lockPending = false;
        sentinel.addEventListener?.("release", () => {
          if (moduleSentinel === sentinel) {
            moduleSentinel = null;
            lockGranted = false;
          }
        });
      })
      .catch(() => {
        // iOS 静默拒绝（无 transient activation）→ 重置，允许 visibilitychange 重试
        moduleSentinel = null;
        lockGranted = false;
        lockPending = false;
      });
  } else {
    lockPending = false;
  }
}

/** 用户入口（LibraryPage / MePage / ImportBookSheet / SourcesWorkspace）调用 */
export function requestKeepScreenAwakeNow(): void {
  requestWakeLock();
}

/** 释放模块级锁 */
export function releaseKeepScreenAwake(): void {
  if (moduleSentinel) {
    try { void moduleSentinel.release(); } catch { /* */ }
    moduleSentinel = null;
  }
  if (moduleLegacyController) {
    try { moduleLegacyController.abort(); } catch { /* */ }
    moduleLegacyController = null;
  }
  lockGranted = false;
  lockPending = false;
}

// ============================================================
// 调试
// ============================================================

export function getKeepAwakeStatus(): {
  lockActive: boolean;
  legacyActive: boolean;
  pending: boolean;
  hasLegacyApi: boolean;
  hasNavApi: boolean;
  secureContext: boolean;
  label: string;
} {
  const w = typeof window !== "undefined" ? (window as unknown as { WakeLock?: LegacyWakeLock }) : undefined;
  const nav = typeof navigator !== "undefined"
    ? (navigator as unknown as { wakeLock?: { request?: unknown } })
    : undefined;
  const legacyOk = Boolean(w && w.WakeLock && typeof w.WakeLock.request === "function");
  const navOk = Boolean(nav && nav.wakeLock && typeof nav.wakeLock.request === "function");
  const secure = typeof window !== "undefined" && window.isSecureContext !== false;
  const active = lockGranted && (moduleLegacyController !== null || (moduleSentinel !== null && !moduleSentinel.released));

  let label: string;
  if (active) label = "🟢WakeLock";
  else if (lockPending) label = "🟡pending";
  else if (!secure) label = "🔴非HTTPS";
  else if (!legacyOk && !navOk) label = "🔴无API";
  else label = "🔴拒绝";

  return {
    lockActive: lockGranted && moduleSentinel !== null && !moduleSentinel.released,
    legacyActive: lockGranted && moduleLegacyController !== null,
    pending: lockPending,
    hasLegacyApi: legacyOk,
    hasNavApi: navOk,
    secureContext: secure,
    label,
  };
}

/**
 * 实例级控制器（ReaderPage 使用）。
 * 在挂载时调用 start()，卸载时调用 stop()。
 * 对齐 zxmlysxl：只补一次 wake lock + visibilitychange/fullscreenchange 监听。
 */
export class KeepScreenAwake {
  private disposers: Array<() => void> = [];

  start(): void {
    if (typeof document === "undefined") return;

    // 补一次 wake lock（直接 URL 访问时可能没经过手势入口）
    requestWakeLock();

    // visibilitychange / fullscreenchange → 重新请求 wake lock（zxmlysxl 同款）
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    this.disposers.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

    const onFullscreenChange = () => {
      if (document.visibilityState === "visible") requestWakeLock();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    this.disposers.push(() => document.removeEventListener("fullscreenchange", onFullscreenChange));
  }

  stop(): void {
    for (const dispose of this.disposers) {
      try { dispose(); } catch { /* */ }
    }
    this.disposers = [];
  }
}
