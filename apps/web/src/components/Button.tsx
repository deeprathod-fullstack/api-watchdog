import type { ButtonHTMLAttributes, Ref } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `subtle` and `subtle-danger` are text-weight actions for dense rows, where
   * a line of solid buttons would compete with the data it belongs to.
   */
  variant?: 'primary' | 'secondary' | 'danger' | 'subtle' | 'subtle-danger';
  /**
   * Forwarded to the underlying element, so a caller can move focus here —
   * a confirmation replacing the control that opened it, say. React 19 passes
   * `ref` as an ordinary prop, so no `forwardRef` wrapper is needed; it only
   * has to be declared.
   */
  ref?: Ref<HTMLButtonElement>;
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
