import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-primary text-[var(--primary-foreground)] shadow-sm hover:shadow-[var(--glow)] active:opacity-95",
        destructive:
          "bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:bg-[var(--destructive)]/90",
        outline:
          "border-2 border-[var(--border)] bg-transparent text-[var(--foreground)] hover:border-[var(--primary)]/50 hover:bg-[var(--secondary)]",
        secondary:
          "bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[var(--secondary)]/80",
        ghost:
          "hover:bg-white/10 text-[var(--foreground)] hover:text-[var(--primary)]",
        link: "text-[var(--primary)] underline-offset-4 hover:underline rounded-none",
      },
      size: {
        default: "h-10 px-5 py-2 min-h-[44px] md:min-h-0",
        sm: "h-8 px-3 text-xs min-h-[44px] md:min-h-0",
        lg: "h-11 px-8 min-h-[44px] md:min-h-0",
        icon: "h-10 w-10 min-h-[44px] md:min-h-0 min-w-[44px] md:min-w-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
