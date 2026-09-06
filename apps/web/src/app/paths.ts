/**
 * Every route path in one place, so a rename is one edit and a typo in a
 * `<Link to=...>` is a type error rather than a dead link.
 */
export const paths = {
  dashboard: '/',
  monitors: '/monitors',
  monitorNew: '/monitors/new',
  monitorEdit: (id: string) => `/monitors/${id}/edit`,
  monitor: (id: string) => `/monitors/${id}`,
  monitorHistory: (id: string) => `/monitors/${id}/history`,
  login: '/login',
  register: '/register',
} as const;
