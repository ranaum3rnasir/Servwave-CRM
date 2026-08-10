"use client";

import { Toaster as Sonner, toast, type ToasterProps } from "sonner";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";

/**
 * Toasts. sonner rather than a hand-rolled stack: it handles stacking order,
 * hover-to-pause, swipe dismissal, promise states, and an aria-live region
 * that announces once instead of on every re-render.
 *
 * Mount once at the app root, then call `toast` from anywhere:
 *
 *   toast.success("Job deleted", { description: "J00225 was removed." });
 *   toast.promise(save(), { loading: "Saving…", success: "Saved", error: "Failed" });
 *
 * Styling is driven by our tokens rather than sonner's theme prop, so light
 * and dark follow the `.dark` class like everything else.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      // 4s: long enough to read two lines, short enough not to stack up
      // during a burst of bulk actions.
      duration={4000}
      gap={9}
      offset={18}
      icons={{
        success: <CheckCircle2 className="size-[19px]" />,
        error: <XCircle className="size-[19px]" />,
        warning: <TriangleAlert className="size-[19px]" />,
        info: <Info className="size-[19px]" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast !bg-kit-card !border-border !text-foreground !rounded-[10px] !shadow-popover " +
            "!border !gap-2.5 !p-3 relative overflow-hidden " +
            "before:absolute before:left-0 before:inset-y-0 before:w-[3px]",
          title: "!text-[13px] !font-bold !tracking-[-0.01em]",
          description: "!text-muted-foreground !text-[12px] !leading-normal !mt-0.5",
          actionButton: "!bg-primary !text-primary-foreground !rounded-md !text-[12px] !font-semibold",
          cancelButton: "!bg-muted !text-muted-foreground !rounded-md !text-[12px] !font-semibold",
          closeButton: "!bg-kit-card !border-border !text-muted-foreground hover:!text-foreground",
          success: "before:bg-status-green [&_[data-icon]]:!text-status-green",
          error: "before:bg-destructive [&_[data-icon]]:!text-destructive",
          warning: "before:bg-status-amber [&_[data-icon]]:!text-status-amber",
          info: "before:bg-status-blue [&_[data-icon]]:!text-status-blue",
        },
      }}
      {...props}
    />
  );
}

export { Toaster, toast };
