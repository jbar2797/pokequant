// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignalBadge } from './SignalBadge';

describe('SignalBadge', () => {
  it('renders signal text', () => {
    render(<SignalBadge signal="buy" />);
  expect(screen.getByText(/Buy/).textContent).toMatch(/Buy/);
  });
  // Axe test deferred until jsdom environment isolated from worker runtime.
});