import { useEffect, useState } from "react";
import {
  RefreshCw,
  Trash2,
} from "lucide-react";
import { autoImportApi, sourcesApi } from "@/api/endpoints";
import type { InvalidBookSource } from "@/api/types";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toast";
import { Button } from "@/ui/Button";
import { Badge, Spinner, Switch } from "@/ui/Controls";
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
};

type PreviewData = {
  listUrl: string;
  lastId: number;
  pendingCount: number;
  preview: Array<{ id: number; detailUrl: string; jsonUrl: string | null; error?: string }>;
};

export function AutoImportSection() {
  const [config, setConfig] = useState<AutoImportSettings | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [invalidList, setInvalidList] = useState<InvalidBookSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const pv = await autoImportApi.preview();
      if (pv) {
        setConfig({
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
        });
        setPreview({
          listUrl: pv.listUrl,
          lastId: pv.lastId,
          pendingCount: pv.pendingCount,
          preview: pv.preview ?? [],
        });
      }
      const inv = await sourcesApi.invalids();
      setInvalidList(inv ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleSave = async (fields: {
    enabled?: boolean;
    scheduleType?: "daily" | "weekly";
    dailyTime?: string;
    weeklyDays?: number[];
    autoDeleteInvalid?: boolean;
    listUrl?: string;
  }) => {
    try {
      await autoImportApi.saveConfig(fields);
      notify.success("已保存");
      await refresh();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "保存失败");
    }
  };

  const handleRun = async () => {
    try {
      setPreviewing(true);
      const res = await autoImportApi.run();
      notify.success(
        `导入 ${res.importedEntries} 个合集 / ${res.importedSources} 个书源` +
          (res.deletedInvalid > 0 ? `，删除 ${res.deletedInvalid} 个失效源` : ""),
      );
      await refresh();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "执行失败");
    } finally {
      setPreviewing(false);
    }
  };

  const handleDeleteInvalid = async () => {
    try {
      const res = await sourcesApi.deleteInvalid();
      notify.success(`已删除 ${res.deleted} 个失效书源`);
      await refresh();
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
            onChange={(v) => handleSave({ enabled: v })}
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
                value={config.listUrl}
                onChange={(e) => handleSave({ listUrl: e.target.value })}
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
                      onChange={() => handleSave({ scheduleType: "daily" })}
                    />
                    每天
                  </label>
                  <label className="flex cursor-pointer items-center gap-1 text-xs">
                    <input
                      type="radio"
                      checked={config.scheduleType === "weekly"}
                      onChange={() => handleSave({ scheduleType: "weekly" })}
                    />
                    每周
                  </label>
                </div>
                <input
                  type="time"
                  value={config.dailyTime}
                  onChange={(e) => handleSave({ dailyTime: e.target.value })}
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
                          handleSave({ weeklyDays: days });
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
                onChange={(v) => handleSave({ autoDeleteInvalid: v })}
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

          {/* 待导入预览 */}
          {preview && preview.pendingCount > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium">
                待导入新条目：{preview.pendingCount} 个
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {preview.preview.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 text-xs">
                    <Badge>{p.id}</Badge>
                    {p.jsonUrl ? (
                      <span className="truncate text-success">{p.jsonUrl}</span>
                    ) : (
                      <span className="text-danger">{p.error ?? "无法解析"}</span>
                    )}
                  </div>
                ))}
              </div>
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
            disabled={!config?.enabled || previewing}
            loading={previewing}
          >
            {previewing ? (
              "正在执行…"
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
