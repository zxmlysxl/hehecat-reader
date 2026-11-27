import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  FileUp,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { booksApi } from "@/api/endpoints";
import type { BookInfo, ImportBookPreview } from "@/api/types";
import { cn } from "@/lib/cn";
import { buildReaderUrl, cleanIntro, formatBytes } from "@/lib/format";
import { requestKeepScreenAwakeNow } from "@/lib/keepScreenAwake";
import { notify } from "@/stores/toast";
import { BookCover } from "@/ui/BookCover";
import { Button, IconButton } from "@/ui/Button";
import { Badge, Spinner } from "@/ui/Controls";
import { AnimatePresence, motion, SPRING_POP, SPRING_SNAPPY, useReducedMotion } from "@/ui/motion";
import { Sheet } from "@/ui/Sheet";

export interface ImportBookSheetProps {
  open: boolean;
  onClose: () => void;
  initialFile?: File | null;
  onImported?: (book: BookInfo) => void;
}

const ACCEPTED_EXT = /\.(txt|epub)$/i;

// 单文件在队列中的状态
type FileStatus = "pending" | "uploading" | "done" | "error";
interface QueuedFile {
  id: string;
  file: File;
  status: FileStatus;
  result?: BookInfo | null;
  error?: string;
}

export function ImportBookSheet({
  open,
  onClose,
  initialFile = null,
  onImported,
}: ImportBookSheetProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reduced = useReducedMotion();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [queue, setQueue] = React.useState<QueuedFile[]>([]);
  const [dragging, setDragging] = React.useState(false);
  // 预览始终针对“当前查看”的那本（队列里第一本待处理）
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ImportBookPreview | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewNonce, setPreviewNonce] = React.useState(0);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [expandToc, setExpandToc] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [importedBooks, setImportedBooks] = React.useState<BookInfo[]>([]);

  const activeFile = React.useMemo(
    () => queue.find((q) => q.id === activeId) ?? null,
    [queue, activeId],
  );

  // 把一批文件加入队列（自动去重 + 只留 .txt/.epub）
  const enqueueFiles = React.useCallback((incoming: File[] | FileList | null | undefined) => {
    if (!incoming) return;
    const files = Array.from(incoming);
    if (files.length === 0) return;
    const valid: File[] = [];
    let rejected = 0;
    for (const f of files) {
      if (ACCEPTED_EXT.test(f.name)) valid.push(f);
      else rejected++;
    }
    if (rejected > 0) notify.error(`忽略 ${rejected} 个非 .txt/.epub 文件`);
    if (valid.length === 0) return;
    setQueue((prev) => {
      const existing = new Set(prev.map((q) => q.file.name));
      const fresh = valid
        .filter((f) => !existing.has(f.name))
        .map((f) => ({
          id: `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          file: f,
          status: "pending" as FileStatus,
        }));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, []);

  // 外部传入的初始文件（例如从其他入口带过来的单本）也走队列
  React.useEffect(() => {
    if (!open) return;
    if (initialFile) enqueueFiles([initialFile]);
  }, [open, initialFile, enqueueFiles]);

  // 队列变化时，若 activeId 失效或尚未设，选第一本待处理并预览
  React.useEffect(() => {
    if (queue.length === 0) {
      setActiveId(null);
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (!activeId || !queue.some((q) => q.id === activeId)) {
      const first = queue.find((q) => q.status !== "done") ?? queue[0];
      setActiveId(first.id);
    }
  }, [queue, activeId]);

  // 预览“当前查看”那本
  React.useEffect(() => {
    const target = activeFile?.file;
    if (!target) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setPreview(null);
      setPreviewError(null);
      setExpandToc(false);
      setPreviewLoading(true);
      try {
        const ms = Math.min(600_000, 120_000 + Math.max(0, target.size - 10 * 1024 * 1024) / (10 * 1024 * 1024) * 30_000);
        const res = await booksApi.previewLocalBook(target, ms);
        if (!cancelled) setPreview(res);
      } catch (err) {
        if (!cancelled) setPreviewError(err instanceof Error ? err.message : "文件解析失败，请检查文件编码或格式");
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeFile, previewNonce]);

  const resetAll = React.useCallback(() => {
    setQueue([]);
    setActiveId(null);
    setPreview(null);
    setPreviewError(null);
    setExpandToc(false);
    setPreviewLoading(false);
    setUploading(false);
    setImportedBooks([]);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleClose = () => {
    resetAll();
    onClose();
  };

  const removeFile = (id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
    if (activeId === id) setActiveId(null);
  };

  // 顺序导入队列里所有“未完成”的文件（逐个上传，失败不阻断后续）
  const handleUploadAll = async () => {
    if (queue.length === 0 || uploading) return;
    setUploading(true);
    const importable = queue.filter((q) => q.status !== "done");
    let okCount = 0;
    let failCount = 0;
    for (const item of importable) {
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "uploading" } : q)));
      try {
        const saved = await booksApi.uploadLocalBook(item.file);
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "done", result: saved } : q)));
        setImportedBooks((prev) => [...prev, saved]);
        onImported?.(saved);
        okCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "上传失败";
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "error", error: msg } : q)));
        failCount++;
      }
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["shelf"] }),
      queryClient.invalidateQueries({ queryKey: ["groups"] }),
    ]);
    setUploading(false);
    if (okCount > 0) notify.success(`已导入 ${okCount} 本书到书房`);
    if (failCount > 0) notify.error(`${failCount} 本书导入失败，可重新点“全部导入”重试`);
  };

  const allPreviewTitles = React.useMemo(() => {
    if (!preview) return [];
    if (preview.chapters && preview.chapters.length > 0) {
      return preview.chapters.slice(0, 40).map((ch, idx) => ({
        index: ch.index ?? idx,
        title: ch.title,
      }));
    }
    if (preview.preview && preview.preview.length > 0) {
      return preview.preview.slice(0, 40).map((title, idx) => ({
        index: idx,
        title,
      }));
    }
    return [];
  }, [preview]);

  const previewTitles = expandToc ? allPreviewTitles : allPreviewTitles.slice(0, 12);
  const previewIntro = React.useMemo(() => cleanIntro(preview?.book?.intro), [preview]);

  // 预览针对“当前查看”那本（activeFile）
  const hasQueue = queue.length > 0;
  const pendingCount = queue.filter((q) => q.status !== "done").length;
  const doneCount = queue.filter((q) => q.status === "done").length;
  const allDone = hasQueue && pendingCount === 0;

  const stageKey = allDone ? "imported" : hasQueue ? "preview" : "dropzone";

  return (
    <Sheet
      open={open}
      onClose={handleClose}
      size="md"
      title="导入本地书籍"
      subtitle="支持 TXT / EPUB，自动解析书目信息与章节结构"
      footer={
        allDone && importedBooks.length > 0 ? (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setImportedBooks([])}>
              继续导入
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const last = importedBooks[importedBooks.length - 1];
                handleClose();
                requestKeepScreenAwakeNow();
                navigate(buildReaderUrl(last.bookUrl, 0));
              }}
            >
              <BookOpen className="size-3.5" />
              立即阅读
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-ink-muted tabular-nums">
              {hasQueue ? `已选 ${queue.length} 本${doneCount > 0 ? `，已导入 ${doneCount}` : ""}` : "未选择文件"}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleClose}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={uploading}
                disabled={!hasQueue || uploading}
                onClick={() => void handleUploadAll()}
              >
                <Upload className="size-3.5" />
                {uploading ? `导入中…` : hasQueue ? `全部导入 ${queue.length} 本` : "收入书房"}
              </Button>
            </div>
          </div>
        )
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.epub,text/plain,application/epub+zip"
        multiple
        className="hidden"
        onChange={(e) => {
          enqueueFiles(e.target.files);
          e.currentTarget.value = "";
        }}
      />

      <AnimatePresence mode="wait" initial={false}>
        {stageKey === "imported" && importedBooks.length > 0 ? (
          <motion.div
            key="imported"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={SPRING_POP}
            className="flex flex-col items-center gap-4 py-6 text-center"
          >
            <motion.div
              initial={reduced ? undefined : { scale: 0.7 }}
              animate={{ scale: 1 }}
              transition={SPRING_POP}
              className="flex size-13 items-center justify-center rounded-2xl bg-success-soft text-success shadow-[var(--shadow-sm)]"
            >
              <CheckCircle2 className="size-6" />
            </motion.div>
            <div className="space-y-1">
              <h3 className="font-serif text-lg font-semibold text-ink">
                已导入 {importedBooks.length} 本书到书房
              </h3>
              <p className="text-xs text-ink-muted">本地书库已完成建档，可即刻展卷阅读。</p>
            </div>
            <div className="w-full max-w-sm space-y-1.5">
              {importedBooks.map((b) => (
                <button
                  key={b.bookUrl}
                  type="button"
                  onClick={() => {
                    requestKeepScreenAwakeNow();
                    navigate(buildReaderUrl(b.bookUrl, 0));
                  }}
                  className="flex w-full items-center gap-2 rounded-xl border border-line bg-elevated/70 px-3 py-2 text-left transition-colors hover:border-accent/55 hover:bg-accent-soft/40"
                >
                  <BookCover
                    src={b.coverUrl}
                    title={b.name}
                    author={b.author}
                    pageEdges
                    interactive={false}
                    className="w-8 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{b.name}</span>
                  <span className="shrink-0 text-[10px] text-ink-muted">{b.author || "佚名"} →</span>
                </button>
              ))}
            </div>
          </motion.div>
        ) : stageKey === "dropzone" ? (
          <motion.div
            key="dropzone"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={SPRING_SNAPPY}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragging(false);
                enqueueFiles(e.dataTransfer.files);
              }}
              className={cn(
                "group relative flex cursor-pointer flex-col items-center justify-center gap-4 overflow-hidden rounded-3xl border-2 border-dashed px-6 py-14 text-center transition-all",
                dragging
                  ? "scale-[1.01] border-accent bg-accent-soft/50 ring-4 ring-accent/15"
                  : "border-line-strong bg-elevated/55 hover:border-accent/55 hover:bg-elevated/90",
              )}
            >
              <motion.div
                animate={dragging && !reduced ? { y: [0, -5, 0] } : { y: 0 }}
                transition={dragging ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" } : undefined}
                className={cn(
                  "flex size-14 items-center justify-center rounded-2xl transition-colors",
                  dragging
                    ? "bg-accent text-accent-ink shadow-md"
                    : "bg-subtle text-ink-secondary group-hover:bg-accent-soft group-hover:text-accent",
                )}
              >
                <FileUp className="size-6" />
              </motion.div>
              <div className="space-y-1.5">
                <p className="font-serif text-base font-medium text-ink">
                  {dragging ? "松手解析电子书" : "拖入电子书文件，或点击选取"}
                </p>
                <p className="text-xs text-ink-muted">
                  自动检测 UTF-8 / GBK 编码与章节结构，确认预览后入架
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="accent">.TXT</Badge>
                <Badge tone="accent">.EPUB</Badge>
              </div>
              <Button size="sm" variant="secondary" className="mt-1 pointer-events-none">
                选择本地文件
              </Button>
            </div>
          </motion.div>
        ) : hasQueue ? (
          <motion.div
            key="preview"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={SPRING_SNAPPY}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragging(false);
              enqueueFiles(e.dataTransfer.files);
            }}
            className={cn(
              "space-y-5 rounded-2xl transition-all",
              dragging && "ring-2 ring-accent/50 ring-offset-4 ring-offset-bg",
            )}
          >
            {/* 队列列表（多本） */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="font-serif text-xs font-semibold tracking-wide text-ink-secondary">
                  待导入队列（{queue.length}）
                </h4>
                <div className="flex items-center gap-1">
                  <Button size="xs" variant="ghost" onClick={() => inputRef.current?.click()}>
                    添加文件
                  </Button>
                  <IconButton size="sm" aria-label="清空队列" onClick={resetAll}>
                    <X className="size-3.5" />
                  </IconButton>
                </div>
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                {queue.map((q) => (
                  <div
                    key={q.id}
                    onClick={() => setActiveId(q.id)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-xl border px-2.5 py-2 transition-colors",
                      activeId === q.id ? "border-accent/55 bg-accent-soft/40" : "border-line bg-elevated/55 hover:bg-subtle/50",
                    )}
                  >
                    <div
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-lg",
                        q.status === "done" ? "bg-success-soft text-success" : q.status === "error" ? "bg-danger-soft text-danger" : "bg-subtle text-accent",
                      )}
                    >
                      {q.status === "done" ? (
                        <CheckCircle2 className="size-4" />
                      ) : q.status === "error" ? (
                        <AlertCircle className="size-4" />
                      ) : (
                        <FileText className="size-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-ink">{q.file.name}</p>
                      <p className="text-[11px] text-ink-muted tabular-nums">
                        {formatBytes(q.file.size)}
                        {q.status === "error" ? ` · ${q.error}` : q.status === "uploading" ? " · 导入中…" : q.status === "done" ? " · 已导入" : ""}
                      </p>
                    </div>
                    {q.status !== "done" && q.status !== "uploading" && (
                      <IconButton
                        size="sm"
                        aria-label="移除"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFile(q.id);
                        }}
                      >
                        <X className="size-3.5" />
                      </IconButton>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Preview Content */}
            {activeFile && activeFile.file.size > 20 * 1024 * 1024 && !preview ? (
              <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-ink-muted">
                文件较大（{formatBytes(activeFile.file.size)}），目录预览可能超时——可直接点右下角「全部导入」上传，上传成功后目录会自动解析
              </div>
            ) : null}
            {previewLoading ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-line bg-elevated/55 py-12">
                <Spinner label="正在解析书目信息与目录结构…" />
                <p className="text-[11px] text-ink-muted">大体积文件可能需要数秒</p>
              </div>
            ) : previewError ? (
              <div className="space-y-3 rounded-2xl border border-danger/30 bg-danger-soft/50 p-4">
                <div className="flex items-start gap-2.5 text-danger">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-xs font-medium">目录预览解析失败</p>
                    <p className="text-xs opacity-85">{previewError}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => setPreviewNonce((n) => n + 1)}
                  >
                    <RefreshCw className="size-3" />
                    重新解析
                  </Button>
                  <span className="text-[11px] text-ink-muted">
                    仍可尝试点击右下角「收入书房」直接上传
                  </span>
                </div>
              </div>
            ) : preview ? (
              <div className="space-y-4">
                {/* Parsed Book Card */}
                <div className="flex items-start gap-4 rounded-2xl border border-line bg-elevated/80 p-4 shadow-[var(--shadow-sm)]">
                  <BookCover
                    src={preview.book?.coverUrl}
                    title={preview.name}
                    author={preview.author}
                    pageEdges
                    interactive={false}
                    className="w-20 shrink-0"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <h3 className="font-serif text-lg leading-snug font-semibold text-ink">
                      {preview.name}
                    </h3>
                    <p className="text-xs text-ink-secondary">
                      {preview.author || "佚名"}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <Badge tone="accent">
                        {(preview.format || "TXT").toUpperCase()}
                      </Badge>
                      <Badge tone="success">共 {preview.chapterCount} 章</Badge>
                      <Badge>{formatBytes(activeFile?.file.size ?? 0)}</Badge>
                    </div>
                    {previewIntro ? (
                      <p className="line-clamp-2 pt-0.5 text-[11.5px] leading-relaxed text-ink-muted">
                        {previewIntro}
                      </p>
                    ) : null}
                  </div>
                </div>

                {/* Chapter Directory Preview */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="font-serif text-xs font-semibold tracking-wide text-ink-secondary">
                      目录预览
                    </h4>
                    <span className="text-[11px] text-ink-muted tabular-nums">
                      显示前 {previewTitles.length} / 共 {preview.chapterCount} 章
                    </span>
                  </div>
                  {previewTitles.length > 0 ? (
                    <div className="overflow-hidden rounded-2xl border border-line bg-elevated/60">
                      <div className="max-h-60 divide-y divide-line/70 overflow-y-auto">
                        {previewTitles.map((item) => (
                          <div
                            key={`${item.index}-${item.title}`}
                            className="flex items-center gap-3 px-3.5 py-2 text-xs transition-colors hover:bg-subtle/45"
                          >
                            <span className="w-7 shrink-0 font-mono text-[11px] text-ink-muted tabular-nums">
                              {item.index + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-ink">
                              {item.title}
                            </span>
                          </div>
                        ))}
                      </div>
                      {allPreviewTitles.length > 12 ? (
                        <button
                          type="button"
                          onClick={() => setExpandToc((v) => !v)}
                          className="flex w-full cursor-pointer items-center justify-center gap-1 border-t border-line/70 bg-subtle/40 py-2 text-[11px] font-medium text-ink-secondary transition-colors hover:bg-subtle/80 hover:text-ink"
                        >
                          {expandToc ? (
                            <>
                              <ChevronUp className="size-3.5" />
                              收起目录预览
                            </>
                          ) : (
                            <>
                              <ChevronDown className="size-3.5" />
                              展开更多预览（共 {allPreviewTitles.length} 条）
                            </>
                          )}
                        </button>
                      ) : preview.chapterCount > previewTitles.length ? (
                        <div className="border-t border-line/70 px-3.5 py-2 text-center text-[11px] text-ink-muted">
                          以及其余 {preview.chapterCount - previewTitles.length} 章…
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-line bg-subtle/40 px-4 py-6 text-center text-xs text-ink-muted">
                      未切分出独立章节，入库后将以整卷呈现
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Sheet>
  );
}
