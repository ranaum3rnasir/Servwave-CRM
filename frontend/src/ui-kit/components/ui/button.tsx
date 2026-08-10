import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap select-none",
    "rounded-md font-semibold cursor-pointer",
    "transition-[background-color,border-color,box-shadow,transform,color] duration-150",
    "active:translate-y-px",
    "disabled:pointer-events-none disabled:opacity-50",
    // icons inherit size and never swallow the click
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        // Solid ink-teal. Hover uses an explicit token, not opacity: fading a
        // dark fill toward a white page reads as disabled, not pressed.
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover hover:shadow-md",
        secondary:
          "bg-tonal text-tonal-foreground shadow-xs hover:bg-tonal-hover",
        outline:
          "border border-input bg-kit-card text-foreground shadow-xs hover:bg-muted hover:border-subtle-foreground",
        ghost:
          "text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive-hover hover:shadow-md",
        link:
          "text-brand underline-offset-4 hover:underline active:translate-y-0",
      },
      size: {
        sm: "h-8.5 px-3 text-[13px]",
        default: "h-10 px-4 text-[13.5px]",
        lg: "h-11.5 px-5 text-[15px]",
        icon: "size-10",
        "icon-sm": "size-8.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  /** Render as the child element (e.g. a Next.js <Link>) instead of a <button>. */
  asChild?: boolean;
  /** Swaps the leading icon for a spinner and disables the button. */
  isLoading?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  isLoading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || isLoading}
      // Tells assistive tech the control is working rather than broken.
      aria-busy={isLoading || undefined}
      {...props}
    >
      {isLoading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </Comp>
  );
}

export { Button, buttonVariants };
