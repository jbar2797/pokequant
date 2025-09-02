import React from 'react';
import { render } from '@testing-library/react';
import { TimeseriesChart } from '../components/TimeseriesChart';
import { axe } from 'jest-axe';

describe('TimeseriesChart a11y', () => {
  it('has no a11y violations (fallback table reduced motion)', async () => {
    const data = Array.from({length:10}).map((_,i)=>({ t: 1700000000 + i*86400, price: 10+i }));
    const { container } = render(<TimeseriesChart data={data} reducedMotion />);
    const results = await axe(container);
    if (results.violations.length) {
      const formatted = results.violations.map(v=>`${v.id}: ${v.nodes.length} nodes`).join('\n');
      throw new Error('A11y violations:\n'+formatted);
    }
  });
});
