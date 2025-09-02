import type { StorybookConfig } from '@storybook/react';
const config: StorybookConfig = {
  stories: ['../packages/ui/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials', '@storybook/addon-a11y'],
  framework: {
    name: '@storybook/react',
    options: {}
  },
  typescript: { reactDocgen: 'react-docgen-typescript' }
};
export default config;