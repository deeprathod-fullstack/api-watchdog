import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library does not unmount between tests on its own outside of
// its own globals setup; a leaked tree makes the next test's queries ambiguous.
afterEach(() => {
  cleanup();
});
