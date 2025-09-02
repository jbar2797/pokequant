import '../packages/ui/tokens.css';
import '../packages/ui/styles.css';
import type { Preview } from '@storybook/react';

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: 'hsl(var(--bg))' },
        { name: 'dark', value: '#0d1117' }
      ]
    },
    a11y: {
      element: '#root',
      config: {},
      options: { checks: { 'color-contrast': { options: { noScroll: true } } } }
    }
  }
};

export default preview;