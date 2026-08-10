import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-scrim/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/**
 * Max width. Measured over 66 real `DialogContent` call sites (component-api
 * -guard's own findComponentTags/classNameTokens algorithm, phase 8):
 * xs=max-w-sm (15 sites), sm=max-w-md (21), md=max-w-lg (17, today's
 * unstyled default - unmoved), lg=max-w-2xl (6). `md` is the default so a
 * call site naming no width keeps rendering exactly what it renders today.
 *
 * Named `width`, not `size`. Program plan section 2a rule 3: `size` is
 * reserved for control height (the 24-44px ladder Button/Input/SelectTrigger
 * share) and never means anything else on a primitive. A max-width scale is
 * a different axis wearing the same word - the exact mistake `modal.tsx`'s
 * own pre-vocabulary `size` prop made; `Modal` now exposes `width` too,
 * keeping `size` live only as a deprecated alias (see `modal.tsx`'s header).
 */
export type DialogWidth = "xs" | "sm" | "md" | "lg"

const DIALOG_WIDTH: Record<DialogWidth, string> = {
  xs: "max-w-sm",
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
}

/**
 * 4px-grid step - the same numeric scale Stack's `gap` and Card's `pad` /
 * `padX` / `padY` already ship (program-plan section 2a.8; see stack.tsx's
 * header note for why it is a number and not a size word). `pad={6}` is
 * 24px, `gap={4}` is 16px - both of those are DialogContent's own unstyled
 * defaults today.
 */
export type DialogSpacingStep = 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 12

const DIALOG_PAD: Record<DialogSpacingStep, string> = {
  0: "p-0",
  0.5: "p-0.5",
  1: "p-1",
  1.5: "p-1.5",
  2: "p-2",
  2.5: "p-2.5",
  3: "p-3",
  4: "p-4",
  5: "p-5",
  6: "p-6",
  8: "p-8",
  12: "p-12",
}

const DIALOG_GAP: Record<DialogSpacingStep, string> = {
  0: "gap-0",
  0.5: "gap-0.5",
  1: "gap-1",
  1.5: "gap-1.5",
  2: "gap-2",
  2.5: "gap-2.5",
  3: "gap-3",
  4: "gap-4",
  5: "gap-5",
  6: "gap-6",
  8: "gap-8",
  12: "gap-12",
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Override the overlay scrim — e.g. a lighter overlay for stacked/nested dialogs. */
    overlayClassName?: string
    /** Max width. Defaults to `md` (max-w-lg), today's unstyled geometry - unmoved. */
    width?: DialogWidth
    /** Uniform padding, 4px-grid step. Defaults to 6 (24px), today's unstyled `p-6`. */
    pad?: DialogSpacingStep
    /** Gap between direct children, 4px-grid step. Defaults to 4 (16px), today's unstyled `gap-4`. */
    gap?: DialogSpacingStep
  }
>(
  (
    { className, overlayClassName, width = "md", pad = 6, gap = 4, children, ...props },
    ref
  ) => (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // `width` / `gap` / `pad` are spliced in at the exact position each
          // class held in the pre-phase-8 base string rather than routed
          // through cva's variants (which always appends a variant's class
          // AFTER the base string - see button.tsx's ordering note). That
          // would change the byte order of every call site's rendered
          // string even at the all-default values, which is the one thing
          // this change may not do.
          "fixed left-[50%] top-[50%] z-50 grid w-full",
          DIALOG_WIDTH[width],
          // grid-cols-[minmax(0,1fr)]: an `auto` grid track is floored by its items'
          // min-content contribution and never shrinks below it, so a single nowrap child
          // (`truncate`, a long unbroken string) sizes the track past the max width and
          // paints outside the panel. minmax(0,1fr) lets the track shrink to the container
          // instead. Visually a no-op for content that already fits.
          "grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%]",
          DIALOG_GAP[gap],
          "border border-border bg-surface-light",
          DIALOG_PAD[pad],
          "shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-card",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded opacity-70 ring-offset-surface-light transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-background-light data-[state=open]:text-text-secondary">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
)
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  divider,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /** Hairline under the header, separating it from the scrollable body. */
  divider?: boolean
}) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      divider && "border-b border-border",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-text-secondary", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
