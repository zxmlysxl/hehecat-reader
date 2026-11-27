import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudDownload, Play, RefreshCw } from "lucide-react";
import * as React from "react";
import { autoImportApi } from "@/api/endpoints";
import { Button } from "@/ui/Button";
import { Badge, Switch } from "@/ui/Controls";
import { Input } from "@/ui/Input";
import { formatRelativeTime } from "@/lib/format";
import { notify } from "@/stores/toast";

/** 管理员专属：远程书源自动导入（定时增量拉取书源合集页 → 导入新条目） */
export function AutoImportSection() {
  const qc = useQueryClient();

  const configQuery = useQuery({
    queryKey: ["autoImport", "config"],
    queryFn: () => autoImportApi.getConfig(),
    retry: false,
  });

  const cfg = configQuery.data;

  const setMutation = useMutation({
    mutationFn: (body: { enabled?: boolean; intervalMinutes?: number; listUrl?: string }) =>
      autoImportApi.setConfig(body),
    onSuccess: (res) => {
      qc.setQueryData(["autoImport", "config"], res);
      notify.success("自动导入配置已保存");
    },
    onError: (err) => notify.error(err instanceof Error ? err.message : "保存失败"),
  });

  const runMutation = useMutation({
    mutationFn: () => autoImportApi.runNow(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["autoImport", "config"] });
      qc.invalidateQueries({ queryKey: ["studio", "sources"] });
      if (res.importedEntries > 0) {
        notify.success(
          `已导入 ${res.importedEntries} 个合集 / ${res.importedSources} 个书源（游标 ${res.lastId}）`,
        );
      } else {
        notify.info(res.details[0] || "没有新的书源合集");
      }
    },
    onError: (err) => notify.error(err instanceof Error ? err.message : "执行失败"),
  });

  const [intervalInput, setIntervalInput] = React.useState<string | null>(null);
  const [urlInput, setUrlInput] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (cfg && intervalInput === null) setIntervalInput(String(cfg.intervalMinutes));
  }, [cfg, intervalInput]);
  React.useEffect(() => {
    if (cfg && urlInput === null) setUrlInput(cfg.listUrl);
  }, [cfg, urlInput]);

  const intervalMinutes = Number(intervalInput ?? "360");
  const listUrl = (urlInput ?? "").trim();
  const urlDirty = Boolean(cfg && listUrl && listUrl !== cfg.listUrl);
  const intervalDirty = Boolean(cfg && Number.isFinite(intervalMinutes) && intervalMinutes !== cfg.intervalMinutes);

  return (
    <section
      id="settings-auto-import"
      data-settings-section=""
      data-label="书源自动导入"
      className="flex scroll-mt-32 flex-col gap-4 md:scroll-mt-6"
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-serif text-[17px] font-semibold tracking-tight text-ink">书源自动导入</h2>
            {cfg?.enabled ? (
              <Badge tone="success">已开启</Badge>
            ) : (
              <Badge tone="default">已关闭</Badge>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            定时抓取「书源合集」列表页，只导入编号大于上次游标的新条目。游标成功后自动推进，
            下次从它之后继续。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={runMutation.isPending}
            onClick={() => runMutation.mutate()}
          >
            <Play className="size-3.5" />
            立即执行
          </Button>
        </div>
      </header>

      <div className="divide-y divide-line/70 border-y border-line/70 bg-transparent md:divide-y md:overflow-hidden md:rounded-2xl md:border md:border-line md:bg-elevated">
        {/* 开关 */}
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">启用自动导入</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              开启后服务端每 10 分钟检查一次，到达设定间隔即自动导入新书源合集。
            </p>
          </div>
          <Switch
            checked={Boolean(cfg?.enabled)}
            disabled={setMutation.isPending || !cfg}
            ariaLabel="启用自动导入"
            onChange={(v) => setMutation.mutate({ enabled: v })}
          />
        </div>

        {/* 间隔 */}
        <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">执行间隔</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              两次自动导入之间的最小间隔（分钟），最小 10 分钟。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              type="number"
              min={10}
              max={10080}
              value={intervalInput ?? ""}
              onChange={(e) => setIntervalInput(e.target.value)}
              className="w-28"
              aria-label="执行间隔（分钟）"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!intervalDirty || !Number.isFinite(intervalMinutes)}
              loading={setMutation.isPending}
              onClick={() =>
                setMutation.mutate({ intervalMinutes: Math.max(10, Math.floor(intervalMinutes)) })
              }
            >
              保存
            </Button>
          </div>
        </div>

        {/* 列表页 */}
        <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">合集列表页</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              形如 <code className="font-mono">/yuedu/shuyuans/index.html</code>
              ，从页面里的合集条目链接解析编号与 json 订阅地址。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              value={urlInput ?? ""}
              placeholder="https://.../index.html"
              onChange={(e) => setUrlInput(e.target.value)}
              className="w-64"
              aria-label="合集列表页地址"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!urlDirty || !listUrl}
              loading={setMutation.isPending}
              onClick={() => setMutation.mutate({ listUrl })}
            >
              保存
            </Button>
          </div>
        </div>

        {/* 状态 */}
        <div className="px-4 py-3.5">
          <p className="text-sm font-medium text-ink">运行状态</p>
          {configQuery.isLoading ? (
            <p className="mt-1.5 text-xs text-ink-muted">加载中…</p>
          ) : configQuery.isError ? (
            <p className="mt-1.5 text-xs text-danger">
              读取失败：{configQuery.error instanceof Error ? configQuery.error.message : "未知错误"}
            </p>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-line bg-elevated px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                  <RefreshCw className="size-3.5" />
                  游标编号
                </div>
                <p className="mt-1 font-mono text-sm font-semibold text-ink tabular-nums">
                  {cfg?.lastId ?? 0}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-elevated px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                  <CloudDownload className="size-3.5" />
                  上次导入
                </div>
                <p className="mt-1 text-sm font-semibold text-ink tabular-nums">
                  {cfg?.lastImportedCount ?? 0} 个书源
                </p>
              </div>
              <div className="rounded-xl border border-line bg-elevated px-3 py-2.5">
                <div className="text-[11px] text-ink-muted">上次执行</div>
                <p className="mt-1 text-sm font-semibold text-ink">
                  {cfg?.lastRunAt ? formatRelativeTime(cfg.lastRunAt) || "—" : "尚未执行"}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-elevated px-3 py-2.5">
                <div className="text-[11px] text-ink-muted">结果</div>
                <p className="mt-1 truncate text-sm font-semibold text-ink" title={cfg?.lastResult}>
                  {cfg?.lastResult || "—"}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
