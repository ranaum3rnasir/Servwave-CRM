"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/ui-kit/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from "@/ui-kit/components/ui/dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Name the exact record and what is lost. "Are you sure?" tells nobody anything. */
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Held true while the action is in flight; both buttons lock. */
  isPending?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
}

/**
 * Destructive confirmation, wrapped so a delete is one call site instead of
 * fifteen lines of Dialog parts repeated across the app.
 *
 *   const remove = useDisclosure();
 *   <ConfirmDialog {...remove.props} destructive
 *     title="Delete this job?"
 *     description={`${job.no} for ${job.customer} will be permanently removed.`}
 *     isPending={mutation.isPending}
 *     onConfirm={() => mutation.mutate(job.id)} />
 */
function ConfirmDialog({
  open, onOpenChange, title, description,
  confirmLabel = "Confirm", cancelLabel = "Cancel",
  isPending = false, destructive = false, onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      // Don't let a stray Escape or backdrop click abandon an in-flight action.
      onOpenChange={(next) => { if (!isPending) onOpenChange(next); }}
    >
      <DialogContent showClose={!isPending}>
        <DialogHeader>
          <DialogIcon tone={destructive ? "danger" : "brand"}>
            <AlertTriangle />
          </DialogIcon>
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            isLoading={isPending}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ConfirmDialog };
