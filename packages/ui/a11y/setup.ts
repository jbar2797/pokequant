import { expect } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';
import '@testing-library/jest-dom';

expect.extend({ toHaveNoViolations } as any);
