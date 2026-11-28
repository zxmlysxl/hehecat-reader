import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Folder, FolderPlus, KeyRound, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import * as React from "react";
import { booksApi } from "@/api/endpoints";
import type { BookGroupWithCount } from "@/api/types";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toast";
import { Button, IconButton } from "@/ui/Button";
import { Badge, EmptyView, InlineConfirm, Spinner } from "@/ui/Controls";
import { Input } from "@/ui/Input";
import { AnimatePresence, motion, SPRING_SNAPPY, useReducedMotion } from "@/ui/motion";
import { Sheet } from "@/ui/Sheet";

export interface GroupManagerSheetProps {
  open: boolean;
  onClose: () => void;
}

const PRESET_GROUPS = ["正在追更", "养肥待宰", "完结精选", "古典名著"];

export function GroupManagerSheet({ open, onClose }: GroupManagerSheetProps) {
  const queryClient = useQueryClient();
  const reduced = useReducedMotion();

  const { data: rawGroups = [], isLoading } = useQuery({
    queryKey: ["groups"],
    queryFn: () => booksApi.getGroups(),
    enabled: open,
    staleTime: 30_000,
  });

  // Only show user-created groups (id > 0); backend system pseudo-groups use negative IDs
  const groups = React.useMemo(() => rawGroups.filter((g) => g.id > 0), [rawGroups]);
  const totalGroupedBooks = React.useMemo(
    () => groups.reduce((acc, g) => acc + (g.bookCount || 0), 0),
    [groups],
  );

  const [newName, setNewName] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const [editingId, setEditingId] = React.useState<number | null>(null);
  const [editDraft, setEditDraft] = React.useState("");
  const [savingId, setSavingId] = React.useState<number | null>(null);
  const [deletingId, setDeletingId] = React.useState<number | null>(null);

  // 分组密码管理：当前在改密码的分组 + 输入框值
  const [pwEditingId, setPwEditingId] = React.useState<number | null>(null);
  const [pwDraft, setPwDraft] = React.useState("");
  const [pwBusyId, setPwBusyId] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!open) {
      setEditingId(null);
      setEditDraft("");
    }
  }, [open]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["groups"] }),
      queryClient.invalidateQueries({ queryKey: ["shelf"] }),
    ]);
  };

  const createGroupByName = async (raw: string) => {
    const clean = raw.trim();
    if (!clean) return;
    if (groups.some((g) => g.name.toLowerCase() === clean.toLowerCase())) {
      notify.info(`分组「${clean}」已存在`);
      return;
    }
    setCreating(true);
    try {
      await booksApi.saveGroup({ name: clean });
      setNewName("");
      await invalidate();
      notify.success(`已新建分组「${clean}」`);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "新建分组失败");
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    await createGroupByName(newName);
  };

  const startEditing = (group: BookGroupWithCount) => {
    setEditingId(group.id);
    setEditDraft(group.name);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditDraft("");
  };

  const commitRename = async (group: BookGroupWithCount) => {
    const clean = editDraft.trim();
    if (!clean || clean === group.name) {
      cancelEditing();
      return;
    }
    if (groups.some((g) => g.id !== group.id && g.name.toLowerCase() === clean.toLowerCase())) {
      notify.info(`分组「${clean}」已存在`);
      return;
    }
    setSavingId(group.id);
    try {
      await booksApi.saveGroup({ id: group.id, name: clean });
      await invalidate();
      notify.success(`分组已重命名为「${clean}」`);
      cancelEditing();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "重命名分组失败");
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (group: BookGroupWithCount) => {
    setDeletingId(group.id);
    try {
      await booksApi.deleteGroup(group.id);
      await invalidate();
      notify.success(`已删除分组「${group.name}」`);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "删除分组失败");
    } finally {
      setDeletingId(null);
    }
  };

  // 分组密码：设置/修改/移除
  const startPwEdit = (group: BookGroupWithCount) => {
    setPwEditingId(group.id);
    setPwDraft("");
  };
  const cancelPwEdit = () => {
    setPwEditingId(null);
    setPwDraft("");
  };
  const commitPw = async (group: BookGroupWithCount, clear = false) => {
    const pwd = pwDraft.trim();
    if (!clear && pwd.length === 0) {
      notify.info("密码不能为空");
      return;
    }
    setPwBusyId(group.id);
    try {
      // clear=true 或 密码为空串 → 移除加锁；否则设置/修改密码
      await booksApi.setGroupPassword(group.id, clear ? "" : pwd);
      await invalidate();
      notify.success(clear ? `已移除「${group.name}」的密码` : `已为「${group.name}」设置密码`);
      cancelPwEdit();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "设置密码失败");
    } finally {
      setPwBusyId(null);
    }
  };

  const duplicateNew =
    newName.trim().length > 0 &&
    groups.some((g) => g.name.toLowerCase() === newName.trim().toLowerCase());

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="sm"
      scrim={false}
      title="书房分组管理"
      subtitle="点击分组名原地重命名，删除后书籍将归入未分组"
    >
      <div className="space-y-5">
        {/* Create group form */}
        <form onSubmit={handleCreate} className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="输入新分组名称…"
              leftIcon={<FolderPlus className="size-3.5" />}
              clearable
              onClear={() => setNewName("")}
              className="flex-1"
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={creating}
              disabled={!newName.trim() || duplicateNew}
            >
              <Plus className="size-3.5" />
              新建
            </Button>
          </div>
          {duplicateNew ? (
            <p className="px-1 text-[11px] text-warn">已有同名分组，请换一个名称</p>
          ) : null}
        </form>

        {/* Summary bar */}
        {!isLoading && groups.length > 0 ? (
          <div className="flex items-center justify-between px-1 text-[11px] text-ink-muted tabular-nums">
            <span>共 {groups.length} 个自定义分组</span>
            <span>已归类 {totalGroupedBooks} 本次</span>
          </div>
        ) : null}

        {/* Group list */}
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner label="加载分组…" />
          </div>
        ) : groups.length === 0 ? (
          <div className="space-y-4">
            <EmptyView
              compact
              icon={<Folder className="size-5" />}
              title="暂无自定义分组"
              description="在上方输入名称，或直接点选常用分组为藏书归类。"
            />
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {PRESET_GROUPS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={creating}
                  onClick={() => void createGroupByName(preset)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-elevated px-3 py-1 text-xs text-ink-secondary transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-accent disabled:opacity-50"
                >
                  <Sparkles className="size-3 text-accent/80" />
                  {preset}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-line/70 sm:space-y-2 sm:divide-y-0">
            <AnimatePresence initial={false}>
              {groups.map((group) => {
                const isEditing = editingId === group.id;
                const isSaving = savingId === group.id;
                return (
                  <motion.div
                    key={group.id}
                    layout={!reduced}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                    transition={SPRING_SNAPPY}
                    className={cn(
                      "group py-2.5 transition-colors sm:rounded-2xl sm:border sm:bg-elevated/85 sm:px-3.5",
                      isEditing
                        ? "sm:border-accent/55 sm:bg-elevated sm:shadow-[var(--shadow-sm)]"
                        : "sm:border-line sm:hover:border-line-strong",
                    )}
                  >
                    {isEditing ? (
                      <div className="space-y-1.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <input
                            type="text"
                            autoFocus
                            value={editDraft}
                            disabled={isSaving}
                            onChange={(e) => setEditDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void commitRename(group);
                              } else if (e.key === "Escape") {
                                e.stopPropagation();
                                cancelEditing();
                              }
                            }}
                            className="h-8 min-w-0 flex-1 rounded-lg border border-accent/60 bg-bg px-2.5 text-[13px] text-ink outline-none ring-2 ring-accent/15"
                          />
                          <IconButton
                            size="sm"
                            tone="accent"
                            disabled={isSaving || !editDraft.trim()}
                            aria-label="保存重命名"
                            onClick={() => void commitRename(group)}
                          >
                            <Check className="size-3.5" />
                          </IconButton>
                          <IconButton
                            size="sm"
                            disabled={isSaving}
                            aria-label="取消重命名"
                            onClick={cancelEditing}
                          >
                            <X className="size-3.5" />
                          </IconButton>
                        </div>
                        <p className="px-0.5 text-[10px] text-ink-muted">
                          按 Enter 保存 · Esc 取消
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => startEditing(group)}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
                          title="点击原地重命名"
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-accent-soft/75 text-accent">
                            <Folder className="size-3.5" />
                          </span>
                          <span className="truncate text-[13.5px] font-medium text-ink">
                            {group.name}
                          </span>
                          <Badge className="shrink-0">{group.bookCount} 本</Badge>
                          {group.hasPassword ? (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                              <KeyRound className="size-2.5" />
                              已加锁
                            </span>
                          ) : null}
                        </button>

                        <div className="flex shrink-0 items-center gap-0.5">
                          <IconButton
                            size="sm"
                            tone={group.hasPassword ? "accent" : undefined}
                            aria-label={group.hasPassword ? `移除 ${group.name} 的密码` : `为 ${group.name} 设置密码`}
                            onClick={() => startPwEdit(group)}
                            className="opacity-70 transition-opacity group-hover:opacity-100"
                          >
                            <KeyRound className="size-3.5" />
                          </IconButton>
                          <IconButton
                            size="sm"
                            aria-label={`重命名 ${group.name}`}
                            onClick={() => startEditing(group)}
                            className="opacity-70 transition-opacity group-hover:opacity-100"
                          >
                            <Pencil className="size-3.5" />
                          </IconButton>
                          <InlineConfirm
                            confirmLabel="确认删除"
                            busy={deletingId === group.id}
                            onConfirm={() => handleDelete(group)}
                            trigger={(arm) => (
                              <IconButton
                                size="sm"
                                tone="danger"
                                aria-label={`删除 ${group.name}`}
                                onClick={arm}
                                className="opacity-70 transition-opacity group-hover:opacity-100"
                              >
                                <Trash2 className="size-3.5" />
                              </IconButton>
                            )}
                          />
                        </div>
                      </div>
                    )}

                    {pwEditingId === group.id ? (
                      <div className="mt-2.5 flex flex-col gap-2 rounded-xl border border-accent/35 bg-accent-soft/40 p-3">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] font-medium text-accent">
                            {group.hasPassword ? "修改密码（留空并保存可移除）" : "设置访问密码"}
                          </p>
                          <button
                            type="button"
                            className="text-[11px] text-ink-muted hover:text-ink"
                            onClick={cancelPwEdit}
                          >
                            取消
                          </button>
                        </div>
                        <input
                          type="password"
                          autoFocus
                          value={pwDraft}
                          onChange={(e) => setPwDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void commitPw(group);
                            } else if (e.key === "Escape") {
                              e.stopPropagation();
                              cancelPwEdit();
                            }
                          }}
                          placeholder="输入密码…"
                          className="h-8 w-full rounded-lg border border-accent/50 bg-bg px-2.5 text-[13px] text-ink outline-none ring-2 ring-accent/15"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={pwBusyId === group.id}
                            onClick={() => void commitPw(group)}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
                          >
                            {pwBusyId === group.id ? "保存中…" : "保存"}
                          </button>
                          {group.hasPassword ? (
                            <button
                              type="button"
                              disabled={pwBusyId === group.id}
                              onClick={() => void commitPw(group, true)}
                              className="cursor-pointer text-[11px] text-ink-muted underline hover:text-danger disabled:opacity-50"
                            >
                              移除密码
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </Sheet>
  );
}
