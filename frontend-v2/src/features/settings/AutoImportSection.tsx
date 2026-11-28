import { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Trash2,
} from "lucide-react";
import { autoImportApi, sourcesApi } from "@/api/endpoints";
import type { InvalidBookSource } from "@/api/types";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toast";
import { Button } from "@/ui/Button";
import { Spinner, Switch } from "@/ui/Controls";
import { Input } from "@/ui/Input";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

type AutoImportSettings = {
  enabled: boolean;
  scheduleType: "daily" | "weekly";
  dailyTime: string;
  weeklyDays: number[];
  autoDeleteInvalid: boolean;
  listUrl: string;
  lastId: number;
  lastRunAt: number;
  lastResult: string;
  lastImportedCount: number;
  taskState: string;
  taskProgress: string;
  running: boolean;
};

// 模块级缓存：SPA 存活期间跨 mount 保留，配合 sessionStorage 实现"刷新即见"
// 配置是轻量接口（不扫网络），所以刷新后 0.x 秒就能渲染出内容。
type AutoImportCache = {
  config: AutoImportSettings | null;
  pendingCount: number | null;
  invalidList: InvalidBookSource[];
  ts: number;
};
const CACHE_TTL_MS = 5 * 60 * 1000;
const SS_KEY = "mojuan.autoImport.cache.v3";

function readCache(): AutoImportCache | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as AutoImportCache;
    if (!c || typeof c.ts !== "number") return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(c: AutoImportCache) {
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify(c));
  } catch {
    /* 配额/隐私模式忽略 */
  }
}

let moduleCache: AutoImportCache | null = readCache();

function cacheFresh(c: AutoImportCache | null): boolean {
  return !!c && Date.now() - c.ts < CACHE_TTL_MS;
}

/** 拉取配置（轻量，不扫网络） */
async function fetchStatus(): Promise<AutoImportSettings> {
  const pv = await autoImportApi.status();
  return {
    enabled: pv.enabled,
    scheduleType: pv.scheduleType ?? "daily",
    dailyTime: pv.dailyTime ?? "03:00",
    weeklyDays: pv.weeklyDays ?? [0],
    autoDeleteInvalid: pv.autoDeleteInvalid ?? false,
    listUrl: pv.listUrl,
    lastId: pv.lastId,
    lastRunAt: pv.lastRunAt,
    lastResult: pv.lastResult,
    lastImportedCount: pv.lastImportedCount,
    taskState: pv.taskState ?? "",
    taskProgress: pv.taskProgress ?? "",
    running: !!pv.running,
  };
}

// 登录态就绪后预热：只拉轻量配置，让区块进页面即渲染
export function prefetchAutoImport(force = false): void {
  if (!force && cacheFresh(moduleCache)) return;
  void fetchStatus()
    .then((config) => {
      moduleCache = {
        config,
        pendingCount: moduleCache?.pendingCount ?? null,
        invalidList: moduleCache?.invalidList ?? [],
        ts: Date.now(),
      };
      writeCache(moduleCache);
    })
    .catch(() => {
      /* 预取失败不阻断 */
    });
}

export function AutoImportSection() {
  const [config, setConfig] = useState<AutoImportSettings | null>(() => moduleCache?.config ?? null);
  const [pendingCount, setPendingCount] = useState<number | null>(() => moduleCache?.pendingCount ?? null);
  const [invalidList, setInvalidList] = useState<InvalidBookSource[]>(
    () => moduleCache?.invalidList ?? [],
  );
  // 只有"连缓存都没有"才显示 loading，正常情况下直接渲染
  const [loading, setLoading] = useState(() => !moduleCache?.config);
  const [starting, setStarting] = useState(false);
  const [listUrlDraft, setListUrlDraft] = useState(() => moduleCache?.config?.listUrl ?? "");
  const listUrlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 静默刷新配置（不切 loading） */
  const refreshStatus = async (): Promise<AutoImportSettings | null> => {
    try {
      const c = await fetchStatus();
      setConfig(c);
      setLoading(false);
      moduleCache = {
        config: c,
        pendingCount,
        invalidList,
        ts: Date.now(),
      };
      writeCache(moduleCache);
      return c;
    } catch {
      setLoading(false);
      return null;
    }
  };

  /** 后台扫待导入数量（走网络，不阻塞渲染） */
  const refreshScan = async () => {
    try {
      const r = await autoImportApi.scan();
      setPendingCount(r.pendingCount);
      moduleCache = {
        config: moduleCache?.config ?? null,
        pendingCount: r.pendingCount,
        invalidList: moduleCache?.invalidList ?? [],
        ts: Date.now(),
      };
      writeCache(moduleCache);
    } catch {
      /* 扫描失败保留旧值 */
    }
  };

  /** 失效源列表（与配置并行拉） */
  const refreshInvalid = async () => {
    try {
      const inv = await sourcesApi.invalids();
      setInvalidList(inv ?? []);
      moduleCache = {
        config: moduleCache?.config ?? null,
        pendingCount: moduleCache?.pendingCount ?? null,
        invalidList: inv ?? [],
        ts: Date.now(),
      };
      writeCache(moduleCache);
    } catch {
      /* ignore */
    }
  };

  const stopPolling = () => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  /** 任务运行期间轮询进度，结束后停 */
  const startPolling = () => {
    stopPolling();
    pollTimer.current = setInterval(() => {
      void refreshStatus().then((c) => {
        if (c && !c.running && c.taskState !== "running") {
          stopPolling();
          // 跑完刷新一次待导入数量
          void refreshScan();
        }
      });
    }, 5000);
  };

  useEffect(() => {
    if (moduleCache?.config) {
      setConfig(moduleCache.config);
      setListUrlDraft(moduleCache.config.listUrl);
      setLoading(false);
      if (moduleCache.config.running) startPolling();
    }
    // 首屏：配置 + 失效源 + 待导入数量 三路并行，各自回填，互相不阻塞
    void refreshStatus().then((c) => {
      if (c?.running) startPolling();
    });
    void refreshInvalid();
    void refreshScan();
    return () => {
      if (listUrlTimer.current) clearTimeout(listUrlTimer.current);
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 保存后端字段：乐观更新本地 + 后台静默同步
  const save = async (fields: {
    enabled?: boolean;
    scheduleType?: "daily" | "weekly";
    dailyTime?: string;
    weeklyDays?: number[];
    autoDeleteInvalid?: boolean;
    listUrl?: string;
  }) => {
    setConfig((c) => (c ? { ...c, ...fields } : c));
    try {
      const next = await autoImportApi.saveConfig(fields);
      // saveConfig 返回完整配置，直接对齐服务端真值
      setConfig((c) => (c ? { ...c, ...next } : c));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "保存失败");
      await refreshStatus();
    }
  };

  const onListUrlChange = (v: string) => {
    setListUrlDraft(v);
    if (listUrlTimer.current) clearTimeout(listUrlTimer.current);
    listUrlTimer.current = setTimeout(() => {
      void save({ listUrl: v });
      void refreshScan();
    }, 600);
  };

  const handleRun = async () => {
    try {
      setStarting(true);
      const res = await autoImportApi.run();
      notify.success(res.message || "已在后台开始导入");
      await refreshStatus();
      startPolling();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "启动失败");
    } finally {
      setStarting(false);
    }
  };

  const handleDeleteInvalid = async () => {
    try {
      const res = await sourcesApi.deleteInvalid();
      notify.success(`已删除 ${res.deleted} 个失效书源`);
      await refreshInvalid();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "删除失效源失败");
    }
  };

  const lastRunLabel = config?.lastRunAt
    ? new Date(config.lastRunAt).toLocaleString("zh-CN")
    : "从未";

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">书源自动导入</h3>
          <p className="text-xs text-muted">
            定时从合集站增量拉取新书源，可自动检测并删除失效源
          </p>
        </div>
        {config && (
          <Switch
            checked={config.enabled}
            onChange={(v) => save({ enabled: v })}
          />
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Spinner label="加载中…" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* 列表页地址 */}
          {config && (
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-muted">列表页地址</span>
              <Input
                value={listUrlDraft}
                onChange={(e) => onListUrlChange(e.target.value)}
                onBlur={() => {
                  if (listUrlTimer.current) {
                    clearTimeout(listUrlTimer.current);
                    listUrlTimer.current = null;
                  }
                  if (listUrlDraft !== config.listUrl) {
                    save({ listUrl: listUrlDraft });
                  }
                }}
                placeholder="https://…/index.html"
                className="w-full"
              />
            </div>
          )}

          {/* 调度配置 */}
          {config && (
            <div className="space-y-2">
              <div className="text-xs text-muted">执行时间</div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-1 text-xs">
                    <input
                      type="radio"
                      checked={config.scheduleType === "daily"}
                      onChange={() => save({ scheduleType: "daily" })}
                    />
                    每天
                  </label>
                  <label className="flex cursor-pointer items-center gap-1 text-xs">
                    <input
                      type="radio"
                      checked={config.scheduleType === "weekly"}
                      onChange={() => save({ scheduleType: "weekly" })}
                    />
                    每周
                  </label>
                </div>
                <input
                  type="time"
                  value={config.dailyTime}
                  onChange={(e) => save({ dailyTime: e.target.value })}
                  className="rounded-md border border-line bg-transparent px-2 py-1 text-xs"
                />
                {config.scheduleType === "weekly" && (
                  <div className="flex gap-1">
                    {WEEKDAYS.map((d, i) => (
                      <button
                        key={i}
                        type="button"
                        className={cn(
                          "h-7 w-7 rounded text-xs transition-colors",
                          config.weeklyDays.includes(i)
                            ? "bg-accent text-white"
                            : "bg-subtle",
                        )}
                        onClick={() => {
                          const days = config.weeklyDays.includes(i)
                            ? config.weeklyDays.filter((x) => x !== i)
                            : [...config.weeklyDays, i];
                          save({ weeklyDays: days });
                        }}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 自动检测失效源 */}
          {config && (
            <div className="flex items-center gap-3">
              <Switch
                checked={config.autoDeleteInvalid}
                onChange={(v) => save({ autoDeleteInvalid: v })}
              />
              <span className="text-xs">自动检测并删除失效源</span>
              <span className="text-xs text-muted">每次自动导入后执行</span>
            </div>
          )}

          {/* 上次执行 */}
          {config && (
            <div className="space-y-1 text-xs text-muted">
              <div>上次执行：{lastRunLabel}</div>
              {config.lastResult && <div>结果：{config.lastResult}</div>}
              <div>上次导入：{config.lastImportedCount} 个书源</div>
              <div>增量游标：{config.lastId}</div>
            </div>
          )}

          {/* 后台任务进度 */}
          {config?.running && (
            <div className="flex items-center gap-2 rounded-lg bg-accent-soft/60 px-3 py-2 text-xs">
              <Spinner />
              <span className="text-accent">{config.taskProgress || "正在后台导入…"}</span>
            </div>
          )}
          {!config?.running && config?.taskState === "done" && config.taskProgress && (
            <div className="text-xs text-success">✓ {config.taskProgress}</div>
          )}
          {!config?.running && config?.taskState === "error" && config.taskProgress && (
            <div className="text-xs text-danger">✗ {config.taskProgress}</div>
          )}

          {/* 待导入数量（由轻量扫描异步回填） */}
          {pendingCount !== null && (
            <div className="text-xs text-muted">
              待导入新条目：
              {pendingCount > 0 ? (
                <span className="ml-1 font-medium text-accent">{pendingCount} 个</span>
              ) : (
                <span className="ml-1">无（已是最新）</span>
              )}
            </div>
          )}

          {/* 失效源列表 */}
          {invalidList.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium">
                已标记失效：{invalidList.length} 个
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={handleDeleteInvalid}
              >
                <Trash2 className="h-3.5 w-3.5" />
                全部删除失效源
              </Button>
            </div>
          )}

          {/* 手动执行 */}
          <Button
            variant="primary"
            onClick={handleRun}
            disabled={!config?.enabled || starting || !!config?.running}
            loading={starting}
          >
            {config?.running ? (
              "后台导入中…"
            ) : starting ? (
              "正在启动…"
            ) : (
              <span className="flex items-center gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" />
                立即执行一次
              </span>
            )}
          </Button>
        </div>
      )}
    </section>
  );
}
