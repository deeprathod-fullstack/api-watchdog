import 'express';

import type { PublicUser } from '../auth/service.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * The authenticated caller, set by `requireAuth`.
       *
       * Optional on purpose: TypeScript then forces every handler to prove it
       * ran behind the middleware instead of trusting a field that a route
       * registered without `requireAuth` would leave undefined.
       *
       * `user` is the record the middleware already loaded, so an endpoint that
       * needs the caller's own details does not query for them a second time.
       */
      auth?: { userId: string; email: string; user: PublicUser };
    }
  }
}
