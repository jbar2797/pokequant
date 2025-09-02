"use client";
import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 disabled:opacity-60 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-white hover:bg-brand/90',
        outline: 'border border-border bg-card hover:bg-brand/10',
        ghost: 'hover:bg-brand/10',
        danger: 'bg-danger text-white hover:bg-danger/90'
      },
      size: {
        sm: 'h-8 px-3 py-1',
        md: 'h-9 px-4 py-2',
        lg: 'h-10 px-5 py-2'
      }
    },
    defaultVariants: { variant: 'primary', size: 'md' }
  }
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button: React.FC<ButtonProps> = ({ className, variant, size, ...rest }) => (
  <button className={cn(buttonVariants({ variant, size }), className)} {...rest} />
);

export { buttonVariants };