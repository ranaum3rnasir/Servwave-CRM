"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Modal dialog.
 *
 * Radix owns the hard parts: focus moves in on open, Tab cycles inside, Escape
 * closes, focus returns to the trigger, the page behind is inert and scroll is
 * locked. Our useOverlay hook does the same for hand-rolled surfaces - but do
 * not use both here, they would fight over focus.
 */
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-scrim/50 backdrop-blur-[3px]",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-kit-card fixed top-1/2 left-1/2 z-50 w-[calc(100%-2.5rem)] max-w-[27.5rem]",
          "-translate-x-1/2 -translate-y-1/2",
          "rounded-xl border shadow-modal outline-none",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={cn(
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "absolute top-3 right-3 grid size-8 place-items-center rounded-md",
              "transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
              "disabled:pointer-events-none",
            )}
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex items-start gap-3.5 px-5.5 pt-5 pr-12", className)}
      {...props}
    />
  );
}

/** Tinted glyph tile. Semantic, not decorative - it names the consequence. */
function DialogIcon({
  className,
  tone = "brand",
  ...props
}: React.ComponentProps<"span"> & { tone?: "brand" | "danger" | "warning" }) {
  const tones = {
    brand: "bg-brand-subtle text-brand",
    danger: "bg-status-red-subtle text-destructive",
    warning: "bg-status-amber-subtle text-status-amber",
  };
  return (
    <span
      data-slot="dialog-icon"
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-[11px] [&_svg]:size-5",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-[16.5px] font-bold tracking-tight", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground mt-1.5 text-[13px] leading-relaxed", className)}
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-body" className={cn("px-5.5 pt-4", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-wrap justify-end gap-2 px-5.5 pt-4.5 pb-5", className)}
      {...props}
    />
  );
}

export {
  Dialog, DialogTrigger, DialogPortal, DialogClose, DialogOverlay,
  DialogContent, DialogHeader, DialogIcon, DialogTitle, DialogDescription,
  DialogBody, DialogFooter,
};
