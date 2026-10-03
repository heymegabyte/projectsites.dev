import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { classNames } from '~/utils/classNames';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:ring-offset-1 focus-visible:ring-offset-bolt-elements-background-depth-1 disabled:pointer-events-none disabled:opacity-60 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        // Primary: cyan-tinted brand fill + accent text, glow on hover.
        default:
          'bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text border border-bolt-elements-item-contentAccent/40 hover:bg-bolt-elements-button-primary-backgroundHover hover:shadow-[0_0_16px_-4px_rgba(0,229,255,0.5)]',
        destructive:
          'bg-bolt-elements-button-danger-background text-bolt-elements-button-danger-text hover:bg-bolt-elements-button-danger-backgroundHover',
        outline:
          'border border-bolt-elements-borderColor bg-transparent hover:bg-bolt-elements-background-depth-2 hover:border-bolt-elements-borderColorActive hover:text-bolt-elements-textPrimary text-bolt-elements-textPrimary dark:border-bolt-elements-borderColorActive',
        secondary:
          'bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary border border-bolt-elements-borderColor hover:bg-bolt-elements-background-depth-3 hover:border-bolt-elements-borderColorActive',

        // Purple/secondary accent — brand secondary #7C3AED.
        purple:
          'bg-[rgba(124,58,237,0.16)] text-[#b794f6] border border-[rgba(124,58,237,0.5)] hover:bg-[rgba(124,58,237,0.28)] hover:shadow-[0_0_16px_-4px_rgba(124,58,237,0.55)]',
        ghost:
          'text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive hover:text-bolt-elements-item-contentAccent',
        link: 'text-bolt-elements-item-contentAccent underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  _asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, _asChild = false, ...props }, ref) => {
    return <button className={classNames(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
