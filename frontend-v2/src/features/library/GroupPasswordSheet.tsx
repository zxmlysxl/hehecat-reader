import { KeyRound } from "lucide-react";
import * as React from "react";
import { booksApi } from "@/api/endpoints";
import type { BookGroupWithCount } from "@/api/types";
import { notify } from "@/stores/toast";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
import { Sheet } from "@/ui/Sheet";

export interface GroupPasswordSheetProps {
  open: boolean;
  group: BookGroupWithCount | null;
  onClose: () => void;
  onVerified: (groupId: number) => void;
}

/**
 * 分组密码解锁弹窗。输入密码后调用 verifyGroupPassword 校验，
 * 通过则 onVerified(groupId)（父组件缓存放行）。密码只发给后端，不回显、不缓存明文。
 */
export function GroupPasswordSheet({ open, group, onClose, onVerified }: GroupPasswordSheetProps) {
  const [pwd, setPwd] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) setPwd("");
  }, [open, group?.id]);

  const submit = async () => {
    if (!group || pwd.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      const { ok } = await booksApi.verifyGroupPassword(group.id, pwd.trim());
      if (ok) {
        onVerified(group.id);
      } else {
        notify.error("密码不正确，请重试");
        setPwd("");
      }
    } catch {
      notify.error("校验失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open && Boolean(group)}
      onClose={() => onClose()}
      size="sm"
      scrim={false}
      title="解锁分组"
      subtitle={`「${group?.name ?? ""}」已设置密码，请输入密码查看分组内容`}
    >
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2 rounded-xl bg-subtle/60 px-3 py-2.5">
          <KeyRound className="size-4 text-accent" />
          <span className="text-xs text-ink-muted">输入该分组的访问密码</span>
        </div>
        <Input
          type="password"
          autoFocus
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="分组密码"
          aria-label="分组密码"
          className="w-full"
        />
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || pwd.trim().length === 0}
          >
            {busy ? "校验中…" : "解锁"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
