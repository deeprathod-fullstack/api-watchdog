import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
}

/**
 * A real `<button>`, always.
 *
 * Exists so that keyboard behaviour, focus styling and the disabled state are
 * decided once. Anything that navigates is a `<Link>`, not this.
 */
export function Button({
  variant = 'primary',
  type = 'button',
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={['button', `button--${variant}`, className]
        .filter(Boolean)
        .join(' ')}
    />
  );
}
