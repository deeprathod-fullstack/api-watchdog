import type { ReactNode } from 'react';

export interface PageProps {
  title: string;
  description?: ReactNode;
  /** Page-level controls, rendered beside the title. */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * The frame every screen sits in.
 *
 * It owns the single `<h1>` per page, which keeps the heading hierarchy
 * correct without each screen having to think about it.
 */
export function Page({ title, description, actions, children }: PageProps) {
  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{title}</h1>
          {description ? (
            <p className="page__description">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="page__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
